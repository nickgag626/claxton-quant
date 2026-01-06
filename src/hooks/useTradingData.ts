import { useState, useEffect, useCallback } from 'react';
import type { 
  Position, 
  Greeks, 
  Quote, 
  Strategy, 
  RiskStatus, 
  ActivityEvent,
  MarketState 
} from '@/types/trading';

// Mock data generator for demo purposes
const generateMockData = () => {
  const mockPositions: Position[] = [
    {
      id: '1',
      symbol: 'SPY250117P00580000',
      quantity: -2,
      costBasis: 1.45,
      currentValue: 1.12,
      expirationDate: '2025-01-17',
      strategyName: 'Iron Condor',
      underlying: 'SPY',
      entryCredit: 290,
      status: 'open',
      entryTime: new Date('2025-01-06T09:35:00'),
    },
    {
      id: '2',
      symbol: 'SPY250117C00595000',
      quantity: -2,
      costBasis: 1.32,
      currentValue: 0.98,
      expirationDate: '2025-01-17',
      strategyName: 'Iron Condor',
      underlying: 'SPY',
      entryCredit: 264,
      status: 'open',
      entryTime: new Date('2025-01-06T09:35:00'),
    },
    {
      id: '3',
      symbol: 'QQQ250110P00490000',
      quantity: -1,
      costBasis: 2.15,
      currentValue: 1.65,
      expirationDate: '2025-01-10',
      strategyName: 'Credit Put Spread',
      underlying: 'QQQ',
      entryCredit: 215,
      status: 'open',
      entryTime: new Date('2025-01-03T10:15:00'),
    },
  ];

  const mockGreeks: Greeks = {
    delta: -12.5,
    gamma: 0.0234,
    theta: 45.2,
    vega: -28.4,
  };

  const mockQuotes: Record<string, Quote> = {
    SPY: {
      symbol: 'SPY',
      last: 587.42,
      change: 2.34,
      changePercent: 0.40,
      bid: 587.40,
      ask: 587.44,
      volume: 45_230_100,
    },
    QQQ: {
      symbol: 'QQQ',
      last: 512.18,
      change: -1.56,
      changePercent: -0.30,
      bid: 512.15,
      ask: 512.21,
      volume: 28_450_200,
    },
  };

  const mockStrategies: Strategy[] = [
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

  const mockRiskStatus: RiskStatus = {
    dailyPnl: 342.50,
    maxDailyLoss: 1000,
    tradeCount: 3,
    maxPositions: 5,
    killSwitchActive: false,
  };

  const mockActivity: ActivityEvent[] = [
    {
      id: '1',
      timestamp: new Date(),
      type: 'BOT',
      message: 'Scanning for entry opportunities...',
    },
    {
      id: '2',
      timestamp: new Date(Date.now() - 60000),
      type: 'TRADE',
      message: 'Position SPY IC closed at 50% profit target',
    },
    {
      id: '3',
      timestamp: new Date(Date.now() - 120000),
      type: 'SYSTEM',
      message: 'Market opened - bot monitoring active',
    },
  ];

  return {
    positions: mockPositions,
    greeks: mockGreeks,
    quotes: mockQuotes,
    strategies: mockStrategies,
    riskStatus: mockRiskStatus,
    activity: mockActivity,
    marketState: 'open' as MarketState,
  };
};

export const useTradingData = () => {
  const [data, setData] = useState(generateMockData());
  const [isApiConnected, setIsApiConnected] = useState(true);
  const [isBotRunning, setIsBotRunning] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(new Date());

  // Simulate real-time updates
  useEffect(() => {
    const interval = setInterval(() => {
      setLastUpdate(new Date());
      // Slightly randomize values to simulate live data
      setData(prev => ({
        ...prev,
        riskStatus: {
          ...prev.riskStatus,
          dailyPnl: prev.riskStatus.dailyPnl + (Math.random() - 0.5) * 10,
        },
        greeks: {
          ...prev.greeks,
          delta: prev.greeks.delta + (Math.random() - 0.5) * 0.5,
          theta: prev.greeks.theta + (Math.random() - 0.5) * 0.2,
        },
        quotes: {
          SPY: {
            ...prev.quotes.SPY,
            last: prev.quotes.SPY.last + (Math.random() - 0.5) * 0.1,
            change: prev.quotes.SPY.change + (Math.random() - 0.5) * 0.05,
          },
          QQQ: {
            ...prev.quotes.QQQ,
            last: prev.quotes.QQQ.last + (Math.random() - 0.5) * 0.1,
            change: prev.quotes.QQQ.change + (Math.random() - 0.5) * 0.05,
          },
        },
      }));
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  const toggleBot = useCallback(() => {
    setIsBotRunning(prev => !prev);
    setData(prev => ({
      ...prev,
      activity: [
        {
          id: Date.now().toString(),
          timestamp: new Date(),
          type: 'BOT',
          message: isBotRunning ? 'Bot stopped by user' : 'Bot started by user',
        },
        ...prev.activity.slice(0, 9),
      ],
    }));
  }, [isBotRunning]);

  const toggleKillSwitch = useCallback(() => {
    const newStatus = !data.riskStatus.killSwitchActive;
    setData(prev => ({
      ...prev,
      riskStatus: {
        ...prev.riskStatus,
        killSwitchActive: newStatus,
        killSwitchReason: newStatus ? 'Manual activation from UI' : undefined,
      },
      activity: [
        {
          id: Date.now().toString(),
          timestamp: new Date(),
          type: 'RISK',
          message: newStatus ? 'Kill switch activated manually' : 'Kill switch deactivated',
        },
        ...prev.activity.slice(0, 9),
      ],
    }));
    if (newStatus) setIsBotRunning(false);
  }, [data.riskStatus.killSwitchActive]);

  const toggleStrategy = useCallback((strategyId: string) => {
    setData(prev => ({
      ...prev,
      strategies: prev.strategies.map(s =>
        s.id === strategyId ? { ...s, enabled: !s.enabled } : s
      ),
    }));
  }, []);

  return {
    ...data,
    isApiConnected,
    isBotRunning,
    lastUpdate,
    toggleBot,
    toggleKillSwitch,
    toggleStrategy,
  };
};
