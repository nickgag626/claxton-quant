import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { tradierApi, calculatePortfolioGreeks, parseOptionSymbol } from '@/services/tradierApi';
import { strategyEngine } from '@/services/strategyEngine';
import { tradeJournal, TradeRecord } from '@/services/tradeJournal';
import { settingsService } from '@/services/settingsService';
import type {
  Position, 
  Greeks, 
  Quote, 
  Strategy, 
  RiskStatus, 
  ActivityEvent,
  MarketState,
  TradeSafeguards 
} from '@/types/trading';
import { DTBP_REJECTION_PATTERNS } from '@/types/trading';
import type { DeltaDataPoint } from '@/components/dashboard/GreeksChart';

// Check if a rejection reason indicates DTBP/margin issues
function isDtbpRejection(reason: string | undefined): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return DTBP_REJECTION_PATTERNS.some(pattern => lower.includes(pattern));
}

// ============================================================================
// STABILITY_MODE: When true, uses split polling cadences + visibility gating
// Default to true for safer production behavior
// ============================================================================
const STABILITY_MODE = import.meta.env.VITE_STABILITY_MODE !== 'false';

// Polling intervals (in milliseconds)
const FAST_POLL_INTERVAL = 5_000;      // 5s for clock + quotes
const SLOW_POLL_INTERVAL = 30_000;     // 30s for positions + balances + chains
const HIDDEN_POLL_INTERVAL = 120_000;  // 2min when tab is hidden
const CLOSED_POLL_INTERVAL = 60_000;   // 1min when market closed
const BACKOFF_MAX_INTERVAL = 120_000;  // 2min max backoff

// Heuristic grouping window: positions opened within this many minutes are considered same group
const HEURISTIC_GROUP_TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Extract underlying symbol from OCC option symbol
 * e.g., SPY260112P00693000 -> SPY
 */
function extractUnderlyingFromSymbol(symbol: string): string {
  const match = symbol.match(/^([A-Z]+)\d/);
  return match ? match[1] : symbol;
}

/**
 * Generate a heuristic group key for a position based on:
 * - underlying symbol
 * - expiration date
 * - entry time window (rounded to 5-min bucket)
 */
function generateHeuristicGroupKey(pos: Position): string {
  const parsed = parseOptionSymbol(pos.symbol);
  if (!parsed) return `ungrouped-${pos.symbol}`;
  
  const underlying = parsed.underlying;
  const expiration = parsed.expiration;
  
  // Round entry time to 5-minute bucket
  const entryTime = pos.entryTime instanceof Date ? pos.entryTime : new Date(pos.entryTime);
  const timeBucket = Math.floor(entryTime.getTime() / HEURISTIC_GROUP_TIME_WINDOW_MS);
  
  return `heuristic-${underlying}-${expiration}-${timeBucket}`;
}

/**
 * Apply trade_group_id from database trades to broker positions
 * Falls back to heuristic grouping if no DB match found
 */
async function enrichPositionsWithGroupIds(positions: Position[]): Promise<Position[]> {
  if (positions.length === 0) return positions;

  // First, try to match positions to open trades in DB by symbol
  const symbols = positions.map(p => p.symbol);
  
  try {
    // Query trades that are still open (close_status is null or 'submitted')
    // and have trade_group_id populated
    const { data: trades, error } = await supabase
      .from('trades')
      .select('symbol, trade_group_id')
      .in('symbol', symbols)
      .not('trade_group_id', 'is', null);

    if (error) {
      console.error('Error fetching trade groups:', error);
    }

    // Build symbol -> trade_group_id map from DB
    const symbolToGroupId = new Map<string, string>();
    if (trades) {
      trades.forEach((t: { symbol: string; trade_group_id: string | null }) => {
        if (t.trade_group_id) {
          symbolToGroupId.set(t.symbol, t.trade_group_id);
        }
      });
    }

    // Apply DB-based group IDs first
    const enrichedPositions = positions.map(pos => {
      const dbGroupId = symbolToGroupId.get(pos.symbol);
      if (dbGroupId) {
        return { ...pos, tradeGroupId: dbGroupId };
      }
      return pos;
    });

    // For positions without DB group ID, apply heuristic grouping
    // Group positions by heuristic key
    const heuristicGroups = new Map<string, Position[]>();
    
    enrichedPositions.forEach(pos => {
      if (!pos.tradeGroupId) {
        const key = generateHeuristicGroupKey(pos);
        const existing = heuristicGroups.get(key) || [];
        heuristicGroups.set(key, [...existing, pos]);
      }
    });

    // Assign heuristic group IDs only to groups with 2+ positions
    const heuristicGroupIds = new Map<string, string>();
    heuristicGroups.forEach((groupPositions, key) => {
      if (groupPositions.length >= 2) {
        // Generate a stable group ID from the key
        heuristicGroupIds.set(key, `hg-${key}`);
      }
    });

    // Apply heuristic group IDs
    return enrichedPositions.map(pos => {
      if (pos.tradeGroupId) return pos; // Already has DB group ID
      
      const heuristicKey = generateHeuristicGroupKey(pos);
      const heuristicGroupId = heuristicGroupIds.get(heuristicKey);
      
      if (heuristicGroupId) {
        return { ...pos, tradeGroupId: heuristicGroupId };
      }
      
      return pos;
    });
  } catch (err) {
    console.error('Error enriching positions with group IDs:', err);
    return positions;
  }
}

// Default strategies (would come from database in production)
const defaultStrategies: Strategy[] = [
  {
    id: '1',
    name: '0DTE Iron Condor (SPX)',
    type: 'iron_condor',
    underlying: 'SPX',
    enabled: true,
    maxPositions: 2,
    positionSize: 1,
    entryConditions: {
      minDte: 0,
      maxDte: 0,
      shortDeltaTarget: 0.10,
      longDeltaTarget: 0.05,
      minPremium: 1.50,
      marketHoursOnly: true,
      startTime: '09:45',
      endTime: '14:30',
    },
    exitConditions: {
      profitTargetPercent: 50,
      stopLossPercent: 100,
      timeStopTime: '15:45',
    },
    sizing: { mode: 'fixed', fixedContracts: 1 },
  },
  {
    id: '2',
    name: 'Weekly Iron Condor (SPY)',
    type: 'iron_condor',
    underlying: 'SPY',
    enabled: true,
    maxPositions: 1,
    positionSize: 2,
    entryConditions: {
      minDte: 5,
      maxDte: 7,
      shortDeltaTarget: 0.16,
      longDeltaTarget: 0.08,
      marketHoursOnly: true,
    },
    exitConditions: {
      profitTargetPercent: 50,
      stopLossPercent: 200,
    },
    sizing: { mode: 'fixed', fixedContracts: 2 },
  },
  {
    id: '3',
    name: '30 DTE Credit Put (SPY)',
    type: 'credit_put_spread',
    underlying: 'SPY',
    enabled: false,
    maxPositions: 1,
    positionSize: 5,
    entryConditions: {
      minDte: 28,
      maxDte: 35,
      shortDeltaTarget: 0.30,
      longDeltaTarget: 0.15,
      minIvRank: 25,
      marketHoursOnly: true,
    },
    exitConditions: {
      profitTargetPercent: 50,
      stopLossPercent: 200,
      timeStopDte: 7,
    },
    sizing: { mode: 'fixed', fixedContracts: 5 },
  },
];

export const useTradingData = () => {
  const [positions, setPositions] = useState<Position[]>([]);
  const [greeks, setGreeks] = useState<Greeks>({ delta: 0, gamma: 0, theta: 0, vega: 0 });
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [riskStatus, setRiskStatus] = useState<RiskStatus>({
    dailyPnl: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    maxDailyLoss: 1000,
    tradeCount: 0,
    maxPositions: 5,
    killSwitchActive: false,
  });
  const [safeguards, setSafeguards] = useState<TradeSafeguards>({
    maxBidAskSpreadPercent: 5,
    zeroDteCloseBufferMinutes: 30,
    fillPriceBufferPercent: 2,
  });
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [marketState, setMarketState] = useState<MarketState>('unknown');
  const [isApiConnected, setIsApiConnected] = useState(false);
  const [isBotRunning, setIsBotRunning] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deltaHistory, setDeltaHistory] = useState<DeltaDataPoint[]>([]);
  const [pnlHistory, setPnlHistory] = useState<{ time: string; pnl: number }[]>([]);
  const [strategyPositions, setStrategyPositions] = useState<
    Map<string, { strategyName: string; underlying: string; entryCredit: number; entryTime: Date }>
  >(new Map());

  // Close controls + debug
  const [closeDebugOptions, setCloseDebugOptions] = useState<{ dryRun: boolean; debug: boolean }>({
    dryRun: false,
    debug: false,
  });
  const [lastCloseDebug, setLastCloseDebug] = useState<any>(null);
  const [pendingCloseSymbols, setPendingCloseSymbols] = useState<Set<string>>(new Set());

  // === GROUP-AWARE CLOSING: Leg Out Mode ===
  // When OFF (default), single-leg closes on grouped positions are blocked
  // When ON, user can close individual legs (with DTBP risk warning)
  const [legOutModeEnabled, setLegOutModeEnabled] = useState(false);

  // Track rejected closes that might benefit from group-close retry
  const [dtbpRejection, setDtbpRejection] = useState<{
    symbol: string;
    tradeGroupId: string;
    rejectReason: string;
    timestamp: number;
  } | null>(null);

  // === ALL useRef DECLARATIONS (grouped together for hook order stability) ===
  const pendingCloseSymbolsRef = useRef<Set<string>>(new Set());
  const lastEngineRun = useRef<number>(0);
  const lastCloseAttempt = useRef<Map<string, number>>(new Map());
  const fastLoopInFlight = useRef(false);
  const slowLoopInFlight = useRef(false);
  const backoffMultiplier = useRef(1);
  const lastSlowFetch = useRef(0);
  const marketStateRef = useRef<MarketState>('unknown');
  const isPageVisible = useRef(true);

  // === ALL useCallback DECLARATIONS START HERE ===
  const addActivity = useCallback((type: ActivityEvent['type'], message: string) => {
    setActivity(prev => [
      {
        id: Date.now().toString(),
        timestamp: new Date(),
        type,
        message,
      },
      ...prev.slice(0, 19),
    ]);
  }, []);

  // === FAST LOOP: Clock + Quotes only ===
  const fetchFastData = useCallback(async () => {
    if (fastLoopInFlight.current) return;
    fastLoopInFlight.current = true;

    try {
      // Fetch quotes for SPY and QQQ
      const quotesData = await tradierApi.getQuotes(['SPY', 'QQQ']);
      setQuotes(quotesData);

      // Fetch market clock
      const clock = await tradierApi.getMarketClock();
      setMarketState(clock.state);
      marketStateRef.current = clock.state;

      setIsApiConnected(true);
      setError(null);
      setLastUpdate(new Date());
      
      // Reset backoff on success
      backoffMultiplier.current = 1;
    } catch (err) {
      console.error('Error in fast fetch:', err);
      // Apply backoff on error (for 429/5xx)
      backoffMultiplier.current = Math.min(backoffMultiplier.current * 2, BACKOFF_MAX_INTERVAL / FAST_POLL_INTERVAL);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      setIsApiConnected(false);
    } finally {
      fastLoopInFlight.current = false;
    }
  }, []);

  // === SLOW LOOP: Positions + Balances + Chains/Greeks ===
  const fetchSlowData = useCallback(async (forceChains = false) => {
    if (slowLoopInFlight.current) return;
    slowLoopInFlight.current = true;

    try {
      // Fetch positions and enrich with strategy info
      const positionsData = await tradierApi.getPositions();

      // === CRITICAL: Enrich positions with trade_group_id ===
      // First from DB trades, then fallback to heuristic grouping
      const positionsWithGroups = await enrichPositionsWithGroupIds(positionsData);

      // Use ref for current pendingCloseSymbols to avoid stale closure
      const currentPendingClose = pendingCloseSymbolsRef.current;

      // Reconcile pending_close set: remove symbols that no longer exist at broker
      const brokerSymbols = new Set(positionsWithGroups.map(p => p.symbol));
      setPendingCloseSymbols(prev => {
        const next = new Set<string>();
        prev.forEach(sym => {
          if (brokerSymbols.has(sym)) next.add(sym);
        });
        return next;
      });

      // Enrich positions with strategy info + pending_close state
      const enrichedPositions = positionsWithGroups.map(pos => {
        const stratInfo = strategyPositions.get(pos.symbol);
        const isPending = currentPendingClose.has(pos.symbol);

        const base = {
          ...pos,
          status: (isPending ? 'pending_close' : 'open') as Position['status'],
        };

        if (stratInfo) {
          return {
            ...base,
            strategyName: stratInfo.strategyName,
            underlying: stratInfo.underlying,
            entryCredit: stratInfo.entryCredit,
          };
        }

        return base;
      });
      setPositions(enrichedPositions);

      // Fetch unrealized P&L from broker (current positions)
      const balances = await tradierApi.getBalances();
      const unrealizedPnl = balances?.open_pl || 0;

      // Fetch realized P&L from trade journal (finalized trades today in America/New_York)
      const { realized: realizedPnl, tradeCount } = await tradeJournal.getRealizedTodayPnl();

      // Total daily P&L = realized (from DB) + unrealized (from broker)
      const totalDailyPnl = realizedPnl + unrealizedPnl;

      setRiskStatus(prev => ({
        ...prev,
        dailyPnl: totalDailyPnl,
        realizedPnl,
        unrealizedPnl,
        tradeCount,
      }));

      // Track P&L history (max 100 points for the day)
      const now = new Date();
      const timeLabel = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
      setPnlHistory(prev => {
        const newPoint = { time: timeLabel, pnl: totalDailyPnl };
        if (prev.length > 0 && prev[prev.length - 1].time === timeLabel) {
          return [...prev.slice(0, -1), newPoint];
        }
        return [...prev.slice(-99), newPoint];
      });

      // Calculate Greeks from option positions
      // Only fetch chains if market is open OR forceChains is true
      const shouldFetchChains = forceChains || marketStateRef.current === 'open';
      
      if (positionsData.length > 0 && shouldFetchChains) {
        const optionPositions = positionsData
          .map(p => ({ position: p, parsed: parseOptionSymbol(p.symbol) }))
          .filter(item => item.parsed !== null);

        if (optionPositions.length > 0) {
          const chainRequests = new Map<string, Set<string>>();
          optionPositions.forEach(({ parsed }) => {
            if (!parsed) return;
            if (!chainRequests.has(parsed.underlying)) {
              chainRequests.set(parsed.underlying, new Set());
            }
            chainRequests.get(parsed.underlying)!.add(parsed.expiration);
          });

          let allOptionData: any[] = [];

          for (const [underlying, expirations] of chainRequests) {
            for (const expiration of expirations) {
              try {
                const chain = await tradierApi.getOptionChain(underlying, expiration);
                allOptionData = [...allOptionData, ...chain];
              } catch (err) {
                console.error(`Error fetching chain for ${underlying} ${expiration}:`, err);
              }
            }
          }

          const portfolioGreeks = calculatePortfolioGreeks(positionsData, allOptionData);
          setGreeks(portfolioGreeks);

          const timeLabel2 = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
          setDeltaHistory(prev => {
            const newPoint = { time: timeLabel2, delta: portfolioGreeks.delta };
            if (prev.length > 0 && prev[prev.length - 1].time === timeLabel2) {
              return [...prev.slice(0, -1), newPoint];
            }
            return [...prev.slice(-49), newPoint];
          });
        }
      }

      setIsApiConnected(true);
      setError(null);
      setLastUpdate(new Date());
      lastSlowFetch.current = Date.now();
      
      // Reset backoff on success
      backoffMultiplier.current = 1;
    } catch (err) {
      console.error('Error in slow fetch:', err);
      backoffMultiplier.current = Math.min(backoffMultiplier.current * 2, BACKOFF_MAX_INTERVAL / SLOW_POLL_INTERVAL);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      setIsApiConnected(false);
    } finally {
      slowLoopInFlight.current = false;
      setIsLoading(false);
    }
  }, [strategyPositions]);

  // === LEGACY FETCH (for STABILITY_MODE=false backward compatibility) ===
  const fetchDataLegacy = useCallback(async () => {
    try {
      const quotesData = await tradierApi.getQuotes(['SPY', 'QQQ']);
      setQuotes(quotesData);

      const positionsData = await tradierApi.getPositions();
      
      // === CRITICAL: Enrich positions with trade_group_id ===
      const positionsWithGroups = await enrichPositionsWithGroupIds(positionsData);

      const brokerSymbols = new Set(positionsWithGroups.map(p => p.symbol));
      setPendingCloseSymbols(prev => {
        const next = new Set<string>();
        prev.forEach(sym => {
          if (brokerSymbols.has(sym)) next.add(sym);
        });
        return next;
      });

      const enrichedPositions = positionsWithGroups.map(pos => {
        const stratInfo = strategyPositions.get(pos.symbol);
        const isPending = pendingCloseSymbols.has(pos.symbol);
        const base = {
          ...pos,
          status: (isPending ? 'pending_close' : 'open') as Position['status'],
        };
        if (stratInfo) {
          return {
            ...base,
            strategyName: stratInfo.strategyName,
            underlying: stratInfo.underlying,
            entryCredit: stratInfo.entryCredit,
          };
        }
        return base;
      });
      setPositions(enrichedPositions);

      const balances = await tradierApi.getBalances();
      const unrealizedPnl = balances?.open_pl || 0;
      const { realized: realizedPnl, tradeCount } = await tradeJournal.getRealizedTodayPnl();
      const totalDailyPnl = realizedPnl + unrealizedPnl;

      setRiskStatus(prev => ({
        ...prev,
        dailyPnl: totalDailyPnl,
        realizedPnl,
        unrealizedPnl,
        tradeCount,
      }));

      const now = new Date();
      const timeLabel = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
      setPnlHistory(prev => {
        const newPoint = { time: timeLabel, pnl: totalDailyPnl };
        if (prev.length > 0 && prev[prev.length - 1].time === timeLabel) {
          return [...prev.slice(0, -1), newPoint];
        }
        return [...prev.slice(-99), newPoint];
      });

      const clock = await tradierApi.getMarketClock();
      setMarketState(clock.state);

      if (positionsData.length > 0) {
        const optionPositions = positionsData
          .map(p => ({ position: p, parsed: parseOptionSymbol(p.symbol) }))
          .filter(item => item.parsed !== null);

        if (optionPositions.length > 0) {
          const chainRequests = new Map<string, Set<string>>();
          optionPositions.forEach(({ parsed }) => {
            if (!parsed) return;
            if (!chainRequests.has(parsed.underlying)) {
              chainRequests.set(parsed.underlying, new Set());
            }
            chainRequests.get(parsed.underlying)!.add(parsed.expiration);
          });

          let allOptionData: any[] = [];

          for (const [underlying, expirations] of chainRequests) {
            for (const expiration of expirations) {
              try {
                const chain = await tradierApi.getOptionChain(underlying, expiration);
                allOptionData = [...allOptionData, ...chain];
              } catch (err) {
                console.error(`Error fetching chain for ${underlying} ${expiration}:`, err);
              }
            }
          }

          const portfolioGreeks = calculatePortfolioGreeks(positionsData, allOptionData);
          setGreeks(portfolioGreeks);

          setDeltaHistory(prev => {
            const newPoint = { time: timeLabel, delta: portfolioGreeks.delta };
            if (prev.length > 0 && prev[prev.length - 1].time === timeLabel) {
              return [...prev.slice(0, -1), newPoint];
            }
            return [...prev.slice(-49), newPoint];
          });
        }
      }

      setIsApiConnected(true);
      setError(null);
      setLastUpdate(new Date());
    } catch (err) {
      console.error('Error fetching trading data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      setIsApiConnected(false);
    } finally {
      setIsLoading(false);
    }
  }, [strategyPositions, pendingCloseSymbols]);

  // Unified fetch for manual refresh / post-trade
  const fetchData = useCallback(async () => {
    if (STABILITY_MODE) {
      await Promise.all([fetchFastData(), fetchSlowData(true)]);
    } else {
      await fetchDataLegacy();
    }
  }, [fetchFastData, fetchSlowData, fetchDataLegacy]);

  const toggleBot = useCallback(() => {
    const newState = !isBotRunning;
    setIsBotRunning(newState);
    addActivity('BOT', newState ? 'Bot started by user' : 'Bot stopped by user');
  }, [isBotRunning, addActivity]);

  const toggleKillSwitch = useCallback(() => {
    const newStatus = !riskStatus.killSwitchActive;
    setRiskStatus(prev => ({
      ...prev,
      killSwitchActive: newStatus,
      killSwitchReason: newStatus ? 'Manual activation from UI' : undefined,
    }));
    addActivity('RISK', newStatus ? 'Kill switch activated manually' : 'Kill switch deactivated');
    if (newStatus) setIsBotRunning(false);
  }, [riskStatus.killSwitchActive, addActivity]);

  const updateRiskSettings = useCallback(async (settings: { maxDailyLoss: number; maxPositions: number }) => {
    setRiskStatus(prev => ({
      ...prev,
      maxDailyLoss: settings.maxDailyLoss,
      maxPositions: settings.maxPositions,
    }));
    addActivity('RISK', `Risk settings updated: Max Loss $${settings.maxDailyLoss}, Max Positions ${settings.maxPositions}`);
    await settingsService.updateRiskSettings(settings.maxDailyLoss, settings.maxPositions);
  }, [addActivity]);

  const updateSafeguards = useCallback(async (newSafeguards: TradeSafeguards) => {
    setSafeguards(newSafeguards);
    addActivity('RISK', `Safeguards updated: Spread ${newSafeguards.maxBidAskSpreadPercent}%, Close Buffer ${newSafeguards.zeroDteCloseBufferMinutes}min, Fill Buffer ${newSafeguards.fillPriceBufferPercent}%`);
    await settingsService.updateSafeguards(newSafeguards);
  }, [addActivity]);

  const toggleStrategy = useCallback(async (strategyId: string) => {
    const strategy = strategies.find(s => s.id === strategyId);
    if (!strategy) return;

    const newEnabled = !strategy.enabled;
    setStrategies(prev => prev.map(s =>
      s.id === strategyId ? { ...s, enabled: newEnabled } : s
    ));
    await settingsService.updateStrategyEnabled(strategyId, newEnabled);
  }, [strategies]);

  const addStrategy = useCallback(async (strategy: Omit<Strategy, 'id'>) => {
    const savedStrategy = await settingsService.addStrategy(strategy);

    if (savedStrategy) {
      setStrategies(prev => [...prev, savedStrategy]);
      addActivity('SYSTEM', `Strategy "${strategy.name}" created`);
    } else {
      const newStrategy: Strategy = {
        ...strategy,
        id: Date.now().toString(),
      };
      setStrategies(prev => [...prev, newStrategy]);
      addActivity('SYSTEM', `Strategy "${strategy.name}" created (local only)`);
    }
  }, [addActivity]);

  const deleteStrategy = useCallback(async (strategyId: string) => {
    const strategy = strategies.find(s => s.id === strategyId);
    if (strategy) {
      addActivity('SYSTEM', `Strategy "${strategy.name}" deleted`);
    }
    setStrategies(prev => prev.filter(s => s.id !== strategyId));
    await settingsService.deleteStrategy(strategyId);
  }, [strategies, addActivity]);

  /**
   * Journal a closed trade - CORRECT FLOW:
   * 1. Save as 'submitted' with pnl=NULL, exit_price=NULL (no guessing)
   * 2. Immediately poll Tradier for order status
   * 3. If filled: update with real fill price and compute P&L
   * 4. If rejected/canceled/expired: mark terminal status
   */
  const journalClosedTrade = useCallback(async (
    position: Position,
    closeResult: {
      orderId?: string;
      closeSide?: string;
      closeQty?: number;
      positionDetails?: {
        symbol: string;
        quantity: number;
        costBasis: number;
        side?: string;
      };
    },
    exitReason: string,
    source: string,
    clientRequestId: string
  ) => {
    if (!closeResult.orderId) {
      console.error('journalClosedTrade: No orderId provided, cannot journal');
      return;
    }

    try {
      const stratInfo = strategyPositions.get(position.symbol);
      const underlying = extractUnderlyingFromSymbol(position.symbol);

      // Determine open side from position data
      const positionSide = closeResult.positionDetails?.side;
      let openSide: string | undefined;
      if (positionSide === 'short') {
        openSide = 'sell_to_open';
      } else if (positionSide === 'long') {
        openSide = 'buy_to_open';
      } else if (position.costBasis < 0) {
        openSide = 'sell_to_open';
      } else if (position.costBasis > 0) {
        openSide = 'buy_to_open';
      }

      const quantity = closeResult.closeQty || position.quantity;
      const multiplier = 100;
      const entryPrice = Math.abs(position.costBasis) / (quantity * multiplier);
      const now = new Date().toISOString();

      // STEP 1: Save trade as 'submitted' with NULL pnl/exit_price
      // Tradier 'ok' status != filled - order may still be rejected
      const tradeRecord: Omit<TradeRecord, 'id'> = {
        symbol: position.symbol,
        underlying,
        strategy_name: stratInfo?.strategyName || position.strategyName,
        strategy_type: position.strategyType,
        quantity,
        entry_time: stratInfo?.entryTime?.toISOString() || position.entryTime?.toISOString() || now,
        exit_time: undefined, // Set when filled
        entry_price: entryPrice,
        exit_price: undefined, // Set when filled from Tradier avg_fill_price
        entry_credit: stratInfo?.entryCredit,
        pnl: null, // NEVER guess - wait for fill confirmation
        pnl_percent: null,
        pnl_formula: undefined,
        exit_reason: exitReason,
        trade_group_id: position.tradeGroupId,
        open_side: openSide,
        close_side: closeResult.closeSide,
        close_order_id: closeResult.orderId,
        multiplier,
        fees: 0,
        needs_reconcile: true, // Always true until Tradier confirms fill
        close_status: 'submitted',
        close_submitted_at: now,
        close_filled_at: undefined,
        close_filled_qty: undefined,
        close_avg_fill_price: undefined,
      };

      const saveResult = await tradeJournal.saveTrade(tradeRecord);

      if (saveResult.duplicate) {
        console.log('[journalClosedTrade] Duplicate (already exists):', position.symbol, closeResult.orderId);
        return;
      }
      
      if (!saveResult.success) {
        console.error('[journalClosedTrade] Failed to save submitted trade:', saveResult.error);
        return;
      }

      console.log('[journalClosedTrade] Saved as submitted:', position.symbol, closeResult.orderId);

      // STEP 2: Immediately check order status with Tradier
      // Small delay to allow order to process
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const orderStatus = await tradierApi.getOrderStatus(closeResult.orderId);
      console.log('[journalClosedTrade] Order status:', closeResult.orderId, orderStatus);

      if (!orderStatus.success) {
        console.warn('[journalClosedTrade] Could not fetch order status, will retry later:', orderStatus.error);
        return;
      }

      // STEP 3: Update trade based on order status
      const updateResult = await tradeJournal.updateCloseStatus(
        closeResult.orderId,
        orderStatus.closeStatus,
        {
          avgFillPrice: orderStatus.avgFillPrice,
          filledQty: orderStatus.filledQty,
          rejectReason: orderStatus.rejectReason,
          open_side: openSide,
          fees: 0,
        }
      );

      if (updateResult.success) {
        console.log('[journalClosedTrade] Updated to', orderStatus.closeStatus, ':', position.symbol);
        
        if (orderStatus.closeStatus === 'filled') {
          addActivity('TRADE', `Trade filled: ${position.symbol} @ $${orderStatus.avgFillPrice?.toFixed(2) || '?'}`);
        } else if (orderStatus.closeStatus === 'rejected' || orderStatus.closeStatus === 'canceled' || orderStatus.closeStatus === 'expired') {
          addActivity('RISK', `Close ${orderStatus.closeStatus}: ${position.symbol} - ${orderStatus.rejectReason || 'Unknown reason'}`);
        }
      } else {
        console.error('[journalClosedTrade] Failed to update close status:', updateResult.error);
      }
    } catch (error) {
      console.error('[journalClosedTrade] Error:', error);
    }
  }, [strategyPositions, addActivity]);

  // Get all positions that belong to the same trade group
  const getGroupPositions = useCallback((tradeGroupId: string | undefined): Position[] => {
    if (!tradeGroupId) return [];
    return positions.filter(p => p.tradeGroupId === tradeGroupId);
  }, [positions]);

  // Check if a position is part of a multi-leg group
  const isGroupedPosition = useCallback((position: Position): boolean => {
    if (!position.tradeGroupId) return false;
    const groupPositions = getGroupPositions(position.tradeGroupId);
    return groupPositions.length > 1;
  }, [getGroupPositions]);

  /**
   * Close a single position (single-leg)
   * IMPORTANT: For grouped positions, this will be blocked unless legOutModeEnabled is true
   */
  const closePosition = useCallback(async (
    positionId: string,
    exitReason: string = 'manual',
    options?: { forceLegOut?: boolean }
  ): Promise<boolean> => {
    const position = positions.find(p => p.id === positionId);
    if (!position) return false;

    // === GROUP-AWARE CLOSE PRECHECK ===
    // Block single-leg closes on grouped positions unless Leg Out Mode is enabled
    if (isGroupedPosition(position) && !legOutModeEnabled && !options?.forceLegOut) {
      const groupPositions = getGroupPositions(position.tradeGroupId);
      addActivity('RISK', 
        `BLOCKED: Cannot close single leg of ${groupPositions.length}-leg group. ` +
        `Enable "Leg Out Mode" or use "Close Group".`
      );
      return false;
    }

    // Use ref to get current value (avoids stale closure)
    if (pendingCloseSymbolsRef.current.has(position.symbol)) {
      addActivity('SYSTEM', `SKIP: already pending close: ${position.symbol}`);
      return false;
    }

    const clientRequestId = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    console.log('CLOSE_REQUEST', { source: 'manual_ui', clientRequestId, symbol: position.symbol, legOutMode: legOutModeEnabled });

    addActivity('TRADE', `Closing position: ${position.symbol}${legOutModeEnabled && isGroupedPosition(position) ? ' (LEG OUT)' : ''}`);

    const result = await tradierApi.closePosition(position.symbol, position.quantity, {
      dryRun: closeDebugOptions.dryRun,
      debug: closeDebugOptions.debug,
      clientRequestId,
      trade_group_id: position.tradeGroupId,
      source: 'manual_ui',
    });

    setLastCloseDebug({
      source: 'manual_ui',
      clientRequestId,
      symbol: position.symbol,
      result,
      edgeDebug: result.debug,
    });

    if (result.skipped) {
      addActivity('SYSTEM', `${result.error || 'SKIP: cooldown/lock'}`);
      return false;
    }

    if (result.success && !result.dryRun) {
      setPendingCloseSymbols(prev => new Set(prev).add(position.symbol));
      addActivity('TRADE', `Close order accepted: ${position.symbol} (Order #${result.orderId})`);
      await journalClosedTrade(position, result, exitReason, 'manual_ui', clientRequestId);
      await fetchData();
      return true;
    }

    if (result.success && result.dryRun) {
      addActivity('SYSTEM', `Dry run computed for ${position.symbol} (no order sent)`);
      return true;
    }

    // === DTBP REJECTION DETECTION ===
    // If rejected with margin/DTBP-related reason and this is a grouped position, offer retry
    if (!result.success && result.error && position.tradeGroupId) {
      if (isDtbpRejection(result.error)) {
        setDtbpRejection({
          symbol: position.symbol,
          tradeGroupId: position.tradeGroupId,
          rejectReason: result.error,
          timestamp: Date.now(),
        });
        addActivity('RISK', 
          `DTBP/Margin rejection for ${position.symbol}: ${result.error}. ` +
          `Use "Close Group" to avoid naked exposure.`
        );
        return false;
      }
    }

    addActivity('RISK', `Failed to close ${position.symbol}: ${result.error}`);
    return false;
  }, [positions, addActivity, fetchData, closeDebugOptions, journalClosedTrade, legOutModeEnabled, isGroupedPosition, getGroupPositions]);

  /**
   * Close all positions in a trade group as a single operation
   * This is the SAFE way to close multi-leg strategies (avoids DTBP issues)
   */
  const closeGroup = useCallback(async (tradeGroupId: string, exitReason: string = 'manual'): Promise<boolean> => {
    const groupPositions = getGroupPositions(tradeGroupId);
    if (groupPositions.length === 0) {
      addActivity('SYSTEM', `No positions found for group ${tradeGroupId}`);
      return false;
    }

    addActivity('TRADE', `Closing ${groupPositions.length}-leg group: ${groupPositions.map(p => p.symbol).join(', ')}`);

    // Mark all positions as pending close
    setPendingCloseSymbols(prev => {
      const next = new Set(prev);
      groupPositions.forEach(p => next.add(p.symbol));
      return next;
    });

    // Close each position in the group
    // TODO: In future, this could be a single multi-leg order via Tradier's combo/spread API
    // For now, we close them rapidly in sequence to minimize gap
    let allSuccess = true;
    const clientRequestId = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    for (const position of groupPositions) {
      if (pendingCloseSymbolsRef.current.has(position.symbol)) {
        continue; // Already pending from another request
      }

      const result = await tradierApi.closePosition(position.symbol, position.quantity, {
        dryRun: closeDebugOptions.dryRun,
        debug: closeDebugOptions.debug,
        clientRequestId: `${clientRequestId}-${position.symbol}`,
        trade_group_id: tradeGroupId,
        source: 'manual_ui_group',
      });

      if (result.success && !result.dryRun) {
        addActivity('TRADE', `Group leg closed: ${position.symbol} (Order #${result.orderId})`);
        await journalClosedTrade(position, result, exitReason, 'manual_ui_group', `${clientRequestId}-${position.symbol}`);
      } else if (!result.success) {
        allSuccess = false;
        addActivity('RISK', `Failed to close group leg ${position.symbol}: ${result.error}`);
      }
    }

    // Clear DTBP rejection if this was a retry
    if (dtbpRejection?.tradeGroupId === tradeGroupId) {
      setDtbpRejection(null);
    }

    await fetchData();
    return allSuccess;
  }, [getGroupPositions, addActivity, closeDebugOptions, journalClosedTrade, fetchData, dtbpRejection]);

  /**
   * Retry a failed close as a group close (for DTBP rejection recovery)
   */
  const retryCloseAsGroup = useCallback(async (): Promise<boolean> => {
    if (!dtbpRejection) {
      addActivity('SYSTEM', 'No DTBP rejection to retry');
      return false;
    }

    addActivity('TRADE', `Retrying as group close after DTBP rejection...`);
    return closeGroup(dtbpRejection.tradeGroupId, 'dtbp_retry');
  }, [dtbpRejection, closeGroup, addActivity]);

  const emergencyCloseAll = useCallback(async () => {
    addActivity('EMERGENCY', 'Emergency close initiated - closing all positions');
    setIsBotRunning(false);

    for (const position of positions) {
      const result = await tradierApi.closePosition(position.symbol, position.quantity);
      if (result.success) {
        addActivity('TRADE', `Position closed: ${position.symbol}`);
      } else {
        addActivity('RISK', `Failed to close ${position.symbol}: ${result.error}`);
      }
    }

    fetchData();
    addActivity('EMERGENCY', 'Emergency close complete');
  }, [positions, addActivity, fetchData]);

  const runStrategyEngine = useCallback(async () => {
    if (!isBotRunning || riskStatus.killSwitchActive) return;

    const now = Date.now();
    if (now - lastEngineRun.current < 30000) return;
    lastEngineRun.current = now;

    try {
      addActivity('SYSTEM', 'Strategy engine scanning...');

      const exitResult = await strategyEngine.checkExits(strategies, positions);

      let placedAnyExitOrder = false;
      
      // Track which groups we've already processed to avoid duplicate closes
      const processedGroups = new Set<string>();

      for (const exitSignal of exitResult.exitSignals) {
        const position = positions.find(p => p.symbol === exitSignal.symbol);
        if (!position) continue;

        // === BOT GROUP-AWARE CLOSING ===
        // If this position is part of a group, close the entire group
        // This prevents DTBP/margin issues from temporary naked exposure
        if (position.tradeGroupId && !processedGroups.has(position.tradeGroupId)) {
          processedGroups.add(position.tradeGroupId);
          
          const groupPositions = getGroupPositions(position.tradeGroupId);
          addActivity('TRADE', `Bot exit signal: Closing ${groupPositions.length}-leg group (${exitSignal.reason})`);
          
          // Mark all group symbols as pending
          setPendingCloseSymbols(prev => {
            const next = new Set(prev);
            groupPositions.forEach(p => next.add(p.symbol));
            return next;
          });

          const clientRequestId = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          
          // Close each leg in the group
          for (const groupPos of groupPositions) {
            if (pendingCloseSymbolsRef.current.has(groupPos.symbol)) continue;
            
            const result = await tradierApi.closePosition(groupPos.symbol, groupPos.quantity, {
              dryRun: closeDebugOptions.dryRun,
              debug: closeDebugOptions.debug,
              clientRequestId: `${clientRequestId}-${groupPos.symbol}`,
              trade_group_id: position.tradeGroupId,
              source: 'bot_engine_group',
            });

            if (result.success && !result.dryRun) {
              placedAnyExitOrder = true;
              addActivity('TRADE', `Bot closed group leg: ${groupPos.symbol} (Order #${result.orderId})`);
              await journalClosedTrade(groupPos, result, exitSignal.reason, 'bot_engine_group', `${clientRequestId}-${groupPos.symbol}`);
            } else if (!result.success) {
              addActivity('RISK', `Bot failed to close group leg ${groupPos.symbol}: ${result.error}`);
            }
          }
          
          continue; // Skip individual leg processing
        }

        // Non-grouped position: close individually
        const key = exitSignal.symbol;

        // Use ref to get current value
        if (pendingCloseSymbolsRef.current.has(key)) {
          addActivity('SYSTEM', `SKIP: already pending close: ${key}`);
          continue;
        }

        const nowTs = Date.now();
        const lastAttemptTs = lastCloseAttempt.current.get(key) || 0;

        if (nowTs - lastAttemptTs < 120_000) {
          addActivity('SYSTEM', `Skipping duplicate close attempt (cooldown): ${exitSignal.symbol}`);
          continue;
        }
        lastCloseAttempt.current.set(key, nowTs);

        const clientRequestId = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        console.log('CLOSE_REQUEST', { source: 'bot_engine', clientRequestId, symbol: exitSignal.symbol });

        addActivity('TRADE', `Exit signal: ${exitSignal.symbol} - ${exitSignal.reason}`);

        const result = await tradierApi.closePosition(exitSignal.symbol, exitSignal.quantity, {
          dryRun: closeDebugOptions.dryRun,
          debug: closeDebugOptions.debug,
          clientRequestId,
          source: 'bot_engine',
        });

        setLastCloseDebug({
          source: 'bot_engine',
          clientRequestId,
          symbol: exitSignal.symbol,
          result,
          edgeDebug: result.debug,
        });

        if (result.skipped) {
          addActivity('SYSTEM', `${result.error || 'SKIP: cooldown/lock'}`);
          continue;
        }

        if (result.success && !result.dryRun) {
          placedAnyExitOrder = true;
          setPendingCloseSymbols(prev => new Set(prev).add(exitSignal.symbol));
          addActivity('TRADE', `Close order accepted: ${exitSignal.symbol} (Order #${result.orderId})`);

          if (position) {
            await journalClosedTrade(position, result, exitSignal.reason, 'bot_engine', clientRequestId);
          }
        } else if (result.success && result.dryRun) {
          addActivity('SYSTEM', `Dry run computed for ${exitSignal.symbol} (no order sent)`);
        } else {
          addActivity('RISK', `Close order rejected: ${exitSignal.symbol} - ${result.error || 'Unknown error'}`);
        }
      }

      if (placedAnyExitOrder) {
        await fetchData();
      }

      const entryResult = await strategyEngine.evaluateStrategies(strategies, positions);

      if (entryResult.signals.length > 0) {
        for (const signal of entryResult.signals) {
          addActivity('TRADE', `Entry signal: ${signal.strategyName} - ${signal.underlying} $${signal.credit.toFixed(2)} credit`);

          const execResult = await strategyEngine.executeSignal(signal);

          if (execResult.success) {
            addActivity('TRADE', `Order placed: ${signal.strategyName} (Order #${execResult.orderId})`);
            setRiskStatus(prev => ({ ...prev, tradeCount: prev.tradeCount + 1 }));

            setStrategyPositions(prev => {
              const newMap = new Map(prev);
              signal.legs.forEach(leg => {
                newMap.set(leg.symbol, {
                  strategyName: signal.strategyName,
                  underlying: signal.underlying,
                  entryCredit: signal.credit,
                  entryTime: new Date(),
                });
              });
              return newMap;
            });
          } else {
            addActivity('RISK', `Order failed: ${execResult.error}`);
          }
        }

        await fetchData();
      } else {
        addActivity('SYSTEM', 'No entry signals found');
      }
    } catch (error) {
      console.error('Strategy engine error:', error);
      addActivity('SYSTEM', `Engine error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }, [isBotRunning, riskStatus.killSwitchActive, strategies, positions, closeDebugOptions, addActivity, fetchData, strategyPositions, journalClosedTrade, getGroupPositions]);

  const copyLastCloseDebug = useCallback(async () => {
    try {
      if (!lastCloseDebug) return;
      await navigator.clipboard.writeText(JSON.stringify(lastCloseDebug, null, 2));
      addActivity('SYSTEM', 'Close debug copied to clipboard');
    } catch (e) {
      console.error('Failed to copy close debug:', e);
      addActivity('SYSTEM', 'Failed to copy close debug');
    }
  }, [lastCloseDebug, addActivity]);

  // === ALL useEffect DECLARATIONS START HERE ===

  // Sync pendingCloseSymbols to ref for stable closure access
  useEffect(() => {
    pendingCloseSymbolsRef.current = pendingCloseSymbols;
  }, [pendingCloseSymbols]);

  // Track page visibility for polling optimization
  useEffect(() => {
    const handleVisibilityChange = () => {
      isPageVisible.current = document.visibilityState === 'visible';
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Load saved settings and strategies on mount
  useEffect(() => {
    const loadSavedData = async () => {
      try {
        const savedStrategies = await settingsService.getStrategies();
        if (savedStrategies.length > 0) {
          setStrategies(savedStrategies);
          addActivity('SYSTEM', `Loaded ${savedStrategies.length} saved strategies`);
        } else {
          setStrategies(defaultStrategies);
          addActivity('SYSTEM', 'Using default strategies (none saved)');
        }

        const savedSettings = await settingsService.getSettings();
        if (savedSettings) {
          setRiskStatus(prev => ({
            ...prev,
            maxDailyLoss: savedSettings.riskStatus.maxDailyLoss || prev.maxDailyLoss,
            maxPositions: savedSettings.riskStatus.maxPositions || prev.maxPositions,
          }));
          setSafeguards(savedSettings.safeguards);
          addActivity('SYSTEM', 'Loaded saved risk settings');
        }

        setSettingsLoaded(true);
      } catch (error) {
        console.error('Error loading saved data:', error);
        setStrategies(defaultStrategies);
        setSettingsLoaded(true);
      }
    };

    loadSavedData();
  }, [addActivity]);

  // Real-time sync for strategies across devices/users
  useEffect(() => {
    const channel = supabase
      .channel('strategies-sync')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'strategies',
        },
        async (payload) => {
          console.log('Strategy change detected:', payload);

          if (payload.eventType === 'INSERT') {
            const newStrategy = settingsService.mapDbToStrategy(payload.new as any);
            setStrategies(prev => {
              if (prev.some(s => s.id === newStrategy.id)) return prev;
              return [...prev, newStrategy];
            });
            addActivity('SYSTEM', `Strategy "${newStrategy.name}" added (synced)`);
          } else if (payload.eventType === 'UPDATE') {
            const updatedStrategy = settingsService.mapDbToStrategy(payload.new as any);
            setStrategies(prev =>
              prev.map(s => s.id === updatedStrategy.id ? updatedStrategy : s)
            );
            addActivity('SYSTEM', `Strategy "${updatedStrategy.name}" updated (synced)`);
          } else if (payload.eventType === 'DELETE') {
            const deletedId = (payload.old as any).id;
            setStrategies(prev => prev.filter(s => s.id !== deletedId));
            addActivity('SYSTEM', 'Strategy deleted (synced)');
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [addActivity]);

  // === STABILITY_MODE: Split polling with visibility + market-hours gating ===
  useEffect(() => {
    if (!STABILITY_MODE) {
      // Legacy behavior: poll everything every 5s
      fetchDataLegacy();
      addActivity('SYSTEM', 'Dashboard connected - fetching market data (legacy mode)');

      const interval = setInterval(() => {
        fetchDataLegacy();
      }, 5000);

      return () => clearInterval(interval);
    }

    // Initial fetch
    fetchFastData();
    fetchSlowData(true);
    addActivity('SYSTEM', 'Dashboard connected - fetching market data (stability mode)');

    // Fast loop: clock + quotes
    const fastIntervalId = setInterval(() => {
      // Apply backoff multiplier
      const effectiveInterval = FAST_POLL_INTERVAL * backoffMultiplier.current;
      
      // If hidden tab, slow down
      if (!isPageVisible.current) {
        if (Date.now() % HIDDEN_POLL_INTERVAL < FAST_POLL_INTERVAL) {
          fetchFastData();
        }
        return;
      }

      // If market closed, slow down
      if (marketStateRef.current !== 'open' && marketStateRef.current !== 'premarket') {
        if (Date.now() % CLOSED_POLL_INTERVAL < FAST_POLL_INTERVAL) {
          fetchFastData();
        }
        return;
      }

      fetchFastData();
    }, FAST_POLL_INTERVAL);

    // Slow loop: positions + balances + chains
    const slowIntervalId = setInterval(() => {
      const timeSinceLastSlow = Date.now() - lastSlowFetch.current;

      // If hidden tab, use longer interval
      if (!isPageVisible.current) {
        if (timeSinceLastSlow >= HIDDEN_POLL_INTERVAL) {
          fetchSlowData(false); // Don't force chains when hidden
        }
        return;
      }

      // If market closed, use longer interval and skip chains
      if (marketStateRef.current !== 'open' && marketStateRef.current !== 'premarket') {
        if (timeSinceLastSlow >= CLOSED_POLL_INTERVAL) {
          fetchSlowData(false); // Don't fetch chains when closed
        }
        return;
      }

      // Normal market hours
      if (timeSinceLastSlow >= SLOW_POLL_INTERVAL * backoffMultiplier.current) {
        fetchSlowData(true);
      }
    }, SLOW_POLL_INTERVAL);

    return () => {
      clearInterval(fastIntervalId);
      clearInterval(slowIntervalId);
    };
  }, [fetchFastData, fetchSlowData, fetchDataLegacy, addActivity]);

  // Run strategy engine when bot is running
  useEffect(() => {
    if (!isBotRunning) return;

    runStrategyEngine();

    const engineInterval = setInterval(runStrategyEngine, 30000);

    return () => clearInterval(engineInterval);
  }, [isBotRunning, runStrategyEngine]);

  // Background task: Poll pending close orders and update their status
  useEffect(() => {
    const reconcilePendingCloses = async () => {
      try {
        // Get trades with pending close status
        const pendingTrades = await tradeJournal.getTradesWithPendingClose();
        
        if (pendingTrades.length === 0) return;
        
        console.log('[reconcilePendingCloses] Found', pendingTrades.length, 'pending close orders');
        
        for (const trade of pendingTrades) {
          if (!trade.close_order_id) continue;
          
          const orderStatus = await tradierApi.getOrderStatus(trade.close_order_id);
          
          if (!orderStatus.success) {
            console.warn('[reconcilePendingCloses] Could not fetch status for', trade.close_order_id);
            continue;
          }
          
          // Only update if status has changed from 'submitted'
          if (orderStatus.closeStatus !== 'submitted') {
            const updateResult = await tradeJournal.updateCloseStatus(
              trade.close_order_id,
              orderStatus.closeStatus,
              {
                avgFillPrice: orderStatus.avgFillPrice,
                filledQty: orderStatus.filledQty,
                rejectReason: orderStatus.rejectReason,
                open_side: trade.open_side,
                fees: 0,
              }
            );
            
            if (updateResult.success) {
              console.log('[reconcilePendingCloses] Updated', trade.close_order_id, 'to', orderStatus.closeStatus);
              
              if (orderStatus.closeStatus === 'filled') {
                addActivity('TRADE', `Trade filled: ${trade.symbol} @ $${orderStatus.avgFillPrice?.toFixed(2) || '?'}`);
              } else if (orderStatus.closeStatus === 'rejected' || orderStatus.closeStatus === 'canceled' || orderStatus.closeStatus === 'expired') {
                addActivity('RISK', `Close ${orderStatus.closeStatus}: ${trade.symbol} - ${orderStatus.rejectReason || 'Unknown'}`);
              }
            }
          }
        }
      } catch (error) {
        console.error('[reconcilePendingCloses] Error:', error);
      }
    };
    
    // Run immediately then every 10 seconds
    reconcilePendingCloses();
    const interval = setInterval(reconcilePendingCloses, 10000);
    
    return () => clearInterval(interval);
  }, [addActivity]);

  return {
    positions,
    greeks,
    quotes,
    strategies,
    riskStatus,
    safeguards,
    activity,
    marketState,
    isApiConnected,
    isBotRunning,
    lastUpdate,
    isLoading,
    error,
    deltaHistory,
    pnlHistory,
    toggleBot,
    toggleKillSwitch,
    updateRiskSettings,
    updateSafeguards,
    toggleStrategy,
    addStrategy,
    deleteStrategy,
    closePosition,
    emergencyCloseAll,
    refetch: fetchData,

    closeDebugOptions,
    setCloseDebugOptions,
    lastCloseDebug,
    copyLastCloseDebug,

    // === GROUP-AWARE CLOSING ===
    legOutModeEnabled,
    setLegOutModeEnabled,
    closeGroup,
    retryCloseAsGroup,
    dtbpRejection,
    isGroupedPosition,
    getGroupPositions,
  };
};
