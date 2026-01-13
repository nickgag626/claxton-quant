import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { tradierApi, calculatePortfolioGreeks, parseOptionSymbol } from '@/services/tradierApi';
import { strategyEngine } from '@/services/strategyEngine';
import { tradeJournal, TradeRecord } from '@/services/tradeJournal';
import { settingsService } from '@/services/settingsService';
import { toast } from '@/hooks/use-toast';
import { expectedLegCount, strategyDisplayName } from '@/lib/strategyLegs';
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
 * Generate a deterministic UUID v4-like string from a seed string.
 * Uses a simple hash algorithm to produce a consistent UUID for the same input.
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where y is 8, 9, a, or b
 */
function deterministicUUID(seed: string): string {
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  // Generate more entropy by hashing with different seeds
  const hash2 = Math.abs(hash * 31 + seed.length);
  const hash3 = Math.abs(hash * 37 + hash2);
  const hash4 = Math.abs(hash2 * 41 + hash3);
  
  // Convert to hex strings and pad
  const hex1 = Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
  const hex2 = Math.abs(hash2).toString(16).padStart(4, '0').slice(0, 4);
  const hex3 = Math.abs(hash3).toString(16).padStart(4, '0').slice(0, 4);
  const hex4 = Math.abs(hash4).toString(16).padStart(12, '0').slice(0, 12);
  
  // Format: xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx (UUID v4 format)
  return `${hex1}-${hex2}-4${hex3.slice(1)}-8${hex3.slice(0, 3)}-${hex4}`;
}

/**
 * Extract underlying symbol from OCC option symbol
 * e.g., SPY260112P00693000 -> SPY
 */
function extractUnderlyingFromSymbol(symbol: string): string {
  const match = symbol.match(/^([A-Z]+)\d/);
  return match ? match[1] : symbol;
}

/**
 * Extract expiration (YYMMDD) from OCC symbol
 */
function extractExpirationFromSymbol(symbol: string): string | null {
  const match = symbol.match(/^[A-Z]+(\d{6})[CP]/);
  return match ? match[1] : null;
}

/**
 * Parse option type and strike from OCC symbol
 */
function parseOccSymbol(symbol: string): { type: 'C' | 'P'; strike: number } | null {
  // OCC format: SYMBOL + YYMMDD + C/P + Strike (8 digits, e.g. 00580000 = 580.00)
  const match = symbol.match(/^[A-Z]+\d{6}([CP])(\d{8})$/);
  if (!match) return null;
  return {
    type: match[1] as 'C' | 'P',
    strike: parseInt(match[2], 10) / 1000,
  };
}

/**
 * Validate iron condor signature: exactly 2 puts + 2 calls, 2 long + 2 short, proper strike ordering
 * Returns true only if the 4-leg group forms a valid iron condor structure.
 */
function isValidIronCondorGroup(positions: Position[]): boolean {
  if (positions.length !== 4) return false;
  
  const parsed = positions.map(p => {
    const occ = parseOccSymbol(p.symbol);
    return occ ? { ...occ, qty: p.quantity, symbol: p.symbol } : null;
  });
  
  if (parsed.some(p => p === null)) return false;
  
  const puts = parsed.filter(p => p!.type === 'P');
  const calls = parsed.filter(p => p!.type === 'C');
  
  // Must have exactly 2 puts and 2 calls
  if (puts.length !== 2 || calls.length !== 2) return false;
  
  // Must have 2 long (qty > 0) and 2 short (qty < 0) overall
  const longCount = parsed.filter(p => p!.qty > 0).length;
  const shortCount = parsed.filter(p => p!.qty < 0).length;
  if (longCount !== 2 || shortCount !== 2) return false;
  
  // Put side: one short (higher strike), one long (lower strike) 
  const putStrikes = puts.map(p => ({ strike: p!.strike, qty: p!.qty })).sort((a, b) => a.strike - b.strike);
  // Lower put = long (protection), higher put = short (sold)
  if (!(putStrikes[0].qty > 0 && putStrikes[1].qty < 0)) return false;
  
  // Call side: one short (lower strike), one long (higher strike)
  const callStrikes = calls.map(c => ({ strike: c!.strike, qty: c!.qty })).sort((a, b) => a.strike - b.strike);
  // Lower call = short (sold), higher call = long (protection)
  if (!(callStrikes[0].qty < 0 && callStrikes[1].qty > 0)) return false;
  
  // Short put strike < short call strike (otherwise it's not a valid condor)
  if (putStrikes[1].strike >= callStrikes[0].strike) return false;
  
  return true;
}

/**
 * Generate a heuristic group key for a position based on:
 * - underlying symbol
 * - expiration date
 * - entry time window (rounded to 5-min bucket)
 * Returns a valid UUID for database compatibility.
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
 * Apply trade_group_id from position_group_map (source of truth).
 * Falls back to STRICT heuristic grouping only if group forms valid 4L iron condor.
 * Otherwise marks positions as ungrouped (requires reconcile).
 */
async function enrichPositionsWithGroupIds(positions: Position[]): Promise<Position[]> {
  if (positions.length === 0) return positions;

  const symbols = positions.map(p => p.symbol);
  
  try {
    // === SOURCE OF TRUTH: Fetch from position_group_map (set at entry time) ===
    const { data: groupMaps, error: mapError } = await supabase
      .from('position_group_map')
      .select('symbol, trade_group_id, strategy_name, strategy_type')
      .in('symbol', symbols);

    if (mapError) {
      console.error('Error fetching position_group_map:', mapError);
    }

    // Build symbol -> group info map from position_group_map
    const symbolToGroupInfo = new Map<string, { tradeGroupId: string; strategyName?: string; strategyType?: string }>();
    if (groupMaps) {
      groupMaps.forEach((row: any) => {
        if (row.trade_group_id) {
          symbolToGroupInfo.set(row.symbol, {
            tradeGroupId: row.trade_group_id,
            strategyName: row.strategy_name,
            strategyType: row.strategy_type,
          });
        }
      });
    }
    console.log(`[enrichPositionsWithGroupIds] Found ${symbolToGroupInfo.size}/${symbols.length} symbols in position_group_map`);

    // Apply DB-first grouping
    const enrichedPositions = positions.map(pos => {
      const dbInfo = symbolToGroupInfo.get(pos.symbol);
      if (dbInfo) {
        return { 
          ...pos, 
          tradeGroupId: dbInfo.tradeGroupId,
          strategyName: pos.strategyName || dbInfo.strategyName,
          strategyType: pos.strategyType || dbInfo.strategyType,
        };
      }
      return pos;
    });

    // === STRICT HEURISTIC FALLBACK: Only for positions not in DB ===
    // Group ungrouped positions by heuristic key
    const ungroupedByHeuristic = new Map<string, Position[]>();
    
    enrichedPositions.forEach(pos => {
      if (!pos.tradeGroupId) {
        const key = generateHeuristicGroupKey(pos);
        const existing = ungroupedByHeuristic.get(key) || [];
        ungroupedByHeuristic.set(key, [...existing, pos]);
      }
    });

    // Only assign heuristic group IDs if group is EXACTLY a valid 4L iron condor
    const heuristicGroupIds = new Map<string, string>();
    ungroupedByHeuristic.forEach((groupPositions, key) => {
      // STRICT: Only group if valid 4L iron condor signature
      if (groupPositions.length === 4 && isValidIronCondorGroup(groupPositions)) {
        const uuid = deterministicUUID(key);
        heuristicGroupIds.set(key, uuid);
        console.log(`[enrichPositionsWithGroupIds] Heuristic group accepted (valid 4L IC): ${key}`);
      } else if (groupPositions.length > 1) {
        // Log rejection for visibility
        console.log(`[enrichPositionsWithGroupIds] Heuristic group REJECTED: ${key} has ${groupPositions.length} legs, not valid IC structure`);
      }
    });

    // Apply heuristic group IDs only to valid 4L groups
    return enrichedPositions.map(pos => {
      if (pos.tradeGroupId) return pos; // Already has DB group ID
      
      const heuristicKey = generateHeuristicGroupKey(pos);
      const heuristicGroupId = heuristicGroupIds.get(heuristicKey);
      
      if (heuristicGroupId) {
        return { ...pos, tradeGroupId: heuristicGroupId };
      }
      
      // Not in DB and not part of valid heuristic group → stays ungrouped
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
    maxCondorsPerExpiry: 3,
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

  // Clear all history (trades from DB, activity log, P&L history, delta history)
  const clearHistory = useCallback(async () => {
    try {
      // Clear trades from database
      const result = await tradeJournal.clearAllTrades();
      
      if (!result.success) {
        toast({
          title: 'Error Clearing History',
          description: result.error || 'Failed to clear trades from database',
          variant: 'destructive',
        });
        return;
      }

      // Clear in-memory state
      setActivity([]);
      setPnlHistory([]);
      setDeltaHistory([]);
      
      // Reset P&L stats
      setRiskStatus(prev => ({
        ...prev,
        dailyPnl: 0,
        realizedPnl: 0,
        tradeCount: 0,
      }));

      toast({
        title: 'History Cleared',
        description: `Deleted ${result.deleted} trades. Activity log and P&L stats have been reset.`,
      });
    } catch (error) {
      console.error('Error clearing history:', error);
      toast({
        title: 'Error Clearing History',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
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

      // Debug: log unrealized P&L from broker vs computed from positions
      const computedUnrealizedPnl = enrichedPositions.reduce((sum, p) => {
        return sum + (p.currentValue - p.costBasis);
      }, 0);
      console.log('[P&L Debug] Broker open_pl:', unrealizedPnl, 'Computed from positions:', computedUnrealizedPnl);

      // Fetch realized P&L from trade journal (finalized trades today in America/New_York)
      const { realized: realizedPnl, tradeCount } = await tradeJournal.getRealizedTodayPnl();

      // Total daily P&L = realized (from DB) + unrealized (from broker)
      const totalDailyPnl = realizedPnl + unrealizedPnl;

      console.log('[P&L Debug] Realized:', realizedPnl, 'Unrealized:', unrealizedPnl, 'Total:', totalDailyPnl);

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

  const updateStrategy = useCallback(async (strategyId: string, strategy: Omit<Strategy, 'id'>) => {
    const updatedStrategy = await settingsService.updateStrategy(strategyId, strategy);
    
    if (updatedStrategy) {
      setStrategies(prev => prev.map(s => s.id === strategyId ? updatedStrategy : s));
      addActivity('SYSTEM', `Strategy "${strategy.name}" updated`);
    } else {
      // Fallback to local update if DB fails
      setStrategies(prev => prev.map(s => s.id === strategyId ? { ...strategy, id: strategyId } : s));
      addActivity('SYSTEM', `Strategy "${strategy.name}" updated (local only)`);
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
  ): Promise<string | undefined> => {
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

      // trade_group_id must be a valid UUID for database compatibility
      const isValidUUID = (str: string | undefined): boolean => {
        if (!str) return false;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        return uuidRegex.test(str);
      };

      const tradeGroupId = isValidUUID(position.tradeGroupId) ? position.tradeGroupId : undefined;
      
      // Log if we're discarding a group ID (shouldn't happen now with UUID-based heuristic IDs)
      if (position.tradeGroupId && !tradeGroupId) {
        console.warn('[journalClosedTrade] Discarding invalid group ID:', position.tradeGroupId);
      }

      const tradeRecord: Omit<TradeRecord, 'id'> = {
        symbol: position.symbol,
        underlying,
        strategy_name: stratInfo?.strategyName || position.strategyName,
        strategy_type: position.strategyType,
        quantity,
        entry_time: stratInfo?.entryTime?.toISOString() || position.entryTime?.toISOString() || now,
        exit_time: now, // Set to submission time, updated when filled
        entry_price: entryPrice,
        exit_price: undefined, // Set when filled from Tradier avg_fill_price
        entry_credit: stratInfo?.entryCredit,
        pnl: null, // NEVER guess - wait for fill confirmation
        pnl_percent: null,
        pnl_formula: undefined,
        exit_reason: exitReason,
        trade_group_id: tradeGroupId,
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
        return saveResult.id;
      }

      if (!saveResult.success) {
        console.error('[journalClosedTrade] Failed to save submitted trade:', saveResult.error);
        return;
      }

      console.log('[journalClosedTrade] Saved as submitted:', position.symbol, closeResult.orderId, 'row:', saveResult.id);

      // STEP 2: Immediately check order status with Tradier
      // Small delay to allow order to process
      await new Promise(resolve => setTimeout(resolve, 500));

      const orderStatus = await tradierApi.getOrderStatus(closeResult.orderId);
      console.log('[journalClosedTrade] Order status:', closeResult.orderId, orderStatus);

      if (!orderStatus.success) {
        console.warn('[journalClosedTrade] Could not fetch order status, will retry later:', orderStatus.error);
        return saveResult.id;
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
          legFills: orderStatus.legFills, // Per-leg fill prices for multi-leg orders
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

      return saveResult.id;
    } catch (error) {
      console.error('[journalClosedTrade] Error:', error);
      return;
    }
  }, [strategyPositions, addActivity]);

  // Get all positions that belong to the same trade group
  // MUST be declared before requestClose, closePosition, closeGroup, etc.
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
   * SINGLE CHOKE POINT for ALL closes.
   * The ONLY place in the app allowed to call tradierApi.closePosition/closeGroup.
   */
  const requestClose = useCallback(async (params: {
    source: 'bot' | 'manual' | 'emergency';
    exitReason: string;
    tradeGroupId?: string;
    symbol?: string;
  }): Promise<boolean> => {
    const { source, exitReason, tradeGroupId, symbol } = params;

    const allowFlagKey = '__ALLOW_BROKER_CLOSE__';

    const logAttempt = (decision: string, extra?: Record<string, any>) => {
      const payload = {
        source,
        symbol,
        tradeGroupId,
        legOutMode: legOutModeEnabled,
        decision,
        ...extra,
      };
      console.log('[requestClose]', payload);
      addActivity(decision === 'blocked' ? 'RISK' : 'TRADE',
        `CLOSE ${decision.toUpperCase()}: src=${source} sym=${symbol || '-'} group=${tradeGroupId || '-'} legOut=${legOutModeEnabled}` +
        (extra?.reason ? ` — ${extra.reason}` : '')
      );
    };

    // ===== GROUP CLOSE =====
    if (tradeGroupId) {
      const groupPositions = getGroupPositions(tradeGroupId);
      const symbolsInGroup = groupPositions.map(p => p.symbol);

      if (groupPositions.length === 0) {
        logAttempt('blocked', { reason: 'No positions found for group' });
        return false;
      }

      const strategyType = groupPositions.find(p => p.strategyType)?.strategyType;
      const expected = expectedLegCount(strategyType);
      const observed = groupPositions.length;

      if (!legOutModeEnabled && expected !== null && observed < expected) {
        logAttempt('blocked', { reason: 'Broken structure — manual intervention required', expected, observed });
        return false;
      }

      // Mark as pending close immediately (UI)
      setPendingCloseSymbols(prev => {
        const next = new Set(prev);
        symbolsInGroup.forEach(s => next.add(s));
        return next;
      });

      const clientRequestId = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      logAttempt('submitted', { symbols: symbolsInGroup, clientRequestId });

      // Allow broker close only inside this scope (dev assertion guard)
      (globalThis as any)[allowFlagKey] = true;
      try {
        const result = await tradierApi.closeGroup(symbolsInGroup, {
          dryRun: closeDebugOptions.dryRun,
          debug: closeDebugOptions.debug,
          clientRequestId,
          trade_group_id: tradeGroupId,
          source: source === 'bot' ? 'bot_engine_group' : source === 'emergency' ? 'emergency_close' : 'manual_ui_group',
        });

        if (result.skipped) {
          logAttempt('blocked', { reason: result.error || 'cooldown/lock', clientRequestId });
          return false;
        }

        if (result.notFound) {
          logAttempt('filled', { reason: 'Already closed (not found)', clientRequestId });
          await fetchData();
          return true;
        }

        if (result.success && result.dryRun) {
          logAttempt('submitted', { reason: 'dryRun', clientRequestId });
          return true;
        }

        if (result.success && result.orderId) {
          const legInfoBySymbol = new Map(
            (result.legs || []).map(l => [l.symbol, l])
          );

          const journalIds: Array<{ symbol: string; id?: string }> = [];
          for (const p of groupPositions) {
            const leg = legInfoBySymbol.get(p.symbol);
            const journalId = await journalClosedTrade(
              p,
              {
                orderId: result.orderId,
                closeSide: leg?.closeSide,
                closeQty: leg?.closeQty,
                positionDetails: leg ? { symbol: p.symbol, quantity: p.quantity, costBasis: p.costBasis, side: leg.positionSide } : undefined,
              },
              exitReason,
              source === 'bot' ? 'bot_engine_group' : source === 'emergency' ? 'emergency_close' : 'manual_ui_group',
              clientRequestId
            );
            journalIds.push({ symbol: p.symbol, id: journalId });
          }

          // Clear DTBP rejection if applicable
          if (dtbpRejection?.tradeGroupId === tradeGroupId) {
            setDtbpRejection(null);
          }

          logAttempt('submitted', { orderId: result.orderId, journal: journalIds });
          await fetchData();
          return true;
        }

        logAttempt('rejected', { reason: result.error || 'Order failed', clientRequestId });
        return false;
      } finally {
        (globalThis as any)[allowFlagKey] = false;
      }
    }

    // ===== SINGLE SYMBOL CLOSE =====
    if (!symbol) {
      logAttempt('blocked', { reason: 'Missing symbol or tradeGroupId' });
      return false;
    }

    const position = positions.find(p => p.symbol === symbol);
    if (!position) {
      logAttempt('blocked', { reason: 'Position not found in local state' });
      return false;
    }

    // If position is grouped, and legOutMode is OFF, single-leg close is forbidden.
    if (position.tradeGroupId && !legOutModeEnabled) {
      const expected = expectedLegCount(position.strategyType);
      const observed = getGroupPositions(position.tradeGroupId).length;
      logAttempt('blocked', {
        reason: expected !== null ? `Grouped structure — use Close Group (${observed}/${expected})` : 'Grouped structure — use Close Group',
      });
      return false;
    }

    if (pendingCloseSymbolsRef.current.has(position.symbol)) {
      logAttempt('blocked', { reason: 'Already pending close' });
      return false;
    }

    const clientRequestId = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    logAttempt('submitted', { clientRequestId });

    (globalThis as any)[allowFlagKey] = true;
    try {
      const result = await tradierApi.closePosition(position.symbol, position.quantity, {
        dryRun: closeDebugOptions.dryRun,
        debug: closeDebugOptions.debug,
        clientRequestId,
        trade_group_id: position.tradeGroupId,
        source:
          source === 'bot' ? 'bot_engine_single' :
          source === 'emergency' ? 'emergency_close' :
          legOutModeEnabled ? 'manual_ui_legout' : 'manual_ui',
      });

      setLastCloseDebug({ source, clientRequestId, symbol: position.symbol, result, edgeDebug: result.debug });

      if (result.skipped) {
        logAttempt('blocked', { reason: result.error || 'cooldown/lock', clientRequestId });
        return false;
      }

      if (result.notFound) {
        logAttempt('filled', { reason: 'Already closed (not found)', clientRequestId });
        await fetchData();
        return true;
      }

      if (result.success && result.dryRun) {
        logAttempt('submitted', { reason: 'dryRun', clientRequestId });
        return true;
      }

      if (result.success && result.orderId) {
        setPendingCloseSymbols(prev => new Set(prev).add(position.symbol));
        const journalId = await journalClosedTrade(position, result, exitReason, String(result?.debug?.source || source), clientRequestId);
        logAttempt('submitted', { orderId: result.orderId, journalRowId: journalId, clientRequestId });
        await fetchData();
        return true;
      }

      // DTBP rejection detection
      if (!result.success && result.error && position.tradeGroupId && isDtbpRejection(result.error)) {
        setDtbpRejection({
          symbol: position.symbol,
          tradeGroupId: position.tradeGroupId,
          rejectReason: result.error,
          timestamp: Date.now(),
        });
      }

      logAttempt('rejected', { reason: result.error || 'Order failed', clientRequestId });
      return false;
    } finally {
      (globalThis as any)[allowFlagKey] = false;
    }
  }, [addActivity, closeDebugOptions.debug, closeDebugOptions.dryRun, dtbpRejection, fetchData, getGroupPositions, journalClosedTrade, legOutModeEnabled, positions]);

  /**
   * Close a single position (single-leg) — delegates to requestClose
   */
  const closePosition = useCallback(async (
    positionId: string,
    exitReason: string = 'manual',
    _options?: { forceLegOut?: boolean }
  ): Promise<boolean> => {
    const position = positions.find(p => p.id === positionId);
    if (!position) return false;

    return requestClose({ source: 'manual', exitReason, symbol: position.symbol });
  }, [positions, requestClose]);

  /**
   * Close all positions in a trade group — delegates to requestClose
   */
  const closeGroup = useCallback(async (tradeGroupId: string, exitReason: string = 'manual'): Promise<boolean> => {
    return requestClose({ source: 'manual', exitReason, tradeGroupId });
  }, [requestClose]);

  /**
   * Retry a failed close as a group close (for DTBP rejection recovery)
   */
  const retryCloseAsGroup = useCallback(async (): Promise<boolean> => {
    if (!dtbpRejection) {
      addActivity('SYSTEM', 'No DTBP rejection to retry');
      return false;
    }
    return requestClose({ source: 'manual', exitReason: 'dtbp_retry', tradeGroupId: dtbpRejection.tradeGroupId });
  }, [dtbpRejection, addActivity, requestClose]);

  /**
   * Emergency close all positions — loops over unique groups + ungrouped positions and calls requestClose
   */
  const emergencyCloseAll = useCallback(async () => {
    addActivity('EMERGENCY', 'Emergency close initiated - closing all positions');
    setIsBotRunning(false);

    // Group positions by tradeGroupId
    const groups = new Map<string, Position[]>();
    const ungrouped: Position[] = [];

    positions.forEach(p => {
      if (p.tradeGroupId) {
        const arr = groups.get(p.tradeGroupId) || [];
        arr.push(p);
        groups.set(p.tradeGroupId, arr);
      } else {
        ungrouped.push(p);
      }
    });

    // Close each group with a single multileg order
    for (const [groupId] of groups) {
      await requestClose({ source: 'emergency', exitReason: 'emergency_close', tradeGroupId: groupId });
    }

    // Close ungrouped positions individually
    for (const p of ungrouped) {
      await requestClose({ source: 'emergency', exitReason: 'emergency_close', symbol: p.symbol });
    }

    await fetchData();
    addActivity('EMERGENCY', 'Emergency close complete');
  }, [positions, addActivity, fetchData, requestClose]);

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

      // === CRITICAL FIX: Group exit signals by tradeGroupId FIRST ===
      // Never iterate per-leg - always process by group
      const groupExitSignals = new Map<string, { signals: typeof exitResult.exitSignals; positions: Position[] }>();
      const ungroupedExitSignals: typeof exitResult.exitSignals = [];

      for (const exitSignal of exitResult.exitSignals) {
        const position = positions.find(p => p.symbol === exitSignal.symbol);
        if (!position) continue;

        if (position.tradeGroupId) {
          if (!groupExitSignals.has(position.tradeGroupId)) {
            groupExitSignals.set(position.tradeGroupId, { signals: [], positions: [] });
          }
          const group = groupExitSignals.get(position.tradeGroupId)!;
          group.signals.push(exitSignal);
          if (!group.positions.some(p => p.id === position.id)) {
            group.positions.push(position);
          }
        } else {
          ungroupedExitSignals.push(exitSignal);
        }
      }

      // === PROCESS GROUPED EXITS via requestClose ===
      for (const [tradeGroupId, { signals }] of groupExitSignals) {
        if (processedGroups.has(tradeGroupId)) continue;
        processedGroups.add(tradeGroupId);

        const exitReason = signals[0]?.reason || 'bot_exit';
        const success = await requestClose({ source: 'bot', exitReason, tradeGroupId });
        if (success) placedAnyExitOrder = true;
      }

      // === PROCESS UNGROUPED EXITS: Only for truly single-leg positions ===
      for (const exitSignal of ungroupedExitSignals) {
        const position = positions.find(p => p.symbol === exitSignal.symbol);
        if (!position) continue;

        // Double-check: If position has a tradeGroupId but was somehow not grouped, BLOCK
        if (position.tradeGroupId) {
          addActivity('RISK', 
            `⛔ EXIT BLOCKED: Position ${position.symbol} has tradeGroupId but wasn't grouped. ` +
            `Use "Close Group" for safety.`
          );
          continue;
        }

        const key = exitSignal.symbol;

        const nowTs = Date.now();
        const lastAttemptTs = lastCloseAttempt.current.get(key) || 0;

        if (nowTs - lastAttemptTs < 120_000) {
          addActivity('SYSTEM', `Skipping duplicate close attempt (cooldown): ${exitSignal.symbol}`);
          continue;
        }
        lastCloseAttempt.current.set(key, nowTs);

        const success = await requestClose({ source: 'bot', exitReason: exitSignal.reason, symbol: exitSignal.symbol });
        if (success) placedAnyExitOrder = true;
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
          } else if (execResult.blocked === 'cooldown') {
            addActivity('RISK', `Entry blocked (cooldown): ${signal.strategyName} - wait 2 minutes`);
            toast({
              title: "Entry Blocked - Cooldown",
              description: `${signal.strategyName} entry blocked due to recent rejection. Wait 2 minutes before retry.`,
              variant: "destructive",
            });
          } else if (execResult.blocked === 'conflict') {
            const conflictSymbols = execResult.conflict_symbols?.join(', ') || 
              execResult.conflicts?.map(c => c.symbol).join(', ') || 'unknown';
            const conflictDetails = execResult.conflictDetails?.join('\n• ') || '';
            
            addActivity('RISK', `STRICT MODE: Entry blocked - overlapping positions [${conflictSymbols}]`);
            toast({
              title: "⚠️ Entry Blocked - Position Conflict",
              description: `STRICT MODE: Cannot open ${signal.strategyName}.\n\nConflicting positions:\n• ${conflictDetails || conflictSymbols}\n\nClose or flatten existing positions first.`,
              variant: "destructive",
              duration: 10000,
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
  }, [isBotRunning, riskStatus.killSwitchActive, strategies, positions, addActivity, fetchData, strategyPositions, requestClose, getGroupPositions]);

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
    clearHistory,
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
    updateStrategy,
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
