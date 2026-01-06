import { motion } from 'framer-motion';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Settings, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Strategy } from '@/types/trading';

interface StrategiesPanelProps {
  strategies: Strategy[];
  onToggleStrategy: (id: string) => void;
}

const strategyTypeLabels: Record<string, string> = {
  iron_condor: 'Iron Condor',
  credit_put_spread: 'Credit Put',
  credit_call_spread: 'Credit Call',
  strangle: 'Strangle',
  straddle: 'Straddle',
  butterfly: 'Butterfly',
  iron_fly: 'Iron Fly',
  custom: 'Custom',
};

export const StrategiesPanel = ({ strategies, onToggleStrategy }: StrategiesPanelProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4 }}
      className="terminal-panel"
    >
      <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1.5 mb-3 flex items-center gap-1.5">
        <Settings className="w-3 h-3" />
        Trading Strategies
      </div>
      
      {strategies.length === 0 ? (
        <div className="text-center text-muted-foreground text-sm py-8">
          No strategies configured
        </div>
      ) : (
        <div className="space-y-2">
          {strategies.map((strategy, index) => (
            <motion.div
              key={strategy.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 * index }}
              className={cn(
                "p-3 rounded-md border transition-all",
                strategy.enabled 
                  ? "bg-trading-green/5 border-trading-green/30" 
                  : "bg-secondary/30 border-border"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-medium text-sm text-foreground truncate">
                      {strategy.name}
                    </h4>
                    <Badge 
                      variant="secondary" 
                      className="text-[9px] px-1.5 py-0 bg-bloomberg-amber/20 text-bloomberg-amber border-0"
                    >
                      {strategyTypeLabels[strategy.type] || strategy.type}
                    </Badge>
                  </div>
                  
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground font-mono">
                    <span>
                      <span className="text-muted-foreground/60">UND:</span> {strategy.underlying}
                    </span>
                    <span>
                      <span className="text-muted-foreground/60">DTE:</span> {strategy.entryConditions.minDte}-{strategy.entryConditions.maxDte}
                    </span>
                    <span>
                      <span className="text-muted-foreground/60">Δ:</span> {strategy.entryConditions.maxDelta}
                    </span>
                    <span>
                      <span className="text-muted-foreground/60">PT:</span> {strategy.exitConditions.profitTargetPercent}%
                    </span>
                    <span>
                      <span className="text-muted-foreground/60">SL:</span> {strategy.exitConditions.stopLossPercent}%
                    </span>
                  </div>
                  
                  {strategy.entryConditions.startTime && strategy.entryConditions.endTime && (
                    <div className="mt-1 text-[10px] text-terminal-blue font-mono">
                      Window: {strategy.entryConditions.startTime} - {strategy.entryConditions.endTime}
                    </div>
                  )}
                </div>
                
                <div className="flex items-center gap-3">
                  <Switch
                    checked={strategy.enabled}
                    onCheckedChange={() => onToggleStrategy(strategy.id)}
                    className="data-[state=checked]:bg-trading-green"
                  />
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </motion.div>
  );
};
