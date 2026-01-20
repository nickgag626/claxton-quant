import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { tradierApi, calculatePortfolioGreeks, parseOptionSymbol } from '@/services/tradierApi';
import { strategyEngine } from '@/services/strategyEngine';
import { tradeJournal, TradeRecord, ORDER_TIMEOUT_MS } from '@/services/tradeJournal';
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

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5;   // Consecutive failures before opening circuit
const CIRCUIT_BREAKER_RESET_MS = 60_000; // Time to reset after opening

// Jitter configuration - adds randomness to prevent thundering herd
const JITTER_MAX_PERCENT = 0.2;        // Max 20% jitter

/**
 * Add jitter to an interval to prevent synchronized polling across instances.
 * Returns the interval plus or minus up to JITTER_MAX_PERCENT.
 */
function addJitter(intervalMs: number): number {
  const jitterRange = intervalMs * JITTER_MAX_PERCENT;
  const jitter = (Math.random() - 0.5) * 2 * jitterRange;
  return Math.round(intervalMs + jitter);
}

/**
 * Circuit breaker state manager.
 * Opens circuit after consecutive failures, resets after timeout.
 */
interface CircuitBreakerState {
  consecutiveFailures: number;
  isOpen: boolean;
  lastFailureTime: number;
  lastOpenTime: number;
}

const createCircuitBreaker = () => {
  const state: CircuitBreakerState = {
    consecutiveFailures: 0,
    isOpen: false,
    lastFailureTime: 0,
    lastOpenTime: 0,
  };

  return {
    recordSuccess: () => {
      state.consecutiveFailures = 0;
      state.isOpen = false;
    },
    recordFailure: () => {
      state.consecutiveFailures++;
      state.lastFailureTime = Date.now();
      if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        state.isOpen = true;
        state.lastOpenTime = Date.now();
        console.warn(`[CIRCUIT_BREAKER] Circuit OPENED after ${state.consecutiveFailures} failures`);
      }
    },
    shouldAllow: (): boolean => {
      if (!state.isOpen) return true;
      // Check if enough time has passed to try again
      if (Date.now() - state.lastOpenTime > CIRCUIT_BREAKER_RESET_MS) {
        console.log('[CIRCUIT_BREAKER] Reset timeout passed, allowing half-open request');
        return true; // Half-open state - allow one request through
      }
      return false;
    },
    isOpen: () => state.isOpen,
    getState: () => ({ ...state }),
  };
};

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
 * Uses DETERMINISTIC ALLOCATION: for each symbol, allocate broker qty to group mappings
 * in order of created_at (oldest first). This handles stacked entries correctly.
 * Falls back to STRICT heuristic grouping only if group forms valid 4L iron condor.
 * Otherwise marks positions as ungrouped (requires reconcile).
 */
async function enrichPositionsWithGroupIds(positions: Position[]): Promise<Position[]> {
  if (positions.length === 0) return positions;

  const symbols = positions.map(p => p.symbol);
  
  try {
    // === SOURCE OF TRUTH: Fetch from position_group_map (set at entry time) ===
    // Order by created_at ASC for deterministic allocation (oldest entries first)
    const { data: groupMaps, error: mapError } = await supabase
      .from('position_group_map')
      .select('symbol, trade_group_id, strategy_name, strategy_type, leg_qty, leg_side, created_at, open_order_id')
      .in('symbol', symbols)
      .order('created_at', { ascending: true });

    if (mapError) {
      console.error('Error fetching position_group_map:', mapError);
    }

    // Build symbol -> array of group mappings (ordered by created_at ASC)
    const symbolToMappings = new Map<string, Array<{
      tradeGroupId: string;
      strategyName?: string;
      strategyType?: string;
      legQty: number;
      legSide?: string;
      openOrderId: string;
      createdAt: string;
    }>>();
    
    if (groupMaps) {
      groupMaps.forEach((row: any) => {
        if (row.trade_group_id) {
          const existing = symbolToMappings.get(row.symbol) || [];
          existing.push({
            tradeGroupId: row.trade_group_id,
            strategyName: row.strategy_name,
            strategyType: row.strategy_type,
            legQty: row.leg_qty || 1,
            legSide: row.leg_side,
            openOrderId: row.open_order_id,
            createdAt: row.created_at,
          });
          symbolToMappings.set(row.symbol, existing);
        }
      });
    }
    
    // Count total mapped qty per symbol for debugging
    const totalMappedBySymbol = new Map<string, number>();
    symbolToMappings.forEach((mappings, symbol) => {
      totalMappedBySymbol.set(symbol, mappings.reduce((sum, m) => sum + m.legQty, 0));
    });
    
    console.log(`[enrichPositionsWithGroupIds] Found mappings for ${symbolToMappings.size}/${symbols.length} symbols`);

    // === DETERMINISTIC ALLOCATION: Distribute broker qty to groups oldest-first ===
    // For each broker position, allocate its quantity to group mappings in order
    // This creates "virtual" position records for each allocation
    const allocatedPositions: Position[] = [];
    
    for (const pos of positions) {
      const mappings = symbolToMappings.get(pos.symbol);
      
      if (!mappings || mappings.length === 0) {
        // No mapping found - leave as ungrouped
        allocatedPositions.push(pos);
        continue;
      }
      
      // Total broker quantity (absolute value for allocation)
      let remainingQty = Math.abs(pos.quantity);
      const qtySign = pos.quantity < 0 ? -1 : 1;
      
      // Calculate total mapped qty for this symbol
      const totalMappedQty = mappings.reduce((sum, m) => sum + m.legQty, 0);
      
      if (mappings.length === 1) {
        // Single mapping - straightforward assignment
        const mapping = mappings[0];
        allocatedPositions.push({
          ...pos,
          tradeGroupId: mapping.tradeGroupId,
          strategyName: pos.strategyName || mapping.strategyName,
          strategyType: pos.strategyType || mapping.strategyType,
        });
      } else if (totalMappedQty === remainingQty) {
        // Mapped qty matches broker qty exactly - split into separate position entries
        for (const mapping of mappings) {
          if (mapping.legQty <= 0) continue;
          
          // Pro-rata cost/value allocation
          const fraction = mapping.legQty / totalMappedQty;
          
          allocatedPositions.push({
            ...pos,
            // Create unique ID for each allocation
            id: `${pos.id}-${mapping.openOrderId}`,
            quantity: qtySign * mapping.legQty,
            costBasis: pos.costBasis * fraction,
            currentValue: pos.currentValue * fraction,
            tradeGroupId: mapping.tradeGroupId,
            strategyName: pos.strategyName || mapping.strategyName,
            strategyType: pos.strategyType || mapping.strategyType,
          });
        }
      } else {
        // Mismatch - use SMART ALLOCATION: newest-first when overflow (stale mappings), oldest-first otherwise
        const isOverflow = totalMappedQty > remainingQty;
        
        if (isOverflow) {
          // OVERFLOW: More mappings than broker qty → stale mappings exist
          // Allocate NEWEST-FIRST so current positions get assigned to most recent trade groups
          console.log(`[enrichPositionsWithGroupIds] ⚠️ OVERFLOW for ${pos.symbol}: broker=${remainingQty}, mapped=${totalMappedQty} → allocating NEWEST-FIRST (${totalMappedQty - remainingQty} stale mappings)`);
          mappings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        } else {
          // UNDERFLOW: Broker has more than mapped → allocate oldest-first, remainder is orphan
          console.log(`[enrichPositionsWithGroupIds] Qty mismatch for ${pos.symbol}: broker=${remainingQty}, mapped=${totalMappedQty}`);
        }
        
        for (const mapping of mappings) {
          if (remainingQty <= 0) break;
          
          const allocQty = Math.min(mapping.legQty, remainingQty);
          if (allocQty <= 0) continue;
          
          const fraction = allocQty / Math.abs(pos.quantity);
          
          allocatedPositions.push({
            ...pos,
            id: `${pos.id}-${mapping.openOrderId}`,
            quantity: qtySign * allocQty,
            costBasis: pos.costBasis * fraction,
            currentValue: pos.currentValue * fraction,
            tradeGroupId: mapping.tradeGroupId,
            strategyName: pos.strategyName || mapping.strategyName,
            strategyType: pos.strategyType || mapping.strategyType,
          });
          
          remainingQty -= allocQty;
        }
        
        // Any remaining qty is ungrouped (requires manual reconcile) - only when broker has more than mapped
        if (remainingQty > 0 && !isOverflow) {
          const fraction = remainingQty / Math.abs(pos.quantity);
          allocatedPositions.push({
            ...pos,
            id: `${pos.id}-orphan`,
            quantity: qtySign * remainingQty,
            costBasis: pos.costBasis * fraction,
            currentValue: pos.currentValue * fraction,
            // No tradeGroupId - will be detected as broken/ungrouped
          });
        }
      }
    }

    // === STRICT HEURISTIC FALLBACK: Only for positions not in DB ===
    // Group ungrouped positions by heuristic key
    const ungroupedByHeuristic = new Map<string, Position[]>();
    
    allocatedPositions.forEach(pos => {
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
    return allocatedPositions.map(pos => {
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
      minPremium: 0.75, // REQUIRED: Prevents tiny credits that cause random exits
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
      minPremium: 1.00, // REQUIRED: Prevents tiny credits that cause random exits
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
  const [lastCheckExitsTime, setLastCheckExitsTime] = useState<Date | null>(null);
  const [exitStatusMap, setExitStatusMap] = useState<Map<string, {
    pnlPercent: number;
    profitTargetPercent: number;
    stopLossPercent: number;
    dte?: number;
    timeStopDte?: number;
    triggered: boolean;
    reason: string | null;
    blockedReason?: string;
  }>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deltaHistory, setDeltaHistory] = useState<DeltaDataPoint[]>([]);
  
  // === STRUCTURE INTEGRITY GATE: Entry block when broken structures exist ===
  const [entryBlockedReason, setEntryBlockedReason] = useState<string | null>(null);
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

  // Circuit breaker for API failures - prevents hammering failed endpoints
  const circuitBreaker = useRef(createCircuitBreaker());

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

    // Circuit breaker check - skip if circuit is open
    if (!circuitBreaker.current.shouldAllow()) {
      console.log('[FAST_LOOP] Circuit breaker open, skipping fetch');
      return;
    }

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
      circuitBreaker.current.recordSuccess();
    } catch (err) {
      console.error('Error in fast fetch:', err);
      // Apply backoff on error (for 429/5xx)
      backoffMultiplier.current = Math.min(backoffMultiplier.current * 2, BACKOFF_MAX_INTERVAL / FAST_POLL_INTERVAL);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      setIsApiConnected(false);
      circuitBreaker.current.recordFailure();
    } finally {
      fastLoopInFlight.current = false;
    }
  }, []);

  // === SLOW LOOP: Positions + Balances + Chains/Greeks ===
  const fetchSlowData = useCallback(async (forceChains = false) => {
    if (slowLoopInFlight.current) return;

    // Circuit breaker check - skip if circuit is open
    if (!circuitBreaker.current.shouldAllow()) {
      console.log('[SLOW_LOOP] Circuit breaker open, skipping fetch');
      return;
    }

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
      circuitBreaker.current.recordSuccess();
    } catch (err) {
      console.error('Error in slow fetch:', err);
      backoffMultiplier.current = Math.min(backoffMultiplier.current * 2, BACKOFF_MAX_INTERVAL / SLOW_POLL_INTERVAL);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      setIsApiConnected(false);
      circuitBreaker.current.recordFailure();
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

  const toggleBot = useCallback(async () => {
    const newState = !isBotRunning;
    setIsBotRunning(newState);
    addActivity('BOT', newState ? 'Bot started by user' : 'Bot stopped by user');
    
    // Run cleanup on bot start
    if (newState) {
      try {
        const cleanupResult = await strategyEngine.cleanupMaps();
        if (cleanupResult.deletedCount > 0) {
          addActivity('SYSTEM', `Cleaned up ${cleanupResult.deletedCount} stale position mappings`);
        }
      } catch (err) {
        console.error('[toggleBot] Cleanup failed:', err);
      }
    }
  }, [isBotRunning, addActivity]);

  /**
   * Purge stale mappings aggressively (no 24h cutoff).
   * Deletes all position_group_map entries for symbols not currently at broker.
   */
  const purgeStaleMappings = useCallback(async (): Promise<{ deletedCount: number }> => {
    try {
      addActivity('SYSTEM', 'Purging stale position mappings...');
      const result = await strategyEngine.cleanupMaps(true); // aggressive=true
      if (result.deletedCount > 0) {
        addActivity('SYSTEM', `✓ Purged ${result.deletedCount} stale mappings`);
        toast({
          title: "Mappings Purged",
          description: `Removed ${result.deletedCount} stale mapping entries. Refresh positions to see corrected grouping.`,
        });
        // Refresh positions to re-run enrichment with clean mappings
        await fetchData();
      } else {
        addActivity('SYSTEM', 'No stale mappings found to purge');
        toast({
          title: "No Stale Mappings",
          description: "All position mappings are current.",
        });
      }
      return { deletedCount: result.deletedCount };
    } catch (err) {
      console.error('[purgeStaleMappings] Error:', err);
      addActivity('SYSTEM', `Purge failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      return { deletedCount: 0 };
    }
  }, [addActivity, fetchData]);
  
  /**
   * Clear entry block manually after user intervention.
   * Called when user has resolved broken structures or partial fills.
   */
  const clearEntryBlock = useCallback(() => {
    setEntryBlockedReason(null);
    addActivity('SYSTEM', 'Entry block cleared by user - entries resumed');
    toast({
      title: "Entries Resumed",
      description: "Manual entry block has been cleared. Bot will resume normal operations.",
    });
  }, [addActivity]);
  
  /**
   * Check structure integrity of current positions.
   * Returns { healthy, brokenGroups, orphanSymbols, reason }.
   * Used to gate new entries when broken structures exist.
   */
  const checkStructureIntegrity = useCallback((): { 
    healthy: boolean; 
    brokenGroups: { groupId: string; expected: number; observed: number; strategyType: string }[]; 
    orphanSymbols: string[];
    reason: string;
  } => {
    const brokenGroups: { groupId: string; expected: number; observed: number; strategyType: string }[] = [];
    const orphanSymbols: string[] = [];
    
    // Check for orphans (positions with IDs ending in '-orphan' from allocation mismatch)
    for (const pos of positions) {
      if (pos.id.endsWith('-orphan')) {
        orphanSymbols.push(pos.symbol);
      }
    }
    
    // Check for broken groups (observed legs < expected legs)
    const groupedPositions = new Map<string, Position[]>();
    for (const pos of positions.filter(p => p.tradeGroupId)) {
      const group = groupedPositions.get(pos.tradeGroupId!) || [];
      group.push(pos);
      groupedPositions.set(pos.tradeGroupId!, group);
    }
    
    for (const [groupId, groupLegs] of groupedPositions) {
      const strategyType = groupLegs[0]?.strategyType;
      const expected = expectedLegCount(strategyType);
      if (expected !== null && groupLegs.length < expected) {
        brokenGroups.push({ 
          groupId, 
          expected, 
          observed: groupLegs.length,
          strategyType: strategyType || 'unknown',
        });
      }
    }
    
    const healthy = brokenGroups.length === 0 && orphanSymbols.length === 0;
    const reason = healthy ? '' : 
      `${brokenGroups.length} broken group(s), ${orphanSymbols.length} orphan position(s)`;
    
    return { healthy, brokenGroups, orphanSymbols, reason };
  }, [positions]);

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

  // Get exit status for a position (by group ID or symbol)
  const getExitStatus = useCallback((position: Position) => {
    // Try group ID first, fall back to symbol
    const key = position.tradeGroupId || position.symbol;
    return exitStatusMap.get(key);
  }, [exitStatusMap]);

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
    forceBrokenStructure?: boolean; // Allow closing broken structures when explicitly confirmed
    forceClose?: boolean; // Bypass spread safety check (for emergency closes)
  }): Promise<boolean> => {
    const { source, exitReason, tradeGroupId, symbol, forceBrokenStructure, forceClose } = params;

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

      // Block broken structures UNLESS:
      // - legOutMode is enabled, OR
      // - forceBrokenStructure is true (user explicitly confirmed), OR
      // - source is 'emergency'
      if (!legOutModeEnabled && !forceBrokenStructure && source !== 'emergency' && expected !== null && observed < expected) {
        logAttempt('blocked', { reason: 'Broken structure — enable Leg Out Mode or confirm close', expected, observed });
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
          forceClose: forceClose || source === 'emergency', // Always bypass spread check for emergency closes
        });

        if (result.skipped) {
          logAttempt('blocked', { reason: result.error || 'cooldown/lock', clientRequestId });
          return false;
        }

        // Handle spread safety gate blocking
        if (result.blocked && result.blockReason === 'wide_spread') {
          const spreadDesc = result.spreadIssues?.map(s => `${s.symbol}: ${s.spreadPercent}%`).join(', ') || 'unknown';
          logAttempt('blocked', { reason: `Wide spread: ${spreadDesc}`, clientRequestId, spreadIssues: result.spreadIssues });
          addActivity('RISK', `EXIT BLOCKED: Bid/ask spread too wide (${spreadDesc}). Use emergency close to override.`);
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

          // Phase 4: Delete mappings for this group to prevent stale accumulation
          // Schedule async deletion (don't block the UI)
          strategyEngine.deleteGroupMappings(tradeGroupId).then(deleteResult => {
            if (deleteResult.deletedCount > 0) {
              console.log(`[requestClose] Cleaned up ${deleteResult.deletedCount} mapping rows for group ${tradeGroupId}`);
            }
          }).catch(err => {
            console.error('[requestClose] Failed to delete group mappings:', err);
          });

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
        forceClose: forceClose || source === 'emergency', // Always bypass spread check for emergency closes
      });

      setLastCloseDebug({ source, clientRequestId, symbol: position.symbol, result, edgeDebug: result.debug });

      if (result.skipped) {
        logAttempt('blocked', { reason: result.error || 'cooldown/lock', clientRequestId });
        return false;
      }

      // Handle spread safety gate blocking
      if (result.blocked && result.blockReason === 'wide_spread') {
        const spreadDesc = result.spreadIssues?.map(s => `${s.symbol}: ${s.spreadPercent}%`).join(', ') || 'unknown';
        logAttempt('blocked', { reason: `Wide spread: ${spreadDesc}`, clientRequestId, spreadIssues: result.spreadIssues });
        addActivity('RISK', `EXIT BLOCKED: Bid/ask spread too wide (${spreadDesc}). Use emergency close to override.`);
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
   * @param forceBrokenStructure - If true, allows closing even if structure is broken
   */
  const closeGroup = useCallback(async (
    tradeGroupId: string, 
    exitReason: string = 'manual',
    forceBrokenStructure: boolean = false
  ): Promise<boolean> => {
    return requestClose({ source: 'manual', exitReason, tradeGroupId, forceBrokenStructure });
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

      // Update heartbeat timestamp for monitoring
      setLastCheckExitsTime(new Date());

      // Store exit status for UI visibility (shows why positions aren't exiting)
      if (exitResult.exitStatus) {
        const newMap = new Map<string, typeof exitStatusMap extends Map<string, infer V> ? V : never>();
        for (const status of exitResult.exitStatus) {
          // Key by tradeGroupId or symbol for ungrouped
          const key = status.tradeGroupId || status.symbol;
          newMap.set(key, {
            pnlPercent: status.pnlPercent,
            profitTargetPercent: status.profitTargetPercent,
            stopLossPercent: status.stopLossPercent,
            dte: status.dte,
            timeStopDte: status.timeStopDte,
            triggered: status.triggered,
            reason: status.reason,
            blockedReason: status.blockedReason,
          });
        }
        setExitStatusMap(newMap);
      }

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

      // === PRE-ENTRY STRUCTURE INTEGRITY GATE ===
      // Check if there are any broken structures or orphan positions
      // If so, block ALL new entries until manually resolved
      
      // First check if we have a manual entry block
      if (entryBlockedReason) {
        addActivity('RISK', 
          `⛔ ENTRY BLOCKED: ${entryBlockedReason}. ` +
          `Clear entry block before new entries.`
        );
        return;
      }
      
      // Then check structure integrity
      const integrity = checkStructureIntegrity();

      if (!integrity.healthy) {
        // SET THE STATE SO UI WARNING APPEARS
        setEntryBlockedReason(integrity.reason);
        
        addActivity('RISK', 
          `⛔ ENTRY GATE BLOCKED: ${integrity.reason}. ` +
          `Resolve broken structures before new entries.`
        );
        toast({
          title: "🚨 Entries Halted - Structure Integrity",
          description: `Bot detected ${integrity.brokenGroups.length} broken groups and ` +
            `${integrity.orphanSymbols.length} orphan positions. Manual intervention required.`,
          variant: "destructive",
          duration: 15000,
        });
        // Skip all entry signals this cycle
        return;
      }

      const entryResult = await strategyEngine.evaluateStrategies(strategies, positions);

      if (entryResult.signals.length > 0) {
        for (const signal of entryResult.signals) {
          addActivity('TRADE', `Entry signal: ${signal.strategyName} - ${signal.underlying} $${signal.credit.toFixed(2)} credit`);

          // === VERIFIED ENTRY: Server handles 60s verification + bail-out ===
          addActivity('TRADE', `Submitting verified entry: ${signal.strategyName} (60s fill window)`);
          const execResult = await strategyEngine.executeSignal(signal);

          if (execResult.success && execResult.verified) {
            // Fully verified - all legs confirmed
            addActivity('TRADE', `✅ Entry verified: ${signal.strategyName} (Order #${execResult.orderId}) - All legs filled`);
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
          } else if (execResult.critical) {
            // CRITICAL: Partial fill with automatic bail-out
            const filled = execResult.filledLegs?.length || 0;
            const missing = execResult.missingLegs?.length || 0;
            const bailOutCount = execResult.bailOutOrders?.filter((o: any) => o.orderId)?.length || 0;
            
            addActivity('RISK', 
              `🚨 CRITICAL AUTO-RECONCILE: ${signal.strategyName} Order #${execResult.orderId}. ` +
              `${filled} filled, ${missing} missing. ${bailOutCount} bail-out orders placed.`
            );
            
            toast({
              title: "🚨 CRITICAL: Partial Fill - Auto Bail-Out Executed",
              description: `Order ${execResult.orderId} only filled ${filled}/${filled + missing} legs.\n\n` +
                `Missing: ${execResult.missingLegs?.join(', ') || 'unknown'}\n\n` +
                `${bailOutCount} bail-out close orders placed automatically.\n\n` +
                `Bot entries are HALTED. Manual review required.`,
              variant: "destructive",
              duration: 60000, // Keep visible for 1 minute
            });
            
            // Set critical block flag
            setEntryBlockedReason(
              `CRITICAL AUTO-RECONCILE: Order ${execResult.orderId} - ` +
              `${missing} leg(s) missing, ${bailOutCount} bail-out orders placed`
            );
            
            // Stop processing more entries this cycle
            await fetchData();
            return;
          } else if (execResult.blocked === 'cooldown') {
            addActivity('RISK', `Entry blocked (cooldown): ${signal.strategyName} - wait 2 minutes`);
            toast({
              title: "Entry Blocked - Cooldown",
              description: `${signal.strategyName} entry blocked due to recent rejection. Wait 2 minutes before retry.`,
              variant: "destructive",
            });
          } else if (execResult.blocked === 'conflict') {
            const conflictSymbols = execResult.conflict_symbols?.join(', ') || 
              execResult.conflicts?.map((c: any) => c.symbol).join(', ') || 'unknown';
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
  }, [isBotRunning, riskStatus.killSwitchActive, strategies, positions, addActivity, fetchData, strategyPositions, requestClose, getGroupPositions, checkStructureIntegrity, entryBlockedReason]);

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

    // Fast loop: clock + quotes (with jitter to prevent thundering herd)
    const fastIntervalWithJitter = addJitter(FAST_POLL_INTERVAL);
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
    }, fastIntervalWithJitter);

    // Slow loop: positions + balances + chains (with jitter)
    const slowIntervalWithJitter = addJitter(SLOW_POLL_INTERVAL);
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
    }, slowIntervalWithJitter);

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
    
    // === AUTO CLEANUP: Every 5 minutes while bot is running ===
    const AUTO_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    let lastAutoCleanup = Date.now();
    
    const cleanupInterval = setInterval(async () => {
      const now = Date.now();
      if (now - lastAutoCleanup >= AUTO_CLEANUP_INTERVAL_MS) {
        lastAutoCleanup = now;
        try {
          console.log('[AUTO_CLEANUP] Running 5-minute stale mapping cleanup...');
          const result = await strategyEngine.cleanupMaps(true); // aggressive mode
          if (result.deletedCount > 0) {
            addActivity('SYSTEM', `Auto cleanup: deleted ${result.deletedCount} stale mappings`);
          }
        } catch (err) {
          console.error('[AUTO_CLEANUP] Error:', err);
        }
      }
    }, 60000); // Check every minute if cleanup is due

    return () => {
      clearInterval(engineInterval);
      clearInterval(cleanupInterval);
    };
  }, [isBotRunning, runStrategyEngine, addActivity]);

  // Background task: Poll pending close orders and update their status
  useEffect(() => {
    const reconcilePendingCloses = async () => {
      try {
        // Get trades with pending close status
        const pendingTrades = await tradeJournal.getTradesWithPendingClose();
        
        if (pendingTrades.length === 0) return;
        
        console.log('[reconcilePendingCloses] Found', pendingTrades.length, 'pending close orders');
        
        // Group trades by close_order_id to detect multi-leg combo orders
        const orderGroups = new Map<string, typeof pendingTrades>();
        for (const trade of pendingTrades) {
          if (!trade.close_order_id) continue;
          const existing = orderGroups.get(trade.close_order_id) || [];
          existing.push(trade);
          orderGroups.set(trade.close_order_id, existing);
        }
        
        // Process each unique close order
        for (const [closeOrderId, tradesInOrder] of orderGroups) {
          // Check for order timeout FIRST - if order has been pending too long
          const firstTrade = tradesInOrder[0];
          const submittedAt = firstTrade?.close_submitted_at
            ? new Date(firstTrade.close_submitted_at).getTime()
            : 0;
          const elapsedMs = submittedAt > 0 ? Date.now() - submittedAt : 0;
          const isTimedOut = elapsedMs > ORDER_TIMEOUT_MS;

          const orderStatus = await tradierApi.getOrderStatus(closeOrderId);

          if (!orderStatus.success) {
            // If we can't fetch status AND it's been too long, mark as timeout_unknown
            if (isTimedOut) {
              console.warn('[reconcilePendingCloses] Order', closeOrderId, 'timed out after', Math.round(elapsedMs / 1000), 's - marking as timeout_unknown');
              await tradeJournal.updateCloseStatus(closeOrderId, 'timeout_unknown', {
                rejectReason: `Order status unknown after ${Math.round(elapsedMs / 1000)}s - API fetch failed`,
              });
              addActivity('RISK', `⚠️ Order timeout: ${firstTrade?.symbol || closeOrderId} - status unknown after ${Math.round(elapsedMs / 1000)}s`);
              toast({
                title: '⚠️ Order Timeout Detected',
                description: `Close order for ${firstTrade?.symbol || closeOrderId} has been pending for ${Math.round(elapsedMs / 1000)}s. Status unknown - manual verification required.`,
                variant: 'destructive',
                duration: 15000,
              });
            } else {
              console.warn('[reconcilePendingCloses] Could not fetch status for', closeOrderId);
            }
            continue;
          }

          // If Tradier still shows 'submitted' but we've exceeded timeout, mark as timeout_unknown
          if (orderStatus.closeStatus === 'submitted' && isTimedOut) {
            console.warn('[reconcilePendingCloses] Order', closeOrderId, 'still submitted after', Math.round(elapsedMs / 1000), 's - marking as timeout_unknown');
            await tradeJournal.updateCloseStatus(closeOrderId, 'timeout_unknown', {
              rejectReason: `Order still pending after ${Math.round(elapsedMs / 1000)}s - manual verification required`,
            });
            addActivity('RISK', `⚠️ Order timeout: ${firstTrade?.symbol || closeOrderId} - still pending after ${Math.round(elapsedMs / 1000)}s`);
            toast({
              title: '⚠️ Order Timeout Detected',
              description: `Close order for ${firstTrade?.symbol || closeOrderId} has been pending for ${Math.round(elapsedMs / 1000)}s. Please verify manually in Tradier.`,
              variant: 'destructive',
              duration: 15000,
            });
            continue;
          }

          // Only update if status has changed from 'submitted'
          if (orderStatus.closeStatus !== 'submitted') {
            // Detect if this is a multi-leg combo order based on number of trades sharing same close_order_id
            const isComboOrder = tradesInOrder.length > 1;
            
            const updateResult = await tradeJournal.updateCloseStatus(
              closeOrderId,
              orderStatus.closeStatus,
              {
                avgFillPrice: orderStatus.avgFillPrice, // For combo: this is net debit
                filledQty: orderStatus.filledQty,
                rejectReason: orderStatus.rejectReason,
                open_side: tradesInOrder[0]?.open_side,
                fees: 0,
                isComboOrder, // Signal to use group P&L calculation
              }
            );
            
            if (updateResult.success) {
              console.log('[reconcilePendingCloses] Updated', closeOrderId, 'to', orderStatus.closeStatus, 
                isComboOrder ? `(combo, groupPnl: $${updateResult.groupPnl?.toFixed(2) || '?'})` : '(single)');
              
              if (orderStatus.closeStatus === 'filled') {
                if (isComboOrder && updateResult.groupPnl !== undefined) {
                  addActivity('TRADE', `Group close filled: ${tradesInOrder.length} legs @ $${orderStatus.avgFillPrice?.toFixed(2) || '?'} net debit, P&L: $${updateResult.groupPnl.toFixed(2)}`);
                } else {
                  addActivity('TRADE', `Trade filled: ${tradesInOrder[0]?.symbol} @ $${orderStatus.avgFillPrice?.toFixed(2) || '?'}`);
                }
              } else if (orderStatus.closeStatus === 'rejected' || orderStatus.closeStatus === 'canceled' || orderStatus.closeStatus === 'expired') {
                addActivity('RISK', `Close ${orderStatus.closeStatus}: ${tradesInOrder[0]?.symbol} - ${orderStatus.rejectReason || 'Unknown'}`);
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
    lastCheckExitsTime,
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
    getExitStatus,

    // === STRUCTURE INTEGRITY GATE ===
    entryBlockedReason,
    clearEntryBlock,
    checkStructureIntegrity,
    
    // === MAPPING MAINTENANCE ===
    purgeStaleMappings,
  };
};
