import { motion } from 'framer-motion';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Position } from '@/types/trading';
import { useState } from 'react';

interface PositionsPanelProps {
  positions: Position[];
  isApiConnected: boolean;
  onClosePosition?: (positionId: string) => Promise<boolean>;
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

export const PositionsPanel = ({ positions, isApiConnected, onClosePosition }: PositionsPanelProps) => {
  const [closingPositions, setClosingPositions] = useState<Set<string>>(new Set());
  
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
  
  const brokerPositions = positions;
  const strategyPositions = positions.filter(p => p.strategyName);

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.2 }}
      className="terminal-panel flex-1"
    >
      <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1.5 mb-3">
        Positions
      </div>
      
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
                      <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-center w-12"></TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                  {brokerPositions.map((pos) => {
                    const dte = computeDte(pos.expirationDate);
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
                        <TableCell className="py-1.5 text-center">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 hover:bg-panic-red/20 hover:text-panic-red pointer-events-auto relative z-10"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              console.log('Button clicked for position:', pos.id);
                              handleClose(pos.id);
                            }}
                            disabled={closingPositions.has(pos.id)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
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
