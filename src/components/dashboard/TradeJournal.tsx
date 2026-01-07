import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { tradeJournal, TradeRecord, TradeGroup } from '@/services/tradeJournal';
import { format } from 'date-fns';
import { ChevronDown, ChevronUp, ChevronRight, Edit2, Save, X, Clock, DollarSign, TrendingUp, TrendingDown, Tag, FileText, Layers } from 'lucide-react';

// Type guard to check if item is a TradeGroup
const isTradeGroup = (item: TradeRecord | TradeGroup): item is TradeGroup => {
  return 'groupId' in item && 'trades' in item;
};

interface TradeDetailsRowProps {
  trade: TradeRecord;
  isEditing: boolean;
  editNotes: string;
  onEditNotes: (trade: TradeRecord) => void;
  onSaveNotes: (tradeId: string) => void;
  onCancelEdit: () => void;
  onNotesChange: (notes: string) => void;
}

const TradeDetailsRow = ({ 
  trade, 
  isEditing, 
  editNotes, 
  onEditNotes, 
  onSaveNotes, 
  onCancelEdit,
  onNotesChange 
}: TradeDetailsRowProps) => {
  const entryTime = trade.entry_time ? new Date(trade.entry_time) : null;
  const exitTime = trade.exit_time ? new Date(trade.exit_time) : null;
  const duration = entryTime && exitTime 
    ? Math.round((exitTime.getTime() - entryTime.getTime()) / (1000 * 60)) 
    : null;

  const formatDuration = (minutes: number | null) => {
    if (minutes === null) return '--';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours < 24) return `${hours}h ${mins}m`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  };

  return (
    <motion.tr
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="bg-secondary/20 border-border"
    >
      <TableCell colSpan={6} className="p-0">
        <div className="p-4 space-y-4">
          {/* Trade Details Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Timing Section */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                <Clock className="h-3 w-3" />
                Timing
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Entry:</span>
                  <span className="font-mono">{entryTime ? format(entryTime, 'MM/dd/yy HH:mm') : '--'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Exit:</span>
                  <span className="font-mono">{exitTime ? format(exitTime, 'MM/dd/yy HH:mm') : '--'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Duration:</span>
                  <span className="font-mono">{formatDuration(duration)}</span>
                </div>
              </div>
            </div>

            {/* Pricing Section */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                <DollarSign className="h-3 w-3" />
                Pricing
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Entry Price:</span>
                  <span className="font-mono">${Number(trade.entry_price).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Exit Price:</span>
                  <span className="font-mono">${Number(trade.exit_price).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Quantity:</span>
                  <span className="font-mono">{trade.quantity}</span>
                </div>
              </div>
            </div>

            {/* P&L Section */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                {trade.pnl >= 0 ? <TrendingUp className="h-3 w-3 text-trading-green" /> : <TrendingDown className="h-3 w-3 text-panic-red" />}
                Profit/Loss
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">P&L:</span>
                  <span className={cn("font-mono font-semibold", trade.pnl >= 0 ? "text-trading-green" : "text-panic-red")}>
                    {trade.pnl >= 0 ? '+' : ''}${Number(trade.pnl).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">P&L %:</span>
                  <span className={cn("font-mono", trade.pnl >= 0 ? "text-trading-green" : "text-panic-red")}>
                    {trade.pnl_percent != null ? `${trade.pnl_percent >= 0 ? '+' : ''}${Number(trade.pnl_percent).toFixed(1)}%` : '--'}
                  </span>
                </div>
                {trade.entry_credit != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Entry Credit:</span>
                    <span className="font-mono">${Number(trade.entry_credit).toFixed(2)}</span>
                  </div>
                )}
                {trade.exit_debit != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Exit Debit:</span>
                    <span className="font-mono">${Number(trade.exit_debit).toFixed(2)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Strategy Section */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                <Tag className="h-3 w-3" />
                Strategy
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Name:</span>
                  <span className="font-mono">{trade.strategy_name || '--'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Type:</span>
                  <span className="font-mono">{trade.strategy_type || '--'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Exit Reason:</span>
                  <span className="font-mono">{trade.exit_reason || '--'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Full Symbol */}
          <div className="text-xs">
            <span className="text-muted-foreground">Full Symbol: </span>
            <span className="font-mono text-foreground">{trade.symbol}</span>
          </div>

          {/* Notes Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                <FileText className="h-3 w-3" />
                Notes
              </div>
              {!isEditing && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => onEditNotes(trade)}
                >
                  <Edit2 className="h-3 w-3 mr-1" />
                  Edit
                </Button>
              )}
            </div>
            {isEditing ? (
              <div className="flex flex-col gap-2">
                <Textarea
                  value={editNotes}
                  onChange={(e) => onNotesChange(e.target.value)}
                  className="text-xs min-h-[80px]"
                  placeholder="Add notes about this trade..."
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    onClick={onCancelEdit}
                  >
                    <X className="h-3 w-3 mr-1" />
                    Cancel
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    className="h-7"
                    onClick={() => onSaveNotes(trade.id!)}
                  >
                    <Save className="h-3 w-3 mr-1" />
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground bg-background/50 rounded p-2 min-h-[40px]">
                {trade.notes || 'No notes added'}
              </div>
            )}
          </div>
        </div>
      </TableCell>
    </motion.tr>
  );
};

// Component for displaying a trade group (multi-leg)
interface TradeGroupRowProps {
  group: TradeGroup;
  isExpanded: boolean;
  onToggle: () => void;
}

const TradeGroupRow = ({ group, isExpanded, onToggle }: TradeGroupRowProps) => {
  return (
    <>
      <TableRow 
        className={cn(
          "border-border cursor-pointer transition-colors",
          isExpanded ? "bg-primary/10" : "hover:bg-secondary/30"
        )}
        onClick={onToggle}
      >
        <TableCell className="py-1.5 w-8">
          <div className="flex items-center gap-1">
            <Layers className="h-3 w-3 text-primary" />
            <ChevronRight 
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                isExpanded && "rotate-90"
              )} 
            />
          </div>
        </TableCell>
        <TableCell className="font-mono text-xs text-foreground py-1.5">
          {group.exitTime ? format(new Date(group.exitTime), 'MM/dd HH:mm') : '--'}
        </TableCell>
        <TableCell className="font-mono text-xs text-foreground py-1.5">
          <span className="flex items-center gap-1">
            {group.strategyName?.slice(0, 15) || group.strategyType || group.underlying}
            <span className="text-[9px] text-primary bg-primary/20 px-1 rounded">
              {group.trades.length}L
            </span>
          </span>
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground py-1.5">
          {group.underlying} spread
        </TableCell>
        <TableCell className={cn(
          "font-mono text-xs text-right py-1.5 font-semibold",
          group.totalPnl >= 0 ? "text-trading-green" : "text-panic-red"
        )}>
          {group.totalPnl >= 0 ? '+' : ''}${Number(group.totalPnl).toFixed(2)}
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground py-1.5">
          {group.exitReason || '--'}
        </TableCell>
      </TableRow>
      {isExpanded && (
        <motion.tr
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="bg-secondary/20 border-border"
        >
          <TableCell colSpan={6} className="p-0">
            <div className="p-3 space-y-2 border-l-2 border-primary/50 ml-4">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">
                Legs in this spread
              </div>
              {group.trades.map((leg, idx) => (
                <div key={leg.id || idx} className="flex items-center justify-between text-xs bg-background/50 rounded px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-[10px] w-4">{idx + 1}.</span>
                    <span className="font-mono">{leg.symbol}</span>
                    <span className="text-muted-foreground">×{leg.quantity}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-muted-foreground">
                      ${Number(leg.entry_price).toFixed(2)} → ${Number(leg.exit_price).toFixed(2)}
                    </span>
                    <span className={cn(
                      "font-mono",
                      leg.pnl >= 0 ? "text-trading-green" : "text-panic-red"
                    )}>
                      {leg.pnl >= 0 ? '+' : ''}${Number(leg.pnl).toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
              <div className="flex justify-between items-center pt-2 border-t border-border mt-2">
                <span className="text-[10px] text-muted-foreground uppercase">Combined P&L</span>
                <span className={cn(
                  "font-mono font-semibold",
                  group.totalPnl >= 0 ? "text-trading-green" : "text-panic-red"
                )}>
                  {group.totalPnl >= 0 ? '+' : ''}${Number(group.totalPnl).toFixed(2)}
                </span>
              </div>
            </div>
          </TableCell>
        </motion.tr>
      )}
    </>
  );
};

export const TradeJournal = () => {
  const [trades, setTrades] = useState<(TradeRecord | TradeGroup)[]>([]);
  const [stats, setStats] = useState({
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalPnl: 0,
    winRate: 0,
    avgWinner: 0,
    avgLoser: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNotes, setEditNotes] = useState('');

  useEffect(() => {
    loadTrades();
  }, []);

  // Keep the journal fresh while it's expanded (so manual closes show up immediately)
  useEffect(() => {
    if (!isExpanded) return;

    // Load immediately when expanding
    loadTrades();

    // Then poll while expanded
    const interval = window.setInterval(() => {
      loadTrades();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [isExpanded]);

  const loadTrades = async () => {
    setIsLoading(true);
    const [tradesData, statsData] = await Promise.all([
      tradeJournal.getGroupedTrades(),
      tradeJournal.getTradeStats(),
    ]);
    setTrades(tradesData);
    setStats(statsData);
    setIsLoading(false);
  };

  const handleEditNotes = (trade: TradeRecord) => {
    setEditingId(trade.id || null);
    setEditNotes(trade.notes || '');
  };

  const handleSaveNotes = async (tradeId: string) => {
    await tradeJournal.updateTradeNotes(tradeId, editNotes);
    setEditingId(null);
    loadTrades();
  };

  const toggleTradeExpanded = (tradeId: string) => {
    setExpandedTradeId(expandedTradeId === tradeId ? null : tradeId);
    if (expandedTradeId !== tradeId) {
      setEditingId(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.35 }}
      className="terminal-panel"
    >
      <div 
        className="flex items-center justify-between cursor-pointer border-b border-border pb-1.5 mb-3"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="text-[10px] text-muted-foreground uppercase tracking-widest">
          Trade Journal
        </div>
        <div className="flex items-center gap-4">
          <div className="flex gap-3 text-[10px]">
            <span className="text-muted-foreground">
              Trades: <span className="text-foreground">{stats.totalTrades}</span>
            </span>
            <span className="text-muted-foreground">
              Win Rate: <span className={cn(
                stats.winRate >= 50 ? 'text-trading-green' : 'text-panic-red'
              )}>{stats.winRate.toFixed(1)}%</span>
            </span>
            <span className="text-muted-foreground">
              Total P&L: <span className={cn(
                stats.totalPnl >= 0 ? 'text-trading-green' : 'text-panic-red'
              )}>${stats.totalPnl.toFixed(2)}</span>
            </span>
          </div>
          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </div>

      {isExpanded && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
        >
          {/* Stats Summary */}
          <div className="grid grid-cols-4 gap-3 mb-4 p-2 bg-secondary/30 rounded">
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground uppercase">Winners</div>
              <div className="text-sm font-mono text-trading-green">{stats.winningTrades}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground uppercase">Losers</div>
              <div className="text-sm font-mono text-panic-red">{stats.losingTrades}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground uppercase">Avg Win</div>
              <div className="text-sm font-mono text-trading-green">${stats.avgWinner.toFixed(2)}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground uppercase">Avg Loss</div>
              <div className="text-sm font-mono text-panic-red">${stats.avgLoser.toFixed(2)}</div>
            </div>
          </div>

          {/* Trades Table */}
          {isLoading ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              Loading trades...
            </div>
          ) : trades.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              No completed trades yet
            </div>
          ) : (
            <div className="overflow-auto max-h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="w-8"></TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">Date</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">Strategy</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">Symbol</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-right">P&L</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">Exit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <AnimatePresence>
                    {trades.map((item) => {
                      if (isTradeGroup(item)) {
                        return (
                          <TradeGroupRow
                            key={item.groupId}
                            group={item}
                            isExpanded={expandedTradeId === item.groupId}
                            onToggle={() => toggleTradeExpanded(item.groupId)}
                          />
                        );
                      }
                      
                      const trade = item;
                      return (
                        <>
                          <TableRow 
                            key={trade.id} 
                            className={cn(
                              "border-border cursor-pointer transition-colors",
                              expandedTradeId === trade.id ? "bg-secondary/40" : "hover:bg-secondary/30"
                            )}
                            onClick={() => toggleTradeExpanded(trade.id!)}
                          >
                            <TableCell className="py-1.5 w-8">
                              <ChevronRight 
                                className={cn(
                                  "h-4 w-4 text-muted-foreground transition-transform",
                                  expandedTradeId === trade.id && "rotate-90"
                                )} 
                              />
                            </TableCell>
                            <TableCell className="font-mono text-xs text-foreground py-1.5">
                              {trade.exit_time ? format(new Date(trade.exit_time), 'MM/dd HH:mm') : '--'}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-foreground py-1.5">
                              {trade.strategy_name?.slice(0, 15) || trade.underlying}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-foreground py-1.5">
                              {trade.symbol.length > 18 ? trade.symbol.slice(0, 18) + '...' : trade.symbol}
                            </TableCell>
                            <TableCell className={cn(
                              "font-mono text-xs text-right py-1.5",
                              trade.pnl >= 0 ? "text-trading-green" : "text-panic-red"
                            )}>
                              {trade.pnl >= 0 ? '+' : ''}${Number(trade.pnl).toFixed(2)}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground py-1.5">
                              {trade.exit_reason || '--'}
                            </TableCell>
                          </TableRow>
                          {expandedTradeId === trade.id && (
                            <TradeDetailsRow
                              key={`${trade.id}-details`}
                              trade={trade}
                              isEditing={editingId === trade.id}
                              editNotes={editNotes}
                              onEditNotes={handleEditNotes}
                              onSaveNotes={handleSaveNotes}
                              onCancelEdit={() => setEditingId(null)}
                              onNotesChange={setEditNotes}
                            />
                          )}
                        </>
                      );
                    })}
                  </AnimatePresence>
                </TableBody>
              </Table>
            </div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
};
