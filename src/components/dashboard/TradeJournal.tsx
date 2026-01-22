import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { tradeJournal, TradeRecord, TradeGroup, TradeStats, DuplicateCandidate, hasVerifiedDirection, isClosePending, isCloseRejected, isPnlFinalized, CloseStatus, PnlStatus } from '@/services/tradeJournal';
import { reconcileFromTradierFills, importMissingTrades } from '@/services/tradierReconcile';
import { supabase } from '@/integrations/supabase/client';
import { format, subDays } from 'date-fns';
import { ChevronDown, ChevronUp, ChevronRight, Edit2, Save, X, Clock, DollarSign, TrendingUp, TrendingDown, Tag, FileText, Layers, Calculator, Search, AlertTriangle, Trash2, RefreshCw, Download, CheckCircle, XCircle, Loader2, Ban, Activity } from 'lucide-react';
import { DecisionTraceLink } from './DecisionTraceLink';
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
  onNotesChange,
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

  const isVerified = hasVerifiedDirection(trade);
  const isPending = isClosePending(trade);
  const isRejected = isCloseRejected(trade);
  const pnlDisplay = trade.pnl != null && !isPending && !isRejected ? trade.pnl : null;

  // Close status badge helper
  const getCloseStatusBadge = () => {
    if (isPending) {
      return (
        <div className="flex items-center gap-1 text-xs text-bloomberg-blue bg-bloomberg-blue/10 px-2 py-0.5 rounded">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Pending close</span>
        </div>
      );
    }
    if (isRejected) {
      return (
        <div className="flex items-center gap-1 text-xs text-panic-red bg-panic-red/10 px-2 py-0.5 rounded">
          <Ban className="h-3 w-3" />
          <span>Close rejected: {trade.close_reject_reason || trade.close_status}</span>
        </div>
      );
    }
    if (trade.close_status === 'filled' && isVerified) {
      return (
        <div className="flex items-center gap-1 text-xs text-trading-green bg-trading-green/10 px-2 py-0.5 rounded">
          <CheckCircle className="h-3 w-3" />
          <span>Verified (Filled)</span>
        </div>
      );
    }
    if (isVerified) {
      return (
        <div className="flex items-center gap-1 text-xs text-trading-green bg-trading-green/10 px-2 py-0.5 rounded">
          <CheckCircle className="h-3 w-3" />
          <span>Verified</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1 text-xs text-bloomberg-amber bg-bloomberg-amber/10 px-2 py-0.5 rounded">
        <XCircle className="h-3 w-3" />
        <span>Unverified - Excluded from totals</span>
      </div>
    );
  };

  // P&L status badge helper
  const getPnlStatusBadge = () => {
    const status = trade.pnl_status as PnlStatus | undefined;
    switch (status) {
      case 'final':
        return (
          <div className="flex items-center gap-1 text-xs text-trading-green bg-trading-green/10 px-2 py-0.5 rounded">
            <CheckCircle className="h-3 w-3" />
            <span>Final (Locked)</span>
          </div>
        );
      case 'computed':
        return (
          <div className="flex items-center gap-1 text-xs text-bloomberg-blue bg-bloomberg-blue/10 px-2 py-0.5 rounded">
            <Calculator className="h-3 w-3" />
            <span>Computed</span>
          </div>
        );
      case 'missing_fills':
        return (
          <div className="flex items-center gap-1 text-xs text-bloomberg-amber bg-bloomberg-amber/10 px-2 py-0.5 rounded">
            <AlertTriangle className="h-3 w-3" />
            <span>Missing Fills</span>
          </div>
        );
      case 'pending':
      default:
        return (
          <div className="flex items-center gap-1 text-xs text-muted-foreground bg-muted/10 px-2 py-0.5 rounded">
            <Clock className="h-3 w-3" />
            <span>Pending</span>
          </div>
        );
    }
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
          {/* Close Status Warning - Pending or Rejected */}
          {isPending && (
            <div className="flex items-center gap-2 p-3 bg-bloomberg-blue/20 border border-bloomberg-blue/30 rounded">
              <Loader2 className="h-4 w-4 text-bloomberg-blue animate-spin" />
              <span className="text-xs text-bloomberg-blue font-medium">Close order pending – P&L not yet computed</span>
              <span className="text-xs text-muted-foreground ml-2">Order ID: {trade.close_order_id}</span>
            </div>
          )}
          
          {isRejected && (
            <div className="flex items-center gap-2 p-3 bg-panic-red/20 border border-panic-red/30 rounded">
              <Ban className="h-4 w-4 text-panic-red" />
              <span className="text-xs text-panic-red font-medium">Close order {trade.close_status}: {trade.close_reject_reason || 'Unknown reason'}</span>
              <span className="text-xs text-muted-foreground ml-2">Trade still OPEN – no P&L booked</span>
            </div>
          )}
          
          {/* Reconciliation Warning - Direction unknown */}
          {trade.needs_reconcile && !isPending && !isRejected && (
            <div className="flex items-center gap-2 p-3 bg-bloomberg-amber/20 border border-bloomberg-amber/30 rounded">
              <AlertTriangle className="h-4 w-4 text-bloomberg-amber" />
              <span className="text-xs text-bloomberg-amber font-medium">Needs reconcile – direction unknown</span>
              <span className="text-xs text-bloomberg-amber/70">
                (Missing: {!trade.open_side ? 'open_side ' : ''}{!trade.close_side ? 'close_side ' : ''}{!trade.close_order_id ? 'close_order_id' : ''})
              </span>
              <span className="text-xs text-muted-foreground ml-2">Use "Reconcile from Tradier" to auto-verify</span>
            </div>
          )}

          {/* Verification Status Badges */}
          <div className="flex items-center gap-2 flex-wrap">
            {getCloseStatusBadge()}
            {getPnlStatusBadge()}
            {trade.pnl_computed_at && (
              <span className="text-[10px] text-muted-foreground">
                P&L computed: {format(new Date(trade.pnl_computed_at), 'MM/dd HH:mm')}
              </span>
            )}
          </div>

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
                {pnlDisplay != null && pnlDisplay >= 0 ? <TrendingUp className="h-3 w-3 text-trading-green" /> : <TrendingDown className="h-3 w-3 text-panic-red" />}
                Profit/Loss
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Realized P&L:</span>
                  {trade.pnl_status === 'missing_fills' ? (
                    <span className="font-mono text-bloomberg-amber" title="Incomplete fill data">—</span>
                  ) : pnlDisplay != null ? (
                    <span className={cn("font-mono font-semibold", pnlDisplay >= 0 ? "text-trading-green" : "text-panic-red")}>
                      {pnlDisplay >= 0 ? '+' : ''}${Number(pnlDisplay).toFixed(2)}
                    </span>
                  ) : (
                    <span className="font-mono text-muted-foreground">--</span>
                  )}
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">P&L %:</span>
                  {trade.pnl_status === 'missing_fills' ? (
                    <span className="font-mono text-bloomberg-amber">—</span>
                  ) : trade.pnl_percent != null ? (
                    <span className={cn("font-mono", trade.pnl_percent >= 0 ? "text-trading-green" : "text-panic-red")}>
                      {trade.pnl_percent >= 0 ? '+' : ''}{Number(trade.pnl_percent).toFixed(1)}%
                    </span>
                  ) : (
                    <span className="font-mono text-muted-foreground">--</span>
                  )}
                </div>
                {(trade.entry_credit != null || trade.entry_credit_dollars != null) && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Entry Credit:</span>
                    <span className="font-mono">
                      ${Number(trade.entry_credit_dollars ?? trade.entry_credit).toFixed(2)}
                      {trade.entry_credit_dollars != null && (
                        <span className="text-[9px] text-trading-green ml-1" title="From actual fills">✓</span>
                      )}
                    </span>
                  </div>
                )}
                {(trade.exit_debit != null || trade.exit_debit_dollars != null) && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Exit Debit:</span>
                    <span className="font-mono">
                      ${Number(trade.exit_debit_dollars ?? trade.exit_debit).toFixed(2)}
                      {trade.exit_debit_dollars != null && (
                        <span className="text-[9px] text-trading-green ml-1" title="From actual fills">✓</span>
                      )}
                    </span>
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
                  <span className={cn("font-mono", trade.open_side?.includes('sell') ? "text-trading-green" : trade.open_side ? "text-bloomberg-amber" : "text-muted-foreground")}>
                    {trade.open_side || '--'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Open Order:</span>
                  <span className="font-mono text-[9px] truncate max-w-[80px]" title={trade.open_order_id || 'N/A'}>
                    {trade.open_order_id ? `#${trade.open_order_id}` : '--'}
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Close Side:</span>
                  <span className={cn("font-mono", trade.close_side?.includes('buy') ? "text-panic-red" : trade.close_side ? "text-bloomberg-amber" : "text-muted-foreground")}>
                    {trade.close_side || '--'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Close Order:</span>
                  <span className="font-mono text-[9px] truncate max-w-[80px]" title={trade.close_order_id || 'N/A'}>
                    {trade.close_order_id ? `#${trade.close_order_id}` : '--'}
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Fees:</span>
                  <span className="font-mono">${Number(trade.fees || 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reconcile:</span>
                  <span className={cn("font-mono", trade.needs_reconcile ? "text-bloomberg-amber" : "text-trading-green")}>
                    {trade.needs_reconcile ? 'Yes' : 'No'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Close Status:</span>
                  <span className={cn(
                    "font-mono",
                    trade.close_status === 'filled' ? "text-trading-green" :
                    trade.close_status === 'submitted' ? "text-bloomberg-blue" :
                    trade.close_status === 'rejected' || trade.close_status === 'canceled' || trade.close_status === 'expired' ? "text-panic-red" :
                    "text-muted-foreground"
                  )}>
                    {trade.close_status || 'legacy'}
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
  const pnlDisplay = group.needsReconcile ? null : group.totalPnl;
  // Get P&L status from primary leg (first trade)
  const primaryLeg = group.trades[0];
  const pnlStatus = primaryLeg?.pnl_status as PnlStatus | undefined;
  const isPnlFinal = pnlStatus === 'computed' || pnlStatus === 'final';
  const isMissingFills = pnlStatus === 'missing_fills';

  return (
    <React.Fragment key={group.groupId}>
      <TableRow 
        className={cn(
          "border-border cursor-pointer transition-colors",
          isExpanded ? "bg-primary/10" : "hover:bg-secondary/30",
          group.needsReconcile && "border-l-2 border-l-bloomberg-amber"
        )}
        onClick={onToggle}
      >
        <TableCell className="py-1.5 w-8">
          <div className="flex items-center gap-1">
            <Layers className="h-3 w-3 text-primary" />
            {group.needsReconcile && (
              <AlertTriangle className="h-3 w-3 text-bloomberg-amber" />
            )}
            <span title="Has Decision Trace">
              <Activity className="h-3 w-3 text-bloomberg-blue" />
            </span>
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
          isMissingFills ? "text-bloomberg-amber" :
          pnlDisplay != null ? (pnlDisplay >= 0 ? "text-trading-green" : "text-panic-red") : "text-muted-foreground"
        )}>
          {isMissingFills ? (
            <span title="Incomplete fill data">—</span>
          ) : pnlDisplay != null ? (
            <span className="flex items-center justify-end gap-1">
              {pnlDisplay >= 0 ? '+' : ''}${Number(pnlDisplay).toFixed(2)}
              {isPnlFinal && <CheckCircle className="h-3 w-3 text-trading-green/60" />}
            </span>
          ) : '--'}
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground py-1.5">
          <div className="flex items-center gap-2">
            <span>{group.exitReason || '--'}</span>
          </div>
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
              {group.needsReconcile && (
                <div className="flex items-center gap-2 text-xs text-bloomberg-amber bg-bloomberg-amber/10 p-2 rounded">
                  <AlertTriangle className="h-3 w-3" />
                  <span>Some legs need reconciliation - P&L excluded from totals</span>
                </div>
              )}
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">
                Legs in this spread
              </div>
              {group.trades.map((leg, idx) => {
                const legPnl = leg.pnl != null && !leg.needs_reconcile ? leg.pnl : null;
                // Use stable key: prefer id, fallback to unique composite key
                const legKey = leg.id || `${leg.symbol}-${leg.exit_time}-${leg.quantity}-${idx}`;
                return (
                  <div key={legKey} className={cn(
                    "flex items-center justify-between text-xs bg-background/50 rounded px-2 py-1.5",
                    leg.needs_reconcile && "border border-bloomberg-amber/30"
                  )}>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-[10px] w-4">{idx + 1}.</span>
                      <span className="font-mono">{leg.symbol}</span>
                      <span className="text-muted-foreground">×{leg.quantity}</span>
                      <span className={cn(
                        "text-[9px] px-1 rounded",
                        leg.open_side?.includes('sell') ? "bg-trading-green/20 text-trading-green" : 
                        leg.open_side ? "bg-bloomberg-amber/20 text-bloomberg-amber" : "bg-muted/20 text-muted-foreground"
                      )}>
                        {leg.open_side || '?'}
                      </span>
                      {leg.needs_reconcile && (
                        <AlertTriangle className="h-3 w-3 text-bloomberg-amber" />
                      )}
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-muted-foreground">
                        ${Number(leg.entry_price).toFixed(4)} → {leg.exit_price != null ? `$${Number(leg.exit_price).toFixed(4)}` : '$?'}
                      </span>
                      {legPnl != null ? (
                        <span className={cn(
                          "font-mono",
                          legPnl >= 0 ? "text-trading-green" : "text-panic-red"
                        )}>
                          {legPnl >= 0 ? '+' : ''}${Number(legPnl).toFixed(2)}
                        </span>
                      ) : (
                        <span className="font-mono text-muted-foreground">--</span>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="flex justify-between items-center pt-2 border-t border-border mt-2">
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground uppercase">
                    Combined P&L {group.needsReconcile && '(partial)'}
                  </span>
                  {isPnlFinal && (
                    <span className="text-[9px] text-trading-green bg-trading-green/10 px-1.5 py-0.5 rounded">
                      Computed
                    </span>
                  )}
                  {isMissingFills && (
                    <span className="text-[9px] text-bloomberg-amber bg-bloomberg-amber/10 px-1.5 py-0.5 rounded">
                      Missing Fills
                    </span>
                  )}
                  <DecisionTraceLink tradeGroupId={group.groupId} />
                </div>
                {isMissingFills ? (
                  <span className="font-mono text-bloomberg-amber" title="Incomplete fill data">—</span>
                ) : pnlDisplay != null ? (
                  <span className={cn(
                    "font-mono font-semibold",
                    pnlDisplay >= 0 ? "text-trading-green" : "text-panic-red"
                  )}>
                    {pnlDisplay >= 0 ? '+' : ''}${Number(pnlDisplay).toFixed(2)}
                  </span>
                ) : (
                  <span className="font-mono text-muted-foreground">--</span>
                )}
              </div>
            </div>
          </TableCell>
        </motion.tr>
      )}
    </React.Fragment>
  );
};

export const TradeJournal = () => {
  const [trades, setTrades] = useState<(TradeRecord | TradeGroup)[]>([]);
  const [flatTrades, setFlatTrades] = useState<TradeRecord[]>([]);
  const [viewMode, setViewMode] = useState<'grouped' | 'flat'>('grouped');
  const [stats, setStats] = useState<TradeStats>({
    totalTrades: 0,
    totalLegs: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalPnl: 0,
    winRate: 0,
    avgWinner: 0,
    avgLoser: 0,
    needsReconcileCount: 0,
    verifiedCount: 0,
  });
  const [todayRealized, setTodayRealized] = useState<{ pnl: number; count: number }>({ pnl: 0, count: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const hasLoadedOnce = useRef(false);
  const loadSeqRef = useRef(0); // Request-sequence guard for loadTrades
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNotes, setEditNotes] = useState('');
  const [isRecalculating, setIsRecalculating] = useState(false);
  const isRecalculatingRef = useRef(false); // Ref for realtime callback
  const [countByLeg, setCountByLeg] = useState(false);
  
  // Duplicate detection state
  const [isDetectingDuplicates, setIsDetectingDuplicates] = useState(false);
  const [duplicateCandidates, setDuplicateCandidates] = useState<DuplicateCandidate[]>([]);
  const [showDuplicatesDialog, setShowDuplicatesDialog] = useState(false);
  const [selectedDuplicates, setSelectedDuplicates] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Reconciliation state
  const [isReconciling, setIsReconciling] = useState(false);

  // Initial load
  useEffect(() => {
    loadTrades();
  }, [viewMode]); // Reload when view mode changes

  // Real-time subscription for trade updates - IGNORE during recompute to prevent partial state
  useEffect(() => {
    const channel = supabase
      .channel('trades-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'trades'
        },
        (payload) => {
          // STABILITY: Skip realtime refreshes while recomputing to prevent partial states
          if (isRecalculatingRef.current) {
            console.log('[TradeJournal] Ignoring realtime update during recompute');
            return;
          }
          console.log('[TradeJournal] Real-time update:', payload.eventType);
          loadTrades(true); // Refresh on any change
        }
      )
      .subscribe();
    
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Polling fallback when expanded (in case real-time doesn't work)
  useEffect(() => {
    if (!isExpanded) return;
    loadTrades(false);
    const interval = window.setInterval(() => {
      loadTrades(true); // Mark as polling to avoid loading state
    }, 5000);
    return () => window.clearInterval(interval);
  }, [isExpanded]);

  // Reload stats when count mode changes
  useEffect(() => {
    loadStats();
  }, [countByLeg]);

  const loadTrades = async (isPolling = false) => {
    // STABILITY: Request-sequence guard to prevent out-of-order overwrites
    const thisSeq = ++loadSeqRef.current;
    
    // Only show loading state on initial load, not during background refresh
    if (!hasLoadedOnce.current) {
      setIsLoading(true);
    } else if (isPolling) {
      setIsRefreshing(true);
    }
    
    const [groupedTradesData, statsData, todayData] = await Promise.all([
      tradeJournal.getGroupedTrades(),
      tradeJournal.getTradeStats(countByLeg),
      tradeJournal.getRealizedTodayPnl(),
    ]);
    
    // Always fetch flat trades for count display
    const allTrades = await tradeJournal.getTrades(500);
    
    // STABILITY: Only apply state if this is still the latest request
    if (thisSeq !== loadSeqRef.current) {
      console.log('[TradeJournal] Stale loadTrades result discarded', { thisSeq, current: loadSeqRef.current });
      return;
    }
    
    setFlatTrades(allTrades);
    
    // Update grouped or flat based on view mode
    if (viewMode === 'grouped') {
      setTrades(groupedTradesData);
    } else {
      // Flat view - show all individual legs
      setTrades(allTrades);
    }
    
    setStats(statsData);
    setTodayRealized({ pnl: todayData.realized, count: todayData.tradeCount });
    
    if (!hasLoadedOnce.current) {
      hasLoadedOnce.current = true;
      setIsLoading(false);
    } else if (isPolling) {
      setIsRefreshing(false);
    }
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

  // Manual override removed - direction is inferred automatically from Tradier executions

  const handleRecalculatePnl = async (force = false) => {
    setIsRecalculating(true);
    isRecalculatingRef.current = true; // Set ref for realtime callback
    try {
      const result = await tradeJournal.recalculatePnl({ force });
      if (result.success) {
        const parts = [];
        if (result.updated > 0) parts.push(`Updated: ${result.updated}`);
        if (result.finalized > 0) parts.push(`Skipped (finalized): ${result.finalized}`);
        if (result.skipped > 0) parts.push(`Skipped (no direction): ${result.skipped}`);
        if (result.sanitized > 0) parts.push(`Sanitized: ${result.sanitized}`);
        toast.success(parts.join(' | ') || 'No changes needed');
        if (result.errors.length > 0) {
          console.warn('P&L recalculation warnings:', result.errors);
          toast.warning(`${result.errors.length} trades had issues - check console`);
        }
        // Single refresh after recompute completes
        await loadTrades();
      } else {
        toast.error('Failed to recalculate P&L');
      }
    } catch (error) {
      console.error('Error recalculating P&L:', error);
      toast.error('Error recalculating P&L');
    } finally {
      setIsRecalculating(false);
      isRecalculatingRef.current = false; // Clear ref
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
        // Show summary
        const verified = reconcileResult.reconciled;
        const stillUnverified = reconcileResult.skipped;
        
        if (verified > 0) {
          toast.success(`Reconciled ${verified} trades with Tradier fills`);
        }
        
        if (stillUnverified > 0) {
          toast.warning(`${stillUnverified} trades still need manual override`);
        }
        
        if (verified === 0 && stillUnverified === 0 && importResult.imported === 0) {
          toast.info('No trades needed reconciliation');
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
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
              Trade Journal
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded bg-primary/20 text-primary font-medium">
              {flatTrades.length} legs · {trades.filter(t => 'groupId' in t).length || Math.ceil(flatTrades.length / 4)} groups
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex gap-3 text-[10px]">
              <span className="text-muted-foreground">
                Today (ET): <span className={cn(
                  todayRealized.pnl >= 0 ? 'text-trading-green' : 'text-panic-red'
                )}>${todayRealized.pnl.toFixed(2)}</span>
                <span className="text-muted-foreground/60 ml-0.5">({todayRealized.count} trades)</span>
              </span>
              <span className="text-muted-foreground mx-1">|</span>
              <span className="text-muted-foreground">
                Verified: <span className="text-trading-green">{stats.verifiedCount}</span>
                {stats.needsReconcileCount > 0 && (
                  <span className="text-bloomberg-amber ml-1">({stats.needsReconcileCount} unverified)</span>
                )}
              </span>
              <span className="text-muted-foreground">
                Win Rate: <span className={cn(
                  stats.winRate >= 50 ? 'text-trading-green' : 'text-panic-red'
                )}>{stats.winRate.toFixed(1)}%</span>
              </span>
              <span className="text-muted-foreground">
                All-Time P&L: <span className={cn(
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
                    handleRecalculatePnl(false);
                  }}
                  disabled={isRecalculating}
                  title="Recompute P&L for pending trades (skips finalized)"
                >
                  {isRecalculating ? (
                    <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Calculator className="h-3 w-3 mr-1" />
                  )}
                  Recompute P&L
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground hover:text-panic-red"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Force recompute will recalculate ALL trades, even finalized ones. Continue?')) {
                      handleRecalculatePnl(true);
                    }
                  }}
                  disabled={isRecalculating}
                  title="Force recompute ALL trades (dev only)"
                >
                  Force
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

              {/* View Mode Toggle */}
              <div className="flex items-center space-x-2" onClick={(e) => e.stopPropagation()}>
                <Select value={viewMode} onValueChange={(v) => setViewMode(v as 'grouped' | 'flat')}>
                  <SelectTrigger className="h-7 w-[100px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="grouped">Grouped</SelectItem>
                    <SelectItem value="flat">Flat</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-[9px] text-muted-foreground">
                  {flatTrades.length} legs / {trades.filter(t => 'groupId' in t || viewMode === 'flat').length} {viewMode === 'grouped' ? 'groups' : 'rows'}
                </span>
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
                        const isPending = trade.close_status === 'submitted';
                        const isRejected = trade.close_status === 'rejected' || trade.close_status === 'canceled' || trade.close_status === 'expired';
                        const tradePnl = trade.pnl != null && !trade.needs_reconcile && !isPending && !isRejected ? trade.pnl : null;
                        
                        return (
                          <React.Fragment key={trade.id}>
                            <TableRow 
                              className={cn(
                                "border-border cursor-pointer transition-colors",
                                expandedTradeId === trade.id ? "bg-secondary/40" : "hover:bg-secondary/30",
                                isPending && "border-l-2 border-l-bloomberg-blue",
                                isRejected && "border-l-2 border-l-panic-red",
                                trade.needs_reconcile && !isPending && !isRejected && "border-l-2 border-l-bloomberg-amber"
                              )}
                              onClick={() => toggleTradeExpanded(trade.id!)}
                            >
                              <TableCell className="py-1.5 w-8">
                                <div className="flex items-center gap-1">
                                  {isPending && <Loader2 className="h-3 w-3 text-bloomberg-blue animate-spin" />}
                                  {isRejected && <Ban className="h-3 w-3 text-panic-red" />}
                                  {trade.needs_reconcile && !isPending && !isRejected && (
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
                                tradePnl != null ? (tradePnl >= 0 ? "text-trading-green" : "text-panic-red") : "text-muted-foreground"
                              )}>
                                {tradePnl != null ? `${tradePnl >= 0 ? '+' : ''}$${Number(tradePnl).toFixed(2)}` : '--'}
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground py-1.5">
                                {trade.exit_reason || '--'}
                              </TableCell>
                            </TableRow>
                            <AnimatePresence>
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
                            </AnimatePresence>
                          </React.Fragment>
                        );
                      })}
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
