import { motion } from 'framer-motion';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { X, Layers, AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Position } from '@/types/trading';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface PositionsPanelProps {
  positions: Position[];
  isApiConnected: boolean;
  onClosePosition?: (positionId: string) => Promise<boolean>;
  onCloseGroup?: (tradeGroupId: string, exitReason?: string) => Promise<boolean>;
  legOutModeEnabled?: boolean;
  onLegOutModeChange?: (enabled: boolean) => void;
  isGroupedPosition?: (position: Position) => boolean;
  getGroupPositions?: (tradeGroupId: string | undefined) => Position[];
  dtbpRejection?: {
    symbol: string;
    tradeGroupId: string;
    rejectReason: string;
    timestamp: number;
  } | null;
  onRetryCloseAsGroup?: () => Promise<boolean>;
}

const computeDte = (expirationDate?: string): number | null => {
  if (!expirationDate) return null;
  const exp = new Date(expirationDate);
  const today = new Date();
  const diffTime = exp.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
};

const computePnl = (position: Position): number => {
  const cost = position.costBasis * Math.abs(position.quantity) * 100;
  const current = position.currentValue * Math.abs(position.quantity) * 100;
  // For short positions, profit is cost - current
  return position.quantity < 0 ? cost - current : current - cost;
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
  dtbpRejection,
  onRetryCloseAsGroup,
}: PositionsPanelProps) => {
  const [closingPositions, setClosingPositions] = useState<Set<string>>(new Set());
  const [closingGroups, setClosingGroups] = useState<Set<string>>(new Set());
  
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

  const handleCloseGroup = async (tradeGroupId: string) => {
    if (!onCloseGroup) return;
    setClosingGroups(prev => new Set(prev).add(tradeGroupId));
    try {
      await onCloseGroup(tradeGroupId);
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

  // Group positions by tradeGroupId for display
  const groupedPositionsMap = new Map<string, Position[]>();
  const ungroupedPositions: Position[] = [];
  
  brokerPositions.forEach(pos => {
    if (pos.tradeGroupId) {
      const existing = groupedPositionsMap.get(pos.tradeGroupId) || [];
      groupedPositionsMap.set(pos.tradeGroupId, [...existing, pos]);
    } else {
      ungroupedPositions.push(pos);
    }
  });

  // Render close button based on whether position is grouped
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

      {/* Leg Out Mode Warning */}
      {legOutModeEnabled && (
        <Alert className="mb-3 border-bloomberg-amber/50 bg-bloomberg-amber/10">
          <AlertTriangle className="h-3 w-3 text-bloomberg-amber" />
          <AlertDescription className="text-[10px] text-bloomberg-amber">
            <strong>Leg Out Mode ON:</strong> Single-leg closes enabled. Risk of DTBP rejection due to temporary naked exposure.
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
            <div className="overflow-auto max-h-48">
              <Table>
                <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">SYM</TableHead>
                      <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-right">QTY</TableHead>
                      <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-right">AVG</TableHead>
                      <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-right">DTE</TableHead>
                      <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-center w-16">GRP</TableHead>
                      <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-center w-12"></TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                  {brokerPositions.map((pos) => {
                    const dte = computeDte(pos.expirationDate);
                    const isGrouped = checkIsGrouped(pos);
                    const groupCount = getGroupCount(pos);
                    
                    return (
                      <TableRow key={pos.id} className="border-border hover:bg-secondary/30">
                        <TableCell className="font-mono text-xs text-foreground py-1.5">
                          {pos.symbol.length > 20 ? pos.symbol.slice(0, 20) + '...' : pos.symbol}
                        </TableCell>
                        <TableCell className={cn(
                          "font-mono text-xs text-right py-1.5",
                          pos.quantity < 0 ? "text-panic-red" : "text-trading-green"
                        )}>
                          {pos.quantity}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-right text-foreground py-1.5">
                          ${pos.costBasis.toFixed(2)}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-right text-bloomberg-amber py-1.5">
                          {dte !== null ? dte : '--'}
                        </TableCell>
                        <TableCell className="font-mono text-[9px] text-center py-1.5">
                          {isGrouped ? (
                            <span className="px-1 py-0.5 rounded bg-bloomberg-amber/20 text-bloomberg-amber">
                              {groupCount}L
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
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
    </motion.div>
  );
};