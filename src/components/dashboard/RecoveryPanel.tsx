import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle, XCircle, RefreshCw, ExternalLink, Clock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { tradeJournal, TradeRecord, CloseStatus } from '@/services/tradeJournal';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';

interface RecoveryPanelProps {
  onRefresh?: () => void;
}

const statusConfig: Record<CloseStatus, { label: string; color: string; icon: React.ReactNode }> = {
  submitted: { label: 'Pending', color: 'text-bloomberg-amber', icon: <Clock className="w-3 h-3" /> },
  filled: { label: 'Filled', color: 'text-trading-green', icon: <CheckCircle className="w-3 h-3" /> },
  rejected: { label: 'Rejected', color: 'text-panic-red', icon: <XCircle className="w-3 h-3" /> },
  canceled: { label: 'Canceled', color: 'text-muted-foreground', icon: <XCircle className="w-3 h-3" /> },
  expired: { label: 'Expired', color: 'text-muted-foreground', icon: <XCircle className="w-3 h-3" /> },
  timeout_unknown: { label: 'Timeout', color: 'text-bloomberg-amber', icon: <AlertTriangle className="w-3 h-3" /> },
};

export const RecoveryPanel = ({ onRefresh }: RecoveryPanelProps) => {
  const [tradesNeedingRecovery, setTradesNeedingRecovery] = useState<TradeRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<TradeRecord | null>(null);
  const [fillPrice, setFillPrice] = useState('');
  const [fillQty, setFillQty] = useState('');
  const [isResolving, setIsResolving] = useState(false);

  const fetchRecoveryTrades = async () => {
    setIsLoading(true);
    try {
      const trades = await tradeJournal.getTradesNeedingRecovery();
      setTradesNeedingRecovery(trades);
    } catch (error) {
      console.error('Error fetching recovery trades:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRecoveryTrades();
    // Poll every 30 seconds for updates
    const interval = setInterval(fetchRecoveryTrades, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleOpenResolveDialog = (trade: TradeRecord) => {
    setSelectedTrade(trade);
    setFillPrice('');
    setFillQty(trade.quantity?.toString() || '');
    setResolveDialogOpen(true);
  };

  const handleResolveAsFilled = async () => {
    if (!selectedTrade?.id) return;

    setIsResolving(true);
    try {
      const result = await tradeJournal.resolveTimedOutTrade(
        selectedTrade.id,
        'filled',
        {
          avgFillPrice: fillPrice ? parseFloat(fillPrice) : undefined,
          filledQty: fillQty ? parseInt(fillQty, 10) : undefined,
        }
      );

      if (result.success) {
        toast({
          title: 'Trade Resolved',
          description: `${selectedTrade.symbol} marked as filled. P&L will be calculated on next reconciliation.`,
        });
        setResolveDialogOpen(false);
        fetchRecoveryTrades();
        onRefresh?.();
      } else {
        toast({
          title: 'Error Resolving Trade',
          description: result.error || 'Unknown error',
          variant: 'destructive',
        });
      }
    } finally {
      setIsResolving(false);
    }
  };

  const handleResolveAsOpen = async () => {
    if (!selectedTrade?.id) return;

    setIsResolving(true);
    try {
      const result = await tradeJournal.resolveTimedOutTrade(selectedTrade.id, 'open');

      if (result.success) {
        toast({
          title: 'Trade Record Removed',
          description: `${selectedTrade.symbol} close order failed - trade record deleted. Position is still open at broker.`,
        });
        setResolveDialogOpen(false);
        fetchRecoveryTrades();
        onRefresh?.();
      } else {
        toast({
          title: 'Error Resolving Trade',
          description: result.error || 'Unknown error',
          variant: 'destructive',
        });
      }
    } finally {
      setIsResolving(false);
    }
  };

  const getTimeSinceSubmission = (trade: TradeRecord): string => {
    if (!trade.close_submitted_at) return 'Unknown';
    const submittedAt = new Date(trade.close_submitted_at);
    const now = new Date();
    const diffMs = now.getTime() - submittedAt.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  // Group trades by close_order_id for combo orders
  const groupedTrades = tradesNeedingRecovery.reduce((acc, trade) => {
    const key = trade.close_order_id || trade.id || 'unknown';
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(trade);
    return acc;
  }, {} as Record<string, TradeRecord[]>);

  if (isLoading) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="terminal-panel p-6"
      >
        <div className="flex items-center justify-center py-8">
          <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground mr-2" />
          <span className="text-sm text-muted-foreground">Loading recovery queue...</span>
        </div>
      </motion.div>
    );
  }

  if (tradesNeedingRecovery.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="terminal-panel p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-trading-green" />
            <span className="text-sm font-medium">Order Recovery</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchRecoveryTrades}
            className="h-7 text-xs"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Refresh
          </Button>
        </div>
        <div className="text-center py-8 text-muted-foreground">
          <CheckCircle className="w-8 h-8 mx-auto mb-2 text-trading-green/50" />
          <p className="text-sm">No orders need recovery</p>
          <p className="text-xs mt-1">All close orders are processed normally</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="terminal-panel p-6"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-bloomberg-amber" />
          <span className="text-sm font-medium">Order Recovery</span>
          <span className="text-xs text-muted-foreground bg-bloomberg-amber/20 px-1.5 py-0.5 rounded">
            {Object.keys(groupedTrades).length} order{Object.keys(groupedTrades).length !== 1 ? 's' : ''}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchRecoveryTrades}
          className="h-7 text-xs"
        >
          <RefreshCw className="w-3 h-3 mr-1" />
          Refresh
        </Button>
      </div>

      <div className="text-xs text-muted-foreground mb-4 p-2 bg-bloomberg-amber/10 border border-bloomberg-amber/30 rounded">
        <AlertTriangle className="w-3 h-3 inline mr-1" />
        These orders timed out or were rejected. Verify their actual status in Tradier before resolving.
      </div>

      <div className="space-y-3">
        {Object.entries(groupedTrades).map(([orderId, trades]) => {
          const firstTrade = trades[0];
          const status = firstTrade.close_status as CloseStatus;
          const config = statusConfig[status] || statusConfig.timeout_unknown;
          const isCombo = trades.length > 1;

          return (
            <div
              key={orderId}
              className="border border-border rounded-lg p-3 bg-secondary/30"
            >
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={cn('flex items-center gap-1', config.color)}>
                      {config.icon}
                      <span className="text-xs font-medium">{config.label}</span>
                    </span>
                    {isCombo && (
                      <span className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        {trades.length}-leg combo
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Order #{orderId.slice(0, 8)}... | {getTimeSinceSubmission(firstTrade)}
                  </div>
                </div>
                <a
                  href={`https://dash.tradier.com/orders/${orderId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />
                  Tradier
                </a>
              </div>

              <div className="space-y-1.5 mb-3">
                {trades.map((trade) => (
                  <div key={trade.id} className="flex items-center justify-between text-xs">
                    <span className="font-mono">{trade.symbol}</span>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>Qty: {trade.quantity}</span>
                      <span>Entry: ${trade.entry_price?.toFixed(2) || '?'}</span>
                    </div>
                  </div>
                ))}
              </div>

              {firstTrade.close_reject_reason && (
                <div className="text-xs text-panic-red/80 mb-3 p-2 bg-panic-red/10 rounded">
                  {firstTrade.close_reject_reason}
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1 text-xs h-7 bg-trading-green/20 hover:bg-trading-green/30 text-trading-green border-trading-green/30"
                  onClick={() => handleOpenResolveDialog(firstTrade)}
                >
                  <CheckCircle className="w-3 h-3 mr-1" />
                  Mark Filled
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1 text-xs h-7 bg-panic-red/20 hover:bg-panic-red/30 text-panic-red border-panic-red/30"
                  onClick={() => {
                    setSelectedTrade(firstTrade);
                    handleResolveAsOpen();
                  }}
                  disabled={isResolving}
                >
                  <Trash2 className="w-3 h-3 mr-1" />
                  Not Filled
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Resolve as Filled Dialog */}
      <Dialog open={resolveDialogOpen} onOpenChange={setResolveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Resolve Order as Filled</DialogTitle>
            <DialogDescription>
              Enter the actual fill details from Tradier. Leave blank to use defaults.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Symbol</label>
              <div className="font-mono text-sm bg-muted px-3 py-2 rounded">
                {selectedTrade?.symbol}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Fill Price (optional)</label>
              <Input
                type="number"
                step="0.01"
                placeholder="e.g., 1.25"
                value={fillPrice}
                onChange={(e) => setFillPrice(e.target.value)}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Net exit debit for combo orders, per-contract price for singles
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Fill Quantity</label>
              <Input
                type="number"
                step="1"
                placeholder={selectedTrade?.quantity?.toString() || '1'}
                value={fillQty}
                onChange={(e) => setFillQty(e.target.value)}
                className="font-mono"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setResolveDialogOpen(false)}
              disabled={isResolving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleResolveAsFilled}
              disabled={isResolving}
              className="bg-trading-green hover:bg-trading-green/90 text-black"
            >
              {isResolving ? (
                <>
                  <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
                  Resolving...
                </>
              ) : (
                <>
                  <CheckCircle className="w-3 h-3 mr-1" />
                  Confirm Filled
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};
