import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { tradeJournal, TradeRecord } from '@/services/tradeJournal';
import { format } from 'date-fns';
import { ChevronDown, ChevronUp, Edit2, Save, X } from 'lucide-react';

export const TradeJournal = () => {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNotes, setEditNotes] = useState('');

  useEffect(() => {
    loadTrades();
  }, []);

  const loadTrades = async () => {
    setIsLoading(true);
    const [tradesData, statsData] = await Promise.all([
      tradeJournal.getTrades(),
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
            <div className="overflow-auto max-h-64">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">Date</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">Strategy</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">Symbol</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase text-right">P&L</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">Exit</TableHead>
                    <TableHead className="text-bloomberg-amber font-mono text-[10px] uppercase">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trades.map((trade) => (
                    <TableRow key={trade.id} className="border-border hover:bg-secondary/30">
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
                      <TableCell className="py-1.5">
                        {editingId === trade.id ? (
                          <div className="flex items-center gap-1">
                            <Textarea
                              value={editNotes}
                              onChange={(e) => setEditNotes(e.target.value)}
                              className="h-8 text-xs min-h-0 py-1"
                              placeholder="Add notes..."
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={() => handleSaveNotes(trade.id!)}
                            >
                              <Save className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={() => setEditingId(null)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-muted-foreground truncate max-w-20">
                              {trade.notes || '--'}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 p-0 opacity-50 hover:opacity-100"
                              onClick={() => handleEditNotes(trade)}
                            >
                              <Edit2 className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
};
