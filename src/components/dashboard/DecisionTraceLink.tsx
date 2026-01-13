import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, XCircle, Activity, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from '@/lib/utils';
import { evaluationService } from '@/services/evaluationService';
import type { StrategyEvaluation, Gate } from '@/types/evaluation';
import { format } from 'date-fns';

interface DecisionTraceLinkProps {
  tradeGroupId: string;
}

export const DecisionTraceLink = ({ tradeGroupId }: DecisionTraceLinkProps) => {
  const [evaluations, setEvaluations] = useState<StrategyEvaluation[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const loadEvaluations = async () => {
    setIsLoading(true);
    const data = await evaluationService.getEvaluationsForTradeGroup(tradeGroupId);
    setEvaluations(data);
    setIsLoading(false);
  };

  const handleOpen = () => {
    setIsOpen(true);
    loadEvaluations();
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

  const getEventTypeBadge = (eventType: string) => {
    const variants: Record<string, string> = {
      evaluation: 'bg-muted text-muted-foreground',
      entry_attempt: 'bg-bloomberg-blue/20 text-bloomberg-blue',
      entry_submitted: 'bg-trading-green/20 text-trading-green',
      entry_filled: 'bg-trading-green/20 text-trading-green',
      exit_attempt: 'bg-bloomberg-amber/20 text-bloomberg-amber',
      exit_filled: 'bg-trading-green/20 text-trading-green',
      exit_rejected: 'bg-panic-red/20 text-panic-red',
    };
    return variants[eventType] || variants.evaluation;
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 text-[10px] text-bloomberg-blue hover:text-bloomberg-blue/80"
        onClick={handleOpen}
      >
        <Activity className="h-3 w-3 mr-1" />
        Decision Trace
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-bloomberg-amber" />
              Decision Trace for Trade Group
            </DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading evaluations...</div>
          ) : evaluations.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No evaluations found for this trade group.</div>
          ) : (
            <div className="space-y-4">
              {evaluations.map((evaluation) => (
                <EvaluationCard key={evaluation.id} evaluation={evaluation} />
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

interface EvaluationCardProps {
  evaluation: StrategyEvaluation;
}

const EvaluationCard = ({ evaluation }: EvaluationCardProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

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

  const getEventTypeBadge = (eventType: string) => {
    const variants: Record<string, string> = {
      evaluation: 'bg-muted text-muted-foreground',
      entry_attempt: 'bg-bloomberg-blue/20 text-bloomberg-blue',
      entry_submitted: 'bg-trading-green/20 text-trading-green',
      entry_filled: 'bg-trading-green/20 text-trading-green',
      exit_attempt: 'bg-bloomberg-amber/20 text-bloomberg-amber',
      exit_filled: 'bg-trading-green/20 text-trading-green',
      exit_rejected: 'bg-panic-red/20 text-panic-red',
    };
    return variants[eventType] || variants.evaluation;
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div 
        className="flex items-center justify-between p-3 bg-secondary/30 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <Badge className={cn("text-[10px] border", getEventTypeBadge(evaluation.event_type))}>
            {evaluation.event_type}
          </Badge>
          <Badge className={cn("text-[10px] border", getDecisionBadge(evaluation.decision))}>
            {evaluation.decision}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {format(new Date(evaluation.created_at), 'MM/dd/yyyy HH:mm:ss')}
          </span>
        </div>
        {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </div>

      {isExpanded && (
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
          {evaluation.gates_json.length > 0 && (
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
                        <TableCell className="text-xs font-mono py-2 max-w-[200px] truncate">
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
          )}

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
        </motion.div>
      )}
    </div>
  );
};