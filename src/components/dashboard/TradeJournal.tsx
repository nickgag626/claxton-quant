import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { tradeJournal, TradeRecord, TradeGroup, TradeStats, DuplicateCandidate } from '@/services/tradeJournal';
import { reconcileFromTradierFills, importMissingTrades } from '@/services/tradierReconcile';
import { format, subDays } from 'date-fns';
import { ChevronDown, ChevronUp, ChevronRight, Edit2, Save, X, Clock, DollarSign, TrendingUp, TrendingDown, Tag, FileText, Layers, Calculator, Search, AlertTriangle, Trash2, RefreshCw, Download } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
          {/* Reconciliation Warning */}
          {trade.needs_reconcile && (
            <div className="flex items-center gap-2 p-2 bg-bloomberg-amber/20 border border-bloomberg-amber/30 rounded text-xs text-bloomberg-amber">
              <AlertTriangle className="h-4 w-4" />
              <span>This trade needs reconciliation - missing open_side or close_order_id</span>
            </div>
          )}

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
                  <span className="font-mono">${Number(trade.entry_price).toFixed(4)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Exit Price:</span>
                  <span className="font-mono">${Number(trade.exit_price).toFixed(4)}</span>
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

          {/* Audit Columns Section */}
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
              <Calculator className="h-3 w-3" />
              Audit Details
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Qty:</span>
                  <span className="font-mono">{trade.quantity}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Multiplier:</span>
                  <span className="font-mono">×{trade.multiplier || 100}</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Open Side:</span>
                  <span className={cn("font-mono", trade.open_side?.includes('sell') ? "text-trading-green" : "text-bloomberg-amber")}>
                    {trade.open_side || '--'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Open Price:</span>
                  <span className="font-mono">${Number(trade.entry_price).toFixed(4)}</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Close Side:</span>
                  <span className={cn("font-mono", trade.close_side?.includes('buy') ? "text-panic-red" : "text-bloomberg-amber")}>
                    {trade.close_side || '--'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Close Price:</span>
                  <span className="font-mono">${Number(trade.exit_price).toFixed(4)}</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Fees:</span>
                  <span className="font-mono">${Number(trade.fees || 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Close Order:</span>
                  <span className="font-mono text-[9px] truncate max-w-[80px]" title={trade.close_order_id || 'N/A'}>
                    {trade.close_order_id ? `#${trade.close_order_id}` : '--'}
                  </span>
                </div>
              </div>
            </div>
            {/* P&L Formula */}
            {trade.pnl_formula && (
              <div className="mt-2 p-2 bg-background/50 rounded text-[10px] font-mono text-muted-foreground">
                <span className="text-bloomberg-amber">Formula: </span>
                {trade.pnl_formula}
              </div>
            )}
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
                    <span className={cn(
                      "text-[9px] px-1 rounded",
                      leg.open_side?.includes('sell') ? "bg-trading-green/20 text-trading-green" : "bg-bloomberg-amber/20 text-bloomberg-amber"
                    )}>
                      {leg.open_side || '?'}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-muted-foreground">
                      ${Number(leg.entry_price).toFixed(4)} → ${Number(leg.exit_price).toFixed(4)}
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
  const [stats, setStats] = useState<TradeStats>({
    totalTrades: 0,
    totalLegs: 0,
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
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [countByLeg, setCountByLeg] = useState(false);
  
  // Duplicate detection state
  const [isDetectingDuplicates, setIsDetectingDuplicates] = useState(false);
  const [duplicateCandidates, setDuplicateCandidates] = useState<DuplicateCandidate[]>([]);
  const [showDuplicatesDialog, setShowDuplicatesDialog] = useState(false);
  const [selectedDuplicates, setSelectedDuplicates] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Reconciliation state
  const [isReconciling, setIsReconciling] = useState(false);

  useEffect(() => {
    loadTrades();
  }, []);

  useEffect(() => {
    if (!isExpanded) return;
    loadTrades();
    const interval = window.setInterval(() => {
      loadTrades();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [isExpanded]);

  // Reload stats when count mode changes
  useEffect(() => {
    loadStats();
  }, [countByLeg]);

  const loadTrades = async () => {
    setIsLoading(true);
    const [tradesData, statsData] = await Promise.all([
      tradeJournal.getGroupedTrades(),
      tradeJournal.getTradeStats(countByLeg),
    ]);
    setTrades(tradesData);
    setStats(statsData);
    setIsLoading(false);
  };

  const loadStats = async () => {
    const statsData = await tradeJournal.getTradeStats(countByLeg);
    setStats(statsData);
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

  const handleRecalculatePnl = async () => {
    setIsRecalculating(true);
    try {
      const result = await tradeJournal.recalculatePnl();
      if (result.success) {
        toast.success(`Recalculated P&L for ${result.updated} trades`);
        if (result.errors.length > 0) {
          console.warn('P&L recalculation warnings:', result.errors);
          toast.warning(`${result.errors.length} trades had issues - check console`);
        }
        loadTrades();
      } else {
        toast.error('Failed to recalculate P&L');
      }
    } catch (error) {
      console.error('Error recalculating P&L:', error);
      toast.error('Error recalculating P&L');
    } finally {
      setIsRecalculating(false);
    }
  };

  const handleDetectDuplicates = async () => {
    setIsDetectingDuplicates(true);
    try {
      const result = await tradeJournal.detectDuplicates();
      if (result.error) {
        toast.error(result.error);
      } else if (result.candidates.length === 0) {
        toast.success('No duplicates detected');
      } else {
        setDuplicateCandidates(result.candidates);
        setSelectedDuplicates(new Set(result.candidates.map(c => c.id)));
        setShowDuplicatesDialog(true);
      }
    } catch (error) {
      console.error('Error detecting duplicates:', error);
      toast.error('Error detecting duplicates');
    } finally {
      setIsDetectingDuplicates(false);
    }
  };

  const handleDeleteSelectedDuplicates = async () => {
    if (selectedDuplicates.size === 0) return;
    
    setIsDeleting(true);
    try {
      const result = await tradeJournal.deleteDuplicates(Array.from(selectedDuplicates));
      if (result.success) {
        toast.success(`Deleted ${result.deleted} duplicate trades`);
        setShowDuplicatesDialog(false);
        setDuplicateCandidates([]);
        setSelectedDuplicates(new Set());
        loadTrades();
      } else {
        toast.error(result.error || 'Failed to delete duplicates');
      }
    } catch (error) {
      console.error('Error deleting duplicates:', error);
      toast.error('Error deleting duplicates');
    } finally {
      setIsDeleting(false);
    }
  };

  const toggleDuplicateSelection = (id: string) => {
    setSelectedDuplicates(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleReconcileFromTradier = async () => {
    setIsReconciling(true);
    try {
      // Reconcile last 7 days
      const endDate = format(new Date(), 'yyyy-MM-dd');
      const startDate = format(subDays(new Date(), 7), 'yyyy-MM-dd');
      
      toast.info(`Fetching Tradier orders from ${startDate} to ${endDate}...`);
      
      // First, try to import any missing trades
      const importResult = await importMissingTrades(startDate, endDate);
      if (importResult.imported > 0) {
        toast.success(`Imported ${importResult.imported} missing trades from Tradier`);
      }
      
      // Then reconcile existing trades that need it
      const reconcileResult = await reconcileFromTradierFills(startDate, endDate);
      
      if (reconcileResult.success) {
        if (reconcileResult.reconciled > 0) {
          toast.success(`Reconciled ${reconcileResult.reconciled} trades with Tradier fills`);
        } else {
          toast.info('No trades needed reconciliation');
        }
        
        if (reconcileResult.mismatches.length > 0) {
          console.warn('Reconciliation mismatches:', reconcileResult.mismatches);
          toast.warning(`${reconcileResult.mismatches.length} trades could not be matched - check console`);
        }
        
        if (reconcileResult.errors.length > 0) {
          console.error('Reconciliation errors:', reconcileResult.errors);
        }
        
        loadTrades();
      } else {
        toast.error('Reconciliation failed - check console for details');
      }
    } catch (error) {
      console.error('Error in reconciliation:', error);
      toast.error('Error reconciling from Tradier');
    } finally {
      setIsReconciling(false);
    }
  };

  return (
    <>
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
                {countByLeg ? 'Legs' : 'Strategies'}: <span className="text-foreground">{stats.totalTrades}</span>
                {!countByLeg && <span className="text-muted-foreground/60 ml-0.5">({stats.totalLegs}L)</span>}
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

            {/* Controls Row */}
            <div className="flex items-center justify-between gap-4 mb-4">
              {/* Maintenance Actions */}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRecalculatePnl();
                  }}
                  disabled={isRecalculating}
                >
                  {isRecalculating ? (
                    <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Calculator className="h-3 w-3 mr-1" />
                  )}
                  Recompute P&L
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDetectDuplicates();
                  }}
                  disabled={isDetectingDuplicates}
                >
                  {isDetectingDuplicates ? (
                    <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Search className="h-3 w-3 mr-1" />
                  )}
                  Detect Duplicates
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleReconcileFromTradier();
                  }}
                  disabled={isReconciling}
                >
                  {isReconciling ? (
                    <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3 mr-1" />
                  )}
                  Reconcile from Tradier
                </Button>
              </div>

              {/* Count by Leg Toggle */}
              <div className="flex items-center space-x-2" onClick={(e) => e.stopPropagation()}>
                <Switch
                  id="count-by-leg"
                  checked={countByLeg}
                  onCheckedChange={setCountByLeg}
                />
                <Label htmlFor="count-by-leg" className="text-[10px] text-muted-foreground cursor-pointer">
                  Count by leg
                </Label>
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
                                expandedTradeId === trade.id ? "bg-secondary/40" : "hover:bg-secondary/30",
                                trade.needs_reconcile && "border-l-2 border-l-bloomberg-amber"
                              )}
                              onClick={() => toggleTradeExpanded(trade.id!)}
                            >
                              <TableCell className="py-1.5 w-8">
                                <div className="flex items-center gap-1">
                                  {trade.needs_reconcile && (
                                    <AlertTriangle className="h-3 w-3 text-bloomberg-amber" />
                                  )}
                                  <ChevronRight 
                                    className={cn(
                                      "h-4 w-4 text-muted-foreground transition-transform",
                                      expandedTradeId === trade.id && "rotate-90"
                                    )} 
                                  />
                                </div>
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

      {/* Duplicates Confirmation Dialog */}
      <Dialog open={showDuplicatesDialog} onOpenChange={setShowDuplicatesDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-bloomberg-amber" />
              Duplicate Trades Detected
            </DialogTitle>
            <DialogDescription>
              Found {duplicateCandidates.length} potential duplicate trades based on matching close_order_id.
              Review and select which ones to delete.
            </DialogDescription>
          </DialogHeader>
          
          <div className="max-h-[300px] overflow-auto space-y-2">
            {duplicateCandidates.map((candidate) => (
              <div 
                key={candidate.id}
                className={cn(
                  "flex items-center gap-3 p-2 rounded border",
                  selectedDuplicates.has(candidate.id) 
                    ? "border-panic-red/50 bg-panic-red/10" 
                    : "border-border bg-secondary/20"
                )}
              >
                <input
                  type="checkbox"
                  checked={selectedDuplicates.has(candidate.id)}
                  onChange={() => toggleDuplicateSelection(candidate.id)}
                  className="h-4 w-4"
                />
                <div className="flex-1 text-xs">
                  <div className="font-mono">{candidate.symbol}</div>
                  <div className="text-muted-foreground">{candidate.reason}</div>
                </div>
                <div className="text-xs font-mono">
                  {format(new Date(candidate.exit_time), 'MM/dd HH:mm')}
                </div>
                <div className={cn(
                  "text-xs font-mono",
                  candidate.pnl >= 0 ? "text-trading-green" : "text-panic-red"
                )}>
                  ${candidate.pnl.toFixed(2)}
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDuplicatesDialog(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleDeleteSelectedDuplicates}
              disabled={selectedDuplicates.size === 0 || isDeleting}
            >
              {isDeleting ? (
                <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1" />
              )}
              Delete {selectedDuplicates.size} Selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
