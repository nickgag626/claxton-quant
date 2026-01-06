import { useState, useEffect, useCallback } from 'react';
import { tradierApi } from '@/services/tradierApi';
import type { 
  Position, 
  Greeks, 
  Quote, 
  Strategy, 
  RiskStatus, 
  ActivityEvent,
  MarketState 
} from '@/types/trading';

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
      // Refresh positions
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
      await closePosition(position.id);
    }
    
    addActivity('EMERGENCY', 'Emergency close complete');
  }, [positions, closePosition, addActivity]);

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
