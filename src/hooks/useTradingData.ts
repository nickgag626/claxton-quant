import { useState, useEffect, useCallback, useRef } from 'react';
import { tradierApi, calculatePortfolioGreeks } from '@/services/tradierApi';
import { strategyEngine } from '@/services/strategyEngine';
import type { 
  Position, 
  Greeks, 
  Quote, 
  Strategy, 
  RiskStatus, 
  ActivityEvent,
  MarketState 
} from '@/types/trading';
import type { DeltaDataPoint } from '@/components/dashboard/GreeksChart';

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
  const [strategies, setStrategies] = useState<Strategy[]>(defaultStrategies);
  const [riskStatus, setRiskStatus] = useState<RiskStatus>({
    dailyPnl: 0,
    maxDailyLoss: 1000,
    tradeCount: 0,
    maxPositions: 5,
    killSwitchActive: false,
  });
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [marketState, setMarketState] = useState<MarketState>('unknown');
  const [isApiConnected, setIsApiConnected] = useState(false);
  const [isBotRunning, setIsBotRunning] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deltaHistory, setDeltaHistory] = useState<DeltaDataPoint[]>([]);
  const lastEngineRun = useRef<number>(0);

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
      
      // Fetch positions
      const positionsData = await tradierApi.getPositions();
      setPositions(positionsData);
      
      // Fetch balances for P&L
      const balances = await tradierApi.getBalances();
      if (balances) {
        setRiskStatus(prev => ({
          ...prev,
          dailyPnl: balances.open_pl || 0,
        }));
      }
      
      // Fetch market clock
      const clock = await tradierApi.getMarketClock();
      setMarketState(clock.state);
      
      // Calculate Greeks from option positions
      if (positionsData.length > 0) {
        // Get unique underlyings from option positions
        const optionPositions = positionsData.filter(p => p.symbol.includes(' '));
        
        if (optionPositions.length > 0) {
          // Extract underlying symbols and get nearest expiration for each
          const underlyings = [...new Set(optionPositions.map(p => p.symbol.split(' ')[0]))];
          
          let allOptionData: any[] = [];
          
          for (const underlying of underlyings) {
            try {
              const expirations = await tradierApi.getOptionExpirations(underlying);
              if (expirations.length > 0) {
                // Get chain for nearest expiration to get greeks
                const chain = await tradierApi.getOptionChain(underlying, expirations[0]);
                allOptionData = [...allOptionData, ...chain];
              }
            } catch (err) {
              console.error(`Error fetching chain for ${underlying}:`, err);
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
  }, []);

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

  const toggleStrategy = useCallback((strategyId: string) => {
    setStrategies(prev => prev.map(s =>
      s.id === strategyId ? { ...s, enabled: !s.enabled } : s
    ));
  }, []);

  const addStrategy = useCallback((strategy: Omit<Strategy, 'id'>) => {
    const newStrategy: Strategy = {
      ...strategy,
      id: Date.now().toString(),
    };
    setStrategies(prev => [...prev, newStrategy]);
    addActivity('SYSTEM', `Strategy "${strategy.name}" created`);
  }, [addActivity]);

  const deleteStrategy = useCallback((strategyId: string) => {
    setStrategies(prev => {
      const strategy = prev.find(s => s.id === strategyId);
      if (strategy) {
        addActivity('SYSTEM', `Strategy "${strategy.name}" deleted`);
      }
      return prev.filter(s => s.id !== strategyId);
    });
  }, [addActivity]);

  const closePosition = useCallback(async (positionId: string) => {
    const position = positions.find(p => p.id === positionId);
    if (!position) return false;
    
    addActivity('TRADE', `Closing position: ${position.symbol}`);
    const result = await tradierApi.closePosition(position.symbol, position.quantity);
    
    if (result.success) {
      addActivity('TRADE', `Position closed: ${position.symbol} (Order #${result.orderId})`);
      fetchData();
      return true;
    } else {
      addActivity('RISK', `Failed to close ${position.symbol}: ${result.error}`);
      return false;
    }
  }, [positions, addActivity, fetchData]);

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
      
      for (const exitSignal of exitResult.exitSignals) {
        addActivity('TRADE', `Exit signal: ${exitSignal.symbol} - ${exitSignal.reason}`);
        const result = await tradierApi.closePosition(exitSignal.symbol, exitSignal.quantity);
        if (result.success) {
          addActivity('TRADE', `Position closed: ${exitSignal.symbol}`);
        }
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
  }, [isBotRunning, riskStatus.killSwitchActive, strategies, positions, addActivity, fetchData]);

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

  return {
    positions,
    greeks,
    quotes,
    strategies,
    riskStatus,
    activity,
    marketState,
    isApiConnected,
    isBotRunning,
    lastUpdate,
    isLoading,
    error,
    deltaHistory,
    toggleBot,
    toggleKillSwitch,
    toggleStrategy,
    addStrategy,
    deleteStrategy,
    closePosition,
    emergencyCloseAll,
    refetch: fetchData,
  };
};
