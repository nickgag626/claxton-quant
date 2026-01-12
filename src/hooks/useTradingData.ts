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
import type { DeltaDataPoint } from '@/components/dashboard/GreeksChart';

/**
 * Extract underlying symbol from OCC option symbol
 * e.g., SPY260112P00693000 -> SPY
 */
function extractUnderlyingFromSymbol(symbol: string): string {
  const match = symbol.match(/^([A-Z]+)\d/);
  return match ? match[1] : symbol;
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
      maxDelta: 0.10,
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
      maxDelta: 0.16,
      marketHoursOnly: true,
    },
    exitConditions: {
      profitTargetPercent: 50,
      stopLossPercent: 200,
    },
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
      maxDelta: 0.30,
      minIvRank: 25,
      marketHoursOnly: true,
    },
    exitConditions: {
      profitTargetPercent: 50,
      stopLossPercent: 200,
      timeStopDte: 7,
    },
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

  const lastEngineRun = useRef<number>(0);
  const lastCloseAttempt = useRef<Map<string, number>>(new Map());
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

  // Fetch market data
  const fetchData = useCallback(async () => {
    try {
      // Fetch quotes for SPY and QQQ
      const quotesData = await tradierApi.getQuotes(['SPY', 'QQQ']);
      setQuotes(quotesData);
      
      // Fetch positions and enrich with strategy info
      const positionsData = await tradierApi.getPositions();
      
      // Reconcile pending_close set: remove symbols that no longer exist at broker
      const brokerSymbols = new Set(positionsData.map(p => p.symbol));
      setPendingCloseSymbols(prev => {
        const next = new Set<string>();
        prev.forEach(sym => {
          if (brokerSymbols.has(sym)) next.add(sym);
        });
        return next;
      });

      // Enrich positions with strategy info + pending_close state
      const enrichedPositions = positionsData.map(pos => {
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
      
      // Fetch balances for open/closed P&L (authoritative)
      const balances = await tradierApi.getBalances();
      const openPnl = balances?.open_pl || 0;
      const closedPnl = balances?.close_pl || 0;

      // Total daily P&L = realized (close_pl) + unrealized (open_pl)
      // This avoids double-counting / duplicates from the local trade journal.
      const totalDailyPnl = closedPnl + openPnl;
      
      setRiskStatus(prev => ({
        ...prev,
        dailyPnl: totalDailyPnl,
      }));
      
      // Track P&L history (max 100 points for the day)
      const now = new Date();
      const timeLabel = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
      setPnlHistory(prev => {
        const newPoint = { time: timeLabel, pnl: totalDailyPnl };
        // Avoid duplicates for same minute
        if (prev.length > 0 && prev[prev.length - 1].time === timeLabel) {
          return [...prev.slice(0, -1), newPoint];
        }
        return [...prev.slice(-99), newPoint];
      });
      
      // Fetch market clock
      const clock = await tradierApi.getMarketClock();
      setMarketState(clock.state);
      
      // Calculate Greeks from option positions
      if (positionsData.length > 0) {
        // Parse option symbols to get underlyings and expirations
        const optionPositions = positionsData
          .map(p => ({ position: p, parsed: parseOptionSymbol(p.symbol) }))
          .filter(item => item.parsed !== null);
        
        if (optionPositions.length > 0) {
          // Group by underlying and expiration
          const chainRequests = new Map<string, Set<string>>();
          optionPositions.forEach(({ parsed }) => {
            if (!parsed) return;
            if (!chainRequests.has(parsed.underlying)) {
              chainRequests.set(parsed.underlying, new Set());
            }
            chainRequests.get(parsed.underlying)!.add(parsed.expiration);
          });
          
          let allOptionData: any[] = [];
          
          // Fetch chains for each underlying/expiration pair
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
          
          // Calculate portfolio greeks
          const portfolioGreeks = calculatePortfolioGreeks(positionsData, allOptionData);
          setGreeks(portfolioGreeks);
          
          // Track delta history (max 50 points for the day)
          const now = new Date();
          const timeLabel = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
          setDeltaHistory(prev => {
            const newPoint = { time: timeLabel, delta: portfolioGreeks.delta };
            // Avoid duplicates for same minute
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
  }, [strategyPositions]);

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
    
    // Persist to database
    await settingsService.updateRiskSettings(settings.maxDailyLoss, settings.maxPositions);
  }, [addActivity]);

  const updateSafeguards = useCallback(async (newSafeguards: TradeSafeguards) => {
    setSafeguards(newSafeguards);
    addActivity('RISK', `Safeguards updated: Spread ${newSafeguards.maxBidAskSpreadPercent}%, Close Buffer ${newSafeguards.zeroDteCloseBufferMinutes}min, Fill Buffer ${newSafeguards.fillPriceBufferPercent}%`);
    
    // Persist to database
    await settingsService.updateSafeguards(newSafeguards);
  }, [addActivity]);

  const toggleStrategy = useCallback(async (strategyId: string) => {
    const strategy = strategies.find(s => s.id === strategyId);
    if (!strategy) return;
    
    const newEnabled = !strategy.enabled;
    setStrategies(prev => prev.map(s =>
      s.id === strategyId ? { ...s, enabled: newEnabled } : s
    ));
    
    // Persist to database
    await settingsService.updateStrategyEnabled(strategyId, newEnabled);
  }, [strategies]);

  const addStrategy = useCallback(async (strategy: Omit<Strategy, 'id'>) => {
    // Save to database first to get proper ID
    const savedStrategy = await settingsService.addStrategy(strategy);
    
    if (savedStrategy) {
      setStrategies(prev => [...prev, savedStrategy]);
      addActivity('SYSTEM', `Strategy "${strategy.name}" created`);
    } else {
      // Fallback to local-only if DB fails
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
    
    // Delete from database
    await settingsService.deleteStrategy(strategyId);
  }, [strategies, addActivity]);

  /**
   * Journal a closed trade to the database
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
    try {
      const stratInfo = strategyPositions.get(position.symbol);
      const underlying = extractUnderlyingFromSymbol(position.symbol);
      
      // Determine open_side from position or strategy tracking
      // For options: positive cost_basis with short position = sold to open
      const positionSide = closeResult.positionDetails?.side;
      let openSide: string | undefined;
      if (positionSide === 'short') {
        openSide = 'sell_to_open';
      } else if (positionSide === 'long') {
        openSide = 'buy_to_open';
      } else if (position.costBasis < 0) {
        // Negative cost basis typically means credit received (sold to open)
        openSide = 'sell_to_open';
      } else if (position.costBasis > 0) {
        openSide = 'buy_to_open';
      }
      
      // Entry price per contract
      const entryPrice = Math.abs(position.costBasis) / (position.quantity * 100);
      
      // We don't have fill price yet - mark for reconciliation
      // The reconciliation job will backfill from Tradier fills
      const needsReconcile = true;
      
      const tradeRecord: Omit<TradeRecord, 'id'> = {
        symbol: position.symbol,
        underlying,
        strategy_name: stratInfo?.strategyName || position.strategyName,
        strategy_type: position.strategyType,
        quantity: closeResult.closeQty || position.quantity,
        entry_time: stratInfo?.entryTime?.toISOString() || position.entryTime?.toISOString() || new Date().toISOString(),
        exit_time: new Date().toISOString(),
        entry_price: entryPrice,
        exit_price: 0, // Will be backfilled by reconciliation
        entry_credit: stratInfo?.entryCredit,
        pnl: 0, // Will be recalculated after reconciliation
        pnl_percent: 0,
        exit_reason: exitReason,
        trade_group_id: undefined, // Could link multi-leg closes later
        open_side: openSide,
        close_side: closeResult.closeSide,
        close_order_id: closeResult.orderId,
        multiplier: 100,
        fees: 0, // Will be backfilled by reconciliation
        needs_reconcile: needsReconcile,
      };

      const saveResult = await tradeJournal.saveTrade(tradeRecord);
      
      if (saveResult.duplicate) {
        console.log('Trade already journaled (duplicate close_order_id):', position.symbol, closeResult.orderId);
      } else if (saveResult.success) {
        console.log('Trade journaled:', position.symbol, saveResult.id);
      } else {
        console.error('Failed to journal trade:', saveResult.error);
      }
    } catch (error) {
      console.error('Error journaling trade:', error);
    }
  }, [strategyPositions]);

  const closePosition = useCallback(async (positionId: string, exitReason: string = 'manual') => {
    const position = positions.find(p => p.id === positionId);
    if (!position) return false;

    if (pendingCloseSymbols.has(position.symbol)) {
      addActivity('SYSTEM', `SKIP: already pending close: ${position.symbol}`);
      return false;
    }

    const clientRequestId = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    console.log('CLOSE_REQUEST', { source: 'manual_ui', clientRequestId, symbol: position.symbol });

    addActivity('TRADE', `Closing position: ${position.symbol}`);

    const result = await tradierApi.closePosition(position.symbol, position.quantity, {
      dryRun: closeDebugOptions.dryRun,
      debug: closeDebugOptions.debug,
      clientRequestId,
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
      
      // Journal the trade immediately
      await journalClosedTrade(position, result, exitReason, 'manual_ui', clientRequestId);
      
      await fetchData();
      return true;
    }

    if (result.success && result.dryRun) {
      addActivity('SYSTEM', `Dry run computed for ${position.symbol} (no order sent)`);
      return true;
    }

    addActivity('RISK', `Failed to close ${position.symbol}: ${result.error}`);
    return false;
  }, [positions, pendingCloseSymbols, addActivity, fetchData, closeDebugOptions, journalClosedTrade]);

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

  // Run strategy engine when bot is running
  const runStrategyEngine = useCallback(async () => {
    if (!isBotRunning || riskStatus.killSwitchActive) return;
    
    // Throttle to once per 30 seconds
    const now = Date.now();
    if (now - lastEngineRun.current < 30000) return;
    lastEngineRun.current = now;

    try {
      addActivity('SYSTEM', 'Strategy engine scanning...');
      
      // Check for exit conditions first
      const exitResult = await strategyEngine.checkExits(strategies, positions);
      
      let placedAnyExitOrder = false;

      for (const exitSignal of exitResult.exitSignals) {
        const key = exitSignal.symbol;

        if (pendingCloseSymbols.has(key)) {
          addActivity('SYSTEM', `SKIP: already pending close: ${key}`);
          continue;
        }

        const nowTs = Date.now();
        const lastAttemptTs = lastCloseAttempt.current.get(key) || 0;

        // Frontend-side spam guard (edge function enforces the real lock/cooldown).
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
          
          // Journal the trade - find the position to get full details
          const position = positions.find(p => p.symbol === exitSignal.symbol);
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
        // Refresh positions so the next engine run doesn't keep trying to close legs that are already closing/closed.
        await fetchData();
      }
      // Then evaluate entry conditions
      const entryResult = await strategyEngine.evaluateStrategies(strategies, positions);
      
      if (entryResult.signals.length > 0) {
        for (const signal of entryResult.signals) {
          addActivity('TRADE', `Entry signal: ${signal.strategyName} - ${signal.underlying} $${signal.credit.toFixed(2)} credit`);
          
          // Auto-execute the signal
          const execResult = await strategyEngine.executeSignal(signal);
          
          if (execResult.success) {
            addActivity('TRADE', `Order placed: ${signal.strategyName} (Order #${execResult.orderId})`);
            setRiskStatus(prev => ({ ...prev, tradeCount: prev.tradeCount + 1 }));
            
            // Track the strategy position for each leg
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
        
        // Refresh positions after trades
        await fetchData();
      } else {
        addActivity('SYSTEM', 'No entry signals found');
      }
    } catch (error) {
      console.error('Strategy engine error:', error);
      addActivity('SYSTEM', `Engine error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }, [isBotRunning, riskStatus.killSwitchActive, strategies, positions, pendingCloseSymbols, closeDebugOptions, addActivity, fetchData, strategyPositions, journalClosedTrade]);

  // Load saved settings and strategies on mount
  useEffect(() => {
    const loadSavedData = async () => {
      try {
        // Load strategies
        const savedStrategies = await settingsService.getStrategies();
        if (savedStrategies.length > 0) {
          setStrategies(savedStrategies);
          addActivity('SYSTEM', `Loaded ${savedStrategies.length} saved strategies`);
        } else {
          // Use defaults if no saved strategies
          setStrategies(defaultStrategies);
          addActivity('SYSTEM', 'Using default strategies (none saved)');
        }
        
        // Load settings
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
              // Avoid duplicates
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

  // Initial fetch and polling
  useEffect(() => {
    fetchData();
    addActivity('SYSTEM', 'Dashboard connected - fetching market data');
    
    // Poll every 5 seconds when market is open
    const interval = setInterval(() => {
      fetchData();
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchData, addActivity]);

  // Run strategy engine when bot is running
  useEffect(() => {
    if (!isBotRunning) return;
    
    // Run immediately when bot starts
    runStrategyEngine();
    
    // Then run every 30 seconds
    const engineInterval = setInterval(runStrategyEngine, 30000);
    
    return () => clearInterval(engineInterval);
  }, [isBotRunning, runStrategyEngine]);

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
  };
};
