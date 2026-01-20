import { motion } from 'framer-motion';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { X, Layers, AlertTriangle, RefreshCw, ChevronDown, ChevronRight, ShieldOff, ShieldCheck, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Position } from '@/types/trading';
import { useState, useMemo } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { 
  computeGroupHealth, 
  strategyDisplayName, 
  type GroupHealthInfo 
} from '@/lib/strategyLegs';

// Exit status info from strategy engine
interface ExitStatusInfo {
  pnlPercent: number;
  profitTargetPercent: number;
  stopLossPercent: number;
  dte?: number;
  timeStopDte?: number;
  triggered: boolean;
  reason: string | null;
  blockedReason?: string;
}

interface PositionsPanelProps {
  positions: Position[];
  isApiConnected: boolean;
  onClosePosition?: (positionId: string) => Promise<boolean>;
  onCloseGroup?: (tradeGroupId: string, exitReason?: string, forceBrokenStructure?: boolean) => Promise<boolean>;
  legOutModeEnabled?: boolean;
  onLegOutModeChange?: (enabled: boolean) => void;
  isGroupedPosition?: (position: Position) => boolean;
  getGroupPositions?: (tradeGroupId: string | undefined) => Position[];
  getExitStatus?: (position: Position) => ExitStatusInfo | undefined;
  dtbpRejection?: {
    symbol: string;
    tradeGroupId: string;
    rejectReason: string;
    timestamp: number;
  } | null;
  onRetryCloseAsGroup?: () => Promise<boolean>;
  // Structure Integrity Gate
  entryBlockedReason?: string | null;
  onClearEntryBlock?: () => void;
  // Mapping maintenance
  onPurgeStaleMappings?: () => Promise<{ deletedCount: number }>;
}

interface GroupedPositionInfo {
  tradeGroupId: string;
  positions: Position[];
  underlying: string;
  strategyType: string | null;
  strategyName: string | null;
  health: GroupHealthInfo;
  totalPnl: number;
  nearestDte: number | null;
  exitStatus?: ExitStatusInfo;
}

const computeDte = (expirationDate?: string): number | null => {
  if (!expirationDate) return null;
  const exp = new Date(expirationDate);
  const today = new Date();
  const diffTime = exp.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
};

/**
 * Compute unrealized P&L for a position.
 * Tradier's cost_basis and our currentValue are TOTAL DOLLARS (already include qty × multiplier).
 * For short positions: both values are negative, so pnl = cost_basis - currentValue
 *   e.g., sold for -$38, now worth -$34.50 → pnl = -38 - (-34.50) = -$3.50... 
 *   But Tradier convention: sold at $38 credit, now costs $34.50 to close = +$3.50 gain
 * Canonical formula: pnl = -(currentValue - costBasis) for shorts, = currentValue - costBasis for longs
 * Since Tradier uses signed values, simpler: pnl = costBasis - currentValue (works for both)
 *   Short: costBasis=-38, currentValue=-34.50 → -38 - (-34.50) = -3.50 (loss? no...)
 * Actually for shorts: we RECEIVED credit (positive economic value), current liability is market value
 *   Gain = |costBasis| - |currentValue| when short
 * Let's use: for shorts, gain when currentValue < costBasis (both negative means |cv| < |cb|)
 */
const computePnl = (position: Position): number => {
  // costBasis and currentValue are signed total dollars from Tradier
  // Short: costBasis negative (credit received), currentValue negative (cost to close)
  // Long: costBasis positive (debit paid), currentValue positive (current worth)
  // P&L = currentValue - costBasis works correctly:
  //   Short sold at -38, now -34.50: -34.50 - (-38) = +3.50 gain ✓
  //   Long bought at +50, now +60: 60 - 50 = +10 gain ✓
  return position.currentValue - position.costBasis;
};

export const PositionsPanel = ({
  positions,
  isApiConnected,
  onClosePosition,
  onCloseGroup,
  legOutModeEnabled = false,
  onLegOutModeChange,
  isGroupedPosition,
  getGroupPositions,
  getExitStatus,
  dtbpRejection,
  onRetryCloseAsGroup,
  entryBlockedReason,
  onClearEntryBlock,
  onPurgeStaleMappings,
}: PositionsPanelProps) => {
  const [closingPositions, setClosingPositions] = useState<Set<string>>(new Set());
  const [closingGroups, setClosingGroups] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [brokenCloseConfirm, setBrokenCloseConfirm] = useState<GroupedPositionInfo | null>(null);
  const [isPurging, setIsPurging] = useState(false);
  
  const handleClose = async (positionId: string) => {
    console.log('handleClose called with positionId:', positionId);
    console.log('onClosePosition exists:', !!onClosePosition);
    if (!onClosePosition) {
      console.log('onClosePosition is not defined, returning early');
      return;
    }
    setClosingPositions(prev => new Set(prev).add(positionId));
    try {
      const result = await onClosePosition(positionId);
      console.log('onClosePosition result:', result);
    } catch (err) {
      console.error('Error in onClosePosition:', err);
    }
    setClosingPositions(prev => {
      const next = new Set(prev);
      next.delete(positionId);
      return next;
    });
  };

  const handleCloseGroup = async (tradeGroupId: string, forceBrokenStructure: boolean = false) => {
    if (!onCloseGroup) return;
    setClosingGroups(prev => new Set(prev).add(tradeGroupId));
    try {
      await onCloseGroup(tradeGroupId, 'manual', forceBrokenStructure);
    } catch (err) {
      console.error('Error in onCloseGroup:', err);
    }
    setClosingGroups(prev => {
      const next = new Set(prev);
      next.delete(tradeGroupId);
      return next;
    });
  };

  const handleRetryAsGroup = async () => {
    if (!onRetryCloseAsGroup) return;
    try {
      await onRetryCloseAsGroup();
    } catch (err) {
      console.error('Error in onRetryCloseAsGroup:', err);
    }
  };

  const toggleGroupExpand = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  // Check if position is part of a group
  const checkIsGrouped = (pos: Position): boolean => {
    if (!isGroupedPosition) return false;
    return isGroupedPosition(pos);
  };

  // Get count of positions in same group
  const getGroupCount = (pos: Position): number => {
    if (!getGroupPositions || !pos.tradeGroupId) return 1;
    return getGroupPositions(pos.tradeGroupId).length;
  };
  
  const brokerPositions = positions;
  const strategyPositions = positions.filter(p => p.strategyName);

  // Compute grouped positions with health info
  const { groupedPositions, ungroupedPositions } = useMemo(() => {
    const grouped: GroupedPositionInfo[] = [];
    const ungrouped: Position[] = [];
    const groupMap = new Map<string, Position[]>();
    
    brokerPositions.forEach(pos => {
      if (pos.tradeGroupId) {
        const existing = groupMap.get(pos.tradeGroupId) || [];
        groupMap.set(pos.tradeGroupId, [...existing, pos]);
      } else {
        ungrouped.push(pos);
      }
    });
    
    groupMap.forEach((positions, tradeGroupId) => {
      // Get strategy info from first position with it
      const stratPos = positions.find(p => p.strategyType);
      const strategyType = stratPos?.strategyType || null;
      const strategyName = stratPos?.strategyName || null;
      const underlying = stratPos?.underlying || positions[0]?.underlying || '';

      // Compute health
      const health = computeGroupHealth(strategyType, positions.length);

      // Compute aggregate metrics
      const totalPnl = positions.reduce((sum, p) => sum + computePnl(p), 0);
      const dtes = positions.map(p => computeDte(p.expirationDate)).filter((d): d is number => d !== null);
      const nearestDte = dtes.length > 0 ? Math.min(...dtes) : null;

      // Get exit status from strategy engine (shows why position hasn't exited)
      const exitStatus = getExitStatus?.(positions[0]);

      grouped.push({
        tradeGroupId,
        positions,
        underlying,
        strategyType,
        strategyName,
        health,
        totalPnl,
        nearestDte,
        exitStatus,
      });
    });

    return { groupedPositions: grouped, ungroupedPositions: ungrouped };
  }, [brokerPositions, getExitStatus]);

  // Render exit status badge (shows why position hasn't exited)
  const renderExitStatus = (exitStatus: ExitStatusInfo | undefined) => {
    if (!exitStatus) return null;

    // If blocked, show blocked reason
    if (exitStatus.blockedReason) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="px-1.5 py-0.5 rounded bg-panic-red/20 text-panic-red text-[9px] cursor-help">
                BLOCKED
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p className="text-xs font-semibold text-panic-red">{exitStatus.blockedReason}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    // If triggered, show the reason
    if (exitStatus.triggered && exitStatus.reason) {
      return (
        <span className="px-1.5 py-0.5 rounded bg-bloomberg-amber/20 text-bloomberg-amber text-[9px]">
          {exitStatus.reason.replace('_', ' ').toUpperCase()}
        </span>
      );
    }

    // Not triggered - show P&L vs target
    const pnl = exitStatus.pnlPercent;
    const profit = exitStatus.profitTargetPercent;
    const stop = exitStatus.stopLossPercent;

    // Determine which threshold is closer to being hit
    const profitDistance = profit - pnl; // How far from profit target
    const stopDistance = pnl + stop; // How far from stop loss (stop is negative, pnl could be negative)

    let statusText: string;
    let statusColor: string;

    if (pnl >= 0) {
      // Positive P&L - show progress toward profit target
      const pctOfTarget = Math.min(100, Math.round((pnl / profit) * 100));
      statusText = `${pnl.toFixed(0)}% / ${profit}%`;
      statusColor = pctOfTarget >= 75 ? 'text-trading-green' : 'text-muted-foreground';
    } else {
      // Negative P&L - show distance from stop loss
      const pctOfStop = Math.round((Math.abs(pnl) / stop) * 100);
      statusText = `${pnl.toFixed(0)}% / -${stop}%`;
      statusColor = pctOfStop >= 75 ? 'text-panic-red' : 'text-muted-foreground';
    }

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn("font-mono text-[9px] cursor-help", statusColor)}>
              {statusText}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <div className="space-y-1 text-xs">
              <div className="font-semibold">Exit Thresholds</div>
              <div className={pnl >= 0 ? 'text-trading-green' : 'text-panic-red'}>
                Current P&L: {pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}%
              </div>
              <div className="text-trading-green">
                Profit Target: +{profit}%
              </div>
              <div className="text-panic-red">
                Stop Loss: -{stop}%
              </div>
              {exitStatus.dte !== undefined && exitStatus.timeStopDte !== undefined && (
                <div className="text-bloomberg-amber">
                  Time Stop: {exitStatus.dte} DTE (triggers at {exitStatus.timeStopDte} DTE)
                </div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  // Render health badge
  const renderHealthBadge = (health: GroupHealthInfo) => {
    if (health.status === 'ok') {
      return (
        <span className="px-1 py-0.5 rounded bg-trading-green/20 text-trading-green text-[9px]">
          {health.observedLegs}/{health.expectedLegs}
        </span>
      );
    }
    if (health.status === 'broken') {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="px-1 py-0.5 rounded bg-panic-red/20 text-panic-red text-[9px] font-semibold cursor-help flex items-center gap-0.5">
                <AlertTriangle className="h-2.5 w-2.5" />
                BROKEN ({health.observedLegs}/{health.expectedLegs})
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p className="text-xs">{health.reason}</p>
              <p className="text-[10px] text-muted-foreground mt-1">
                Structure is incomplete; risk may be undefined. Close Group recommended.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    return (
      <span className="px-1 py-0.5 rounded bg-muted text-muted-foreground text-[9px]">
        {health.observedLegs}L
      </span>
    );
  };

  // Render group close button
  const renderGroupCloseButton = (group: GroupedPositionInfo) => {
    const isGroupClosing = closingGroups.has(group.tradeGroupId);
    
    const handleClick = () => {
      if (group.health.status === 'broken') {
        setBrokenCloseConfirm(group);
      } else {
        handleCloseGroup(group.tradeGroupId);
      }
    };
    
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          "h-6 px-2 text-[9px] pointer-events-auto relative z-10 gap-1",
          group.health.status === 'broken' 
            ? "hover:bg-bloomberg-amber/20 hover:text-bloomberg-amber" 
            : "hover:bg-trading-green/20 hover:text-trading-green"
        )}
        onClick={(e) => {
          e.stopPropagation();
          handleClick();
        }}
        disabled={isGroupClosing}
      >
        <Layers className="h-3 w-3" />
        Close Group
      </Button>
    );
  };

  // Render per-leg close button (only in expanded view)
  const renderLegCloseButton = (pos: Position) => {
    const isClosing = closingPositions.has(pos.id);
    
    if (!legOutModeEnabled) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground text-[9px] cursor-not-allowed">
                <X className="h-3 w-3 opacity-30" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Enable Leg Out Mode to close individual legs</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-5 w-5 p-0 hover:bg-bloomberg-amber/20 hover:text-bloomberg-amber pointer-events-auto"
        onClick={(e) => {
          e.stopPropagation();
          handleClose(pos.id);
        }}
        disabled={isClosing}
      >
        <X className="h-3 w-3" />
      </Button>
    );
  };

  // Render close button for ungrouped positions
  const renderCloseButton = (pos: Position) => {
    const isGrouped = checkIsGrouped(pos);
    const isClosing = closingPositions.has(pos.id);
    const isGroupClosing = pos.tradeGroupId ? closingGroups.has(pos.tradeGroupId) : false;
    const groupCount = getGroupCount(pos);

    // Not grouped: simple close button
    if (!isGrouped || !pos.tradeGroupId) {
      return (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 hover:bg-panic-red/20 hover:text-panic-red pointer-events-auto relative z-10"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleClose(pos.id);
          }}
          disabled={isClosing}
        >
          <X className="h-3 w-3" />
        </Button>
      );
    }

    // Grouped: show dropdown with options
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 hover:bg-bloomberg-amber/20 hover:text-bloomberg-amber pointer-events-auto relative z-10 gap-1"
            disabled={isClosing || isGroupClosing}
          >
            <Layers className="h-3 w-3" />
            <span className="text-[9px]">{groupCount}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem 
            onClick={() => handleCloseGroup(pos.tradeGroupId!)}
            className="text-trading-green focus:text-trading-green"
          >
            <Layers className="h-3 w-3 mr-2" />
            Close Group ({groupCount} legs)
            <span className="ml-auto text-[9px] text-muted-foreground">recommended</span>
          </DropdownMenuItem>
          {legOutModeEnabled && (
            <DropdownMenuItem 
              onClick={() => handleClose(pos.id)}
              className="text-bloomberg-amber focus:text-bloomberg-amber"
            >
              <X className="h-3 w-3 mr-2" />
              Close This Leg
              <span className="ml-auto text-[9px] text-muted-foreground">DTBP risk</span>
            </DropdownMenuItem>
          )}
          {!legOutModeEnabled && (
            <DropdownMenuItem disabled className="text-muted-foreground">
              <X className="h-3 w-3 mr-2" />
              Close This Leg
              <span className="ml-auto text-[9px]">enable Leg Out</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  // Check if there are any broken groups
  const hasBrokenGroups = groupedPositions.some(g => g.health.status === 'broken');

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.2 }}
      className="terminal-panel flex-1"
    >
      <div className="flex items-center justify-between border-b border-border pb-1.5 mb-3">
        <div className="text-[10px] text-muted-foreground uppercase tracking-widest">
          Positions
        </div>
        
        {/* Leg Out Mode Toggle */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-muted-foreground uppercase">Leg Out</span>
          <Switch 
            checked={legOutModeEnabled}
            onCheckedChange={onLegOutModeChange}
            className="h-4 w-7 data-[state=checked]:bg-bloomberg-amber"
          />
        </div>
      </div>

      {/* ENTRIES HALTED Warning - Structure Integrity Gate */}
      {entryBlockedReason && (
        <Alert className="mb-3 border-panic-red bg-panic-red/20">
          <ShieldOff className="h-4 w-4 text-panic-red" />
          <AlertDescription className="text-sm text-panic-red flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold">⛔ ENTRIES HALTED</span>
              <span className="text-xs opacity-80">{entryBlockedReason}</span>
            </div>
            {onClearEntryBlock && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs border-panic-red/50 text-panic-red hover:bg-panic-red/20 gap-1.5"
                onClick={onClearEntryBlock}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Clear Entry Block
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Leg Out Mode Warning */}
      {legOutModeEnabled && (
        <Alert className="mb-3 border-bloomberg-amber/50 bg-bloomberg-amber/10">
          <AlertTriangle className="h-3 w-3 text-bloomberg-amber" />
          <AlertDescription className="text-[10px] text-bloomberg-amber">
            <strong>Leg Out Mode ON:</strong> Single-leg closes enabled. Risk of DTBP rejection due to temporary naked exposure.
          </AlertDescription>
        </Alert>
      )}

      {/* Broken Groups Warning */}
      {hasBrokenGroups && (
        <Alert className="mb-3 border-panic-red/50 bg-panic-red/10">
          <AlertTriangle className="h-3 w-3 text-panic-red" />
          <AlertDescription className="text-[10px] text-panic-red flex items-center justify-between">
            <div>
              <strong>Broken Structure Detected:</strong> One or more strategy groups have missing legs. This may be caused by stale mapping data.
            </div>
            {onPurgeStaleMappings && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[9px] border-bloomberg-amber/50 text-bloomberg-amber hover:bg-bloomberg-amber/20 gap-1 ml-2 shrink-0"
                onClick={async () => {
                  setIsPurging(true);
                  try {
                    await onPurgeStaleMappings();
                  } finally {
                    setIsPurging(false);
                  }
                }}
                disabled={isPurging}
              >
                <Trash2 className="h-3 w-3" />
                {isPurging ? 'Purging...' : 'Purge Stale Mappings'}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* DTBP Rejection Alert with Retry */}
      {dtbpRejection && (
        <Alert className="mb-3 border-panic-red/50 bg-panic-red/10">
          <AlertTriangle className="h-3 w-3 text-panic-red" />
          <AlertDescription className="text-[10px] text-panic-red flex items-center justify-between">
            <span>
              <strong>DTBP Rejection:</strong> {dtbpRejection.rejectReason}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-5 px-2 text-[9px] border-panic-red/50 text-panic-red hover:bg-panic-red/20"
              onClick={handleRetryAsGroup}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Retry Group Close
            </Button>
          </AlertDescription>
        </Alert>
      )}
      
      <Tabs defaultValue="broker" className="w-full">
        <TabsList className="grid w-full grid-cols-2 bg-secondary/50 h-8">
          <TabsTrigger value="broker" className="text-xs data-[state=active]:bg-bloomberg-amber data-[state=active]:text-black">
            BROKER POS
          </TabsTrigger>
          <TabsTrigger value="strategy" className="text-xs data-[state=active]:bg-bloomberg-amber data-[state=active]:text-black">
            STRAT POS
          </TabsTrigger>
        </TabsList>
        
        <TabsContent value="broker" className="mt-3">
          {!isApiConnected ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              DISCONNECTED - Demo mode
            </div>
          ) : brokerPositions.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              No broker positions
            </div>
          ) : (
            <div className="overflow-auto max-h-64">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase w-6"></TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">POS</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-right">P&L</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-right">DTE</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-center">HEALTH</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-center">EXIT</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-center w-24"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Grouped positions */}
                  {groupedPositions.map((group) => {
                    const isExpanded = expandedGroups.has(group.tradeGroupId);
                    const displayName = group.strategyName 
                      ? group.strategyName 
                      : `${group.underlying} ${strategyDisplayName(group.strategyType)}`;
                    
                    return (
                      <>
                        {/* Group header row */}
                        <TableRow 
                          key={group.tradeGroupId} 
                          className={cn(
                            "border-border cursor-pointer",
                            group.health.status === 'broken' 
                              ? "bg-panic-red/5 hover:bg-panic-red/10" 
                              : "hover:bg-secondary/30"
                          )}
                          onClick={() => toggleGroupExpand(group.tradeGroupId)}
                        >
                          <TableCell className="py-1.5 w-6">
                            {isExpanded ? (
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-foreground py-1.5">
                            <div className="flex items-center gap-2">
                              <Layers className="h-3 w-3 text-bloomberg-amber flex-shrink-0" />
                              <span className="truncate max-w-32">{displayName}</span>
                            </div>
                          </TableCell>
                          <TableCell className={cn(
                            "font-mono text-xs text-right py-1.5",
                            group.totalPnl >= 0 ? "text-trading-green" : "text-panic-red"
                          )}>
                            <div className="flex flex-col items-end">
                              <span>{group.totalPnl >= 0 ? '+' : ''}${group.totalPnl.toFixed(0)}</span>
                              <span className="text-[8px] text-muted-foreground">(mark)</span>
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right text-bloomberg-amber py-1.5">
                            {group.nearestDte !== null ? group.nearestDte : '--'}
                          </TableCell>
                          <TableCell className="py-1.5 text-center">
                            {renderHealthBadge(group.health)}
                          </TableCell>
                          <TableCell className="py-1.5 text-center">
                            {renderExitStatus(group.exitStatus)}
                          </TableCell>
                          <TableCell className="py-1.5 text-center">
                            {renderGroupCloseButton(group)}
                          </TableCell>
                        </TableRow>
                        
                        {/* Expanded leg rows */}
                        {isExpanded && group.positions.map((pos) => {
                          const dte = computeDte(pos.expirationDate);
                          const legPnl = computePnl(pos);
                          const raw = pos._rawTradier;
                          
                          return (
                            <TableRow 
                              key={pos.id} 
                              className="border-border bg-secondary/20 hover:bg-secondary/40"
                            >
                              <TableCell className="py-1 w-6"></TableCell>
                              <TableCell className="font-mono text-[10px] text-muted-foreground py-1 pl-6">
                                <div className="flex items-center gap-2">
                                  <span className={cn(
                                    "w-6 text-center text-[9px] px-1 rounded",
                                    pos.quantity < 0 ? "bg-panic-red/20 text-panic-red" : "bg-trading-green/20 text-trading-green"
                                  )}>
                                    {pos.quantity > 0 ? '+' : ''}{pos.quantity}
                                  </span>
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="truncate max-w-40 cursor-help underline decoration-dotted underline-offset-2" title={pos.symbol}>
                                          {pos.symbol}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="right" className="font-mono text-[10px] max-w-xs">
                                        <div className="space-y-1">
                                          <div className="font-semibold text-bloomberg-amber">Raw Tradier Values</div>
                                          <div>cost_basis: ${raw?.cost_basis?.toFixed(2) ?? 'N/A'}</div>
                                          <div>market_value: ${raw?.market_value?.toFixed(2) ?? 'N/A'}</div>
                                          <div>quantity: {raw?.quantity ?? 'N/A'}</div>
                                          <div className="border-t border-border pt-1 mt-1">
                                            <span className="text-muted-foreground">Computed P&L:</span> ${legPnl.toFixed(2)}
                                          </div>
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                </div>
                              </TableCell>
                              <TableCell className={cn(
                                "font-mono text-[10px] text-right py-1",
                                legPnl >= 0 ? "text-trading-green" : "text-panic-red"
                              )}>
                                {legPnl >= 0 ? '+' : ''}${legPnl.toFixed(2)}
                              </TableCell>
                              <TableCell className="font-mono text-[10px] text-right text-muted-foreground py-1">
                                {dte !== null ? dte : '--'}
                              </TableCell>
                              <TableCell className="font-mono text-[10px] text-center py-1">
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="text-muted-foreground cursor-help">
                                        ${pos.costBasis.toFixed(2)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="font-mono text-[10px]">
                                      <div>Cost: ${pos.costBasis.toFixed(2)}</div>
                                      <div>Current: ${pos.currentValue.toFixed(2)}</div>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </TableCell>
                              <TableCell className="py-1 text-center">
                                {/* Exit status shown at group level */}
                              </TableCell>
                              <TableCell className="py-1 text-center">
                                {renderLegCloseButton(pos)}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </>
                    );
                  })}
                  
                  {/* Ungrouped positions */}
                  {ungroupedPositions.map((pos) => {
                    const dte = computeDte(pos.expirationDate);
                    const pnl = computePnl(pos);
                    
                    return (
                      <TableRow key={pos.id} className="border-border hover:bg-secondary/30">
                        <TableCell className="py-1.5 w-6"></TableCell>
                        <TableCell className="font-mono text-xs text-foreground py-1.5">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "w-6 text-center text-[9px] px-1 rounded",
                              pos.quantity < 0 ? "bg-panic-red/20 text-panic-red" : "bg-trading-green/20 text-trading-green"
                            )}>
                              {pos.quantity > 0 ? '+' : ''}{pos.quantity}
                            </span>
                            <span className="truncate max-w-32" title={pos.symbol}>
                              {pos.symbol.length > 20 ? pos.symbol.slice(0, 20) + '...' : pos.symbol}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className={cn(
                          "font-mono text-xs text-right py-1.5",
                          pnl >= 0 ? "text-trading-green" : "text-panic-red"
                        )}>
                          {pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-right text-bloomberg-amber py-1.5">
                          {dte !== null ? dte : '--'}
                        </TableCell>
                        <TableCell className="font-mono text-[9px] text-center py-1.5">
                          <span className="text-muted-foreground">—</span>
                        </TableCell>
                        <TableCell className="font-mono text-[9px] text-center py-1.5">
                          {/* Exit status N/A for ungrouped */}
                          <span className="text-muted-foreground">—</span>
                        </TableCell>
                        <TableCell className="py-1.5 text-center">
                          {renderCloseButton(pos)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
        
        <TabsContent value="strategy" className="mt-3">
          {strategyPositions.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              No tracked strategy positions
            </div>
          ) : (
            <div className="overflow-auto max-h-48">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">STRAT</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">UND</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-right">ENTRY</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-right">UPL</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-center">STATUS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {strategyPositions.map((pos) => {
                    const pnl = computePnl(pos);
                    return (
                      <TableRow key={pos.id} className="border-border hover:bg-secondary/30">
                        <TableCell className="font-mono text-xs text-foreground py-1.5">
                          {pos.strategyName?.slice(0, 15)}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-foreground py-1.5">
                          {pos.underlying}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-right text-foreground py-1.5">
                          ${(pos.entryCredit || 0).toFixed(0)}
                        </TableCell>
                        <TableCell className={cn(
                          "font-mono text-xs text-right py-1.5",
                          pnl >= 0 ? "text-trading-green" : "text-panic-red"
                        )}>
                          {pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-center py-1.5">
                          <span className={cn(
                            "px-1.5 py-0.5 rounded text-[9px] uppercase",
                            pos.status === 'open' ? 'bg-trading-green/20 text-trading-green' :
                            pos.status === 'pending_close' ? 'bg-bloomberg-amber/20 text-bloomberg-amber' :
                            'bg-neutral-gray/20 text-neutral-gray'
                          )}>
                            {pos.status.replace('_', ' ')}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Broken Group Close Confirmation Dialog */}
      <AlertDialog open={!!brokenCloseConfirm} onOpenChange={(open) => !open && setBrokenCloseConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-bloomberg-amber">
              <AlertTriangle className="h-5 w-5" />
              Close Broken Structure?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {brokenCloseConfirm && (
                <>
                  <p className="mb-2">
                    This group appears broken: found {brokenCloseConfirm.health.observedLegs} legs 
                    instead of expected {brokenCloseConfirm.health.expectedLegs}.
                  </p>
                  <p className="mb-2">
                    Closing the available {brokenCloseConfirm.health.observedLegs} legs as a batch may result in 
                    undefined risk or margin issues.
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Do you want to proceed with closing the available legs?
                  </p>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-bloomberg-amber text-black hover:bg-bloomberg-amber/80"
              onClick={async () => {
                if (brokenCloseConfirm && onCloseGroup) {
                  // Pass forceBrokenStructure=true to allow closing broken structures
                  await onCloseGroup(brokenCloseConfirm.tradeGroupId, 'broken_structure_close', true);
                }
                setBrokenCloseConfirm(null);
              }}
            >
              Close Available Legs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
};