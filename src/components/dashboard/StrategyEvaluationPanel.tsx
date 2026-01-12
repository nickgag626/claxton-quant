import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, XCircle, Clock, RefreshCw, Copy, ChevronDown, ChevronUp, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { evaluationService } from '@/services/evaluationService';
import type { StrategyEvaluation, Gate } from '@/types/evaluation';
import { toast } from 'sonner';
import { format } from 'date-fns';

interface StrategyEvaluationPanelProps {
  strategyId: string;
  strategyName: string;
}

export const StrategyEvaluationPanel = ({ strategyId, strategyName }: StrategyEvaluationPanelProps) => {
  const [evaluation, setEvaluation] = useState<StrategyEvaluation | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const loadEvaluation = async () => {
    setIsLoading(true);
    const data = await evaluationService.getLatestEvaluation(strategyId);
    setEvaluation(data);
    setIsLoading(false);
  };

  useEffect(() => {
    loadEvaluation();
  }, [strategyId]);

  const handleRunEvaluation = async () => {
    setIsRunning(true);
    try {
      const result = await evaluationService.runEvaluation(strategyId);
      if (result) {
        setEvaluation(result);
        toast.success('Evaluation completed');
      } else {
        toast.error('Evaluation failed');
      }
    } catch (error) {
      toast.error('Error running evaluation');
    }
    setIsRunning(false);
  };

  const handleCopyJson = () => {
    if (evaluation) {
      navigator.clipboard.writeText(JSON.stringify(evaluation, null, 2));
      toast.success('JSON copied to clipboard');
    }
  };

  const getDecisionBadge = (decision: string) => {
    const variants: Record<string, string> = {
      PASS: 'bg-trading-green/20 text-trading-green border-trading-green/30',
      OPEN: 'bg-trading-green/20 text-trading-green border-trading-green/30',
      FAIL: 'bg-panic-red/20 text-panic-red border-panic-red/30',
      SKIP: 'bg-bloomberg-amber/20 text-bloomberg-amber border-bloomberg-amber/30',
      CLOSE: 'bg-bloomberg-blue/20 text-bloomberg-blue border-bloomberg-blue/30',
      HOLD: 'bg-muted text-muted-foreground border-border',
    };
    return variants[decision] || variants.HOLD;
  };

  if (isLoading) {
    return (
      <div className="p-4 text-center text-muted-foreground text-sm">
        <RefreshCw className="h-4 w-4 animate-spin inline mr-2" />
        Loading evaluation...
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div 
        className="flex items-center justify-between p-3 bg-secondary/30 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-bloomberg-amber" />
          <span className="text-xs font-medium">Decision Trace</span>
          {evaluation && (
            <>
              <Badge className={cn("text-[10px] border", getDecisionBadge(evaluation.decision))}>
                {evaluation.decision}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                {format(new Date(evaluation.created_at), 'MM/dd HH:mm:ss')}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              handleRunEvaluation();
            }}
            disabled={isRunning}
          >
            {isRunning ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <RefreshCw className="h-3 w-3 mr-1" />
                Run Now
              </>
            )}
          </Button>
          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && evaluation && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          className="p-4 space-y-4 border-t border-border"
        >
          {/* Reason */}
          {evaluation.reason && (
            <div className="text-sm">
              <span className="text-muted-foreground">Reason: </span>
              <span className="text-foreground">{evaluation.reason}</span>
            </div>
          )}

          {/* Gates Table */}
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
              Gate Evaluations
            </div>
            <div className="border border-border rounded overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary/30">
                    <TableHead className="text-[10px] h-8">Gate</TableHead>
                    <TableHead className="text-[10px] h-8">Expected</TableHead>
                    <TableHead className="text-[10px] h-8">Actual</TableHead>
                    <TableHead className="text-[10px] h-8 w-16">Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(evaluation.gates_json as Gate[]).map((gate, idx) => (
                    <TableRow key={idx} className={cn(
                      gate.pass ? "bg-trading-green/5" : "bg-panic-red/5"
                    )}>
                      <TableCell className="text-xs font-mono py-2">{gate.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground py-2">{gate.expected}</TableCell>
                      <TableCell className="text-xs font-mono py-2">
                        {typeof gate.actual === 'object' 
                          ? JSON.stringify(gate.actual) 
                          : String(gate.actual)}
                      </TableCell>
                      <TableCell className="py-2">
                        {gate.pass ? (
                          <CheckCircle className="h-4 w-4 text-trading-green" />
                        ) : (
                          <XCircle className="h-4 w-4 text-panic-red" />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Inputs Summary */}
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                Market Inputs
              </div>
              <div className="space-y-1 font-mono text-muted-foreground">
                {evaluation.inputs_json?.market && Object.entries(evaluation.inputs_json.market).map(([key, value]) => (
                  <div key={key} className="flex justify-between">
                    <span>{key}:</span>
                    <span className="text-foreground">
                      {typeof value === 'object' ? JSON.stringify(value).slice(0, 30) + '...' : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                Account Inputs
              </div>
              <div className="space-y-1 font-mono text-muted-foreground">
                {evaluation.inputs_json?.account && Object.entries(evaluation.inputs_json.account).map(([key, value]) => (
                  <div key={key} className="flex justify-between">
                    <span>{key}:</span>
                    <span className="text-foreground">{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Proposed Order */}
          {evaluation.proposed_order_json && (
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                Proposed Order
              </div>
              <div className="p-2 bg-secondary/30 rounded font-mono text-xs space-y-1">
                {evaluation.proposed_order_json.legs?.map((leg: any, idx: number) => (
                  <div key={idx} className="flex gap-2">
                    <span className={cn(
                      leg.side?.includes('sell') ? 'text-trading-green' : 'text-panic-red'
                    )}>{leg.side}</span>
                    <span>{leg.role}</span>
                    <span className="text-muted-foreground">@{leg.strike}</span>
                    <span className="text-muted-foreground">Δ{leg.delta?.toFixed(3)}</span>
                  </div>
                ))}
                {evaluation.proposed_order_json.estimated_credit && (
                  <div className="text-trading-green">
                    Est. Credit: ${evaluation.proposed_order_json.estimated_credit.toFixed(2)}
                  </div>
                )}
                {evaluation.proposed_order_json.estimated_max_loss && (
                  <div className="text-panic-red">
                    Max Loss: ${evaluation.proposed_order_json.estimated_max_loss.toFixed(2)}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Copy JSON Button */}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={handleCopyJson}>
              <Copy className="h-3 w-3 mr-1" />
              Copy JSON
            </Button>
          </div>
        </motion.div>
      )}

      {/* No Evaluation State */}
      {isExpanded && !evaluation && (
        <div className="p-4 text-center text-muted-foreground text-sm">
          No evaluation recorded yet. Click "Run Now" to evaluate.
        </div>
      )}
    </div>
  );
};
