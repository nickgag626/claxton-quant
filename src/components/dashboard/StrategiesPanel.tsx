import { useState } from 'react';
import { motion } from 'framer-motion';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Settings, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StrategyBuilder } from './StrategyBuilder';
import type { Strategy } from '@/types/trading';

interface StrategiesPanelProps {
  strategies: Strategy[];
  onToggleStrategy: (id: string) => void;
  onAddStrategy?: (strategy: Omit<Strategy, 'id'>) => void;
  onDeleteStrategy?: (id: string) => void;
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

export const StrategiesPanel = ({ 
  strategies, 
  onToggleStrategy, 
  onAddStrategy,
  onDeleteStrategy 
}: StrategiesPanelProps) => {
  const [showBuilder, setShowBuilder] = useState(false);
  const [expandedStrategy, setExpandedStrategy] = useState<string | null>(null);

  const handleSaveStrategy = (strategy: Omit<Strategy, 'id'>) => {
    onAddStrategy?.(strategy);
    setShowBuilder(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4 }}
      className="space-y-4"
    >
      {/* Header */}
      <div className="terminal-panel">
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
            <Settings className="w-3 h-3" />
            Trading Strategies
          </div>
          <Button 
            variant="secondary" 
            size="sm" 
            onClick={() => setShowBuilder(!showBuilder)}
            className="text-xs"
          >
            <Plus className="w-3 h-3 mr-1" />
            {showBuilder ? 'Hide Builder' : 'New Strategy'}
          </Button>
        </div>
      </div>

      {/* Strategy Builder */}
      {showBuilder && (
        <StrategyBuilder 
          onSaveStrategy={handleSaveStrategy}
          onClose={() => setShowBuilder(false)}
        />
      )}

      {/* Strategy List */}
      <div className="terminal-panel">
        {strategies.length === 0 ? (
          <div className="text-center text-muted-foreground text-sm py-8">
            No strategies configured. Click "New Strategy" to create one!
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
                  "rounded-md border transition-all",
                  strategy.enabled 
                    ? "bg-trading-green/5 border-trading-green/30" 
                    : "bg-secondary/30 border-border"
                )}
              >
                <div 
                  className="p-3 cursor-pointer"
                  onClick={() => setExpandedStrategy(
                    expandedStrategy === strategy.id ? null : strategy.id
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
                        {strategy.entryConditions.minDte === 0 && strategy.entryConditions.maxDte === 0 && (
                          <Badge 
                            variant="secondary" 
                            className="text-[9px] px-1.5 py-0 bg-panic-red/20 text-panic-red border-0"
                          >
                            0DTE
                          </Badge>
                        )}
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
                        onClick={(e) => e.stopPropagation()}
                        className="data-[state=checked]:bg-trading-green"
                      />
                      <ChevronRight className={cn(
                        "w-4 h-4 text-muted-foreground transition-transform",
                        expandedStrategy === strategy.id && "rotate-90"
                      )} />
                    </div>
                  </div>
                </div>
                
                {/* Expanded Details */}
                {expandedStrategy === strategy.id && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="border-t border-border px-3 py-3 bg-background/50"
                  >
                    <div className="grid grid-cols-3 gap-4 text-xs">
                      <div>
                        <h5 className="text-[10px] text-bloomberg-amber uppercase tracking-wider mb-2">Entry Rules</h5>
                        <div className="space-y-1 text-muted-foreground">
                          <div>DTE Range: <span className="text-foreground">{strategy.entryConditions.minDte} - {strategy.entryConditions.maxDte}</span></div>
                          <div>Max Delta: <span className="text-foreground">{strategy.entryConditions.maxDelta}</span></div>
                          {strategy.entryConditions.minPremium && (
                            <div>Min Premium: <span className="text-foreground">${strategy.entryConditions.minPremium}</span></div>
                          )}
                          {strategy.entryConditions.minIvRank && (
                            <div>IV Rank: <span className="text-foreground">{strategy.entryConditions.minIvRank}-{strategy.entryConditions.maxIvRank}%</span></div>
                          )}
                          <div>Market Hours: <span className="text-foreground">{strategy.entryConditions.marketHoursOnly ? 'Yes' : 'No'}</span></div>
                        </div>
                      </div>
                      <div>
                        <h5 className="text-[10px] text-bloomberg-amber uppercase tracking-wider mb-2">Exit Rules</h5>
                        <div className="space-y-1 text-muted-foreground">
                          <div>Profit Target: <span className="text-trading-green">{strategy.exitConditions.profitTargetPercent}%</span></div>
                          <div>Stop Loss: <span className="text-panic-red">{strategy.exitConditions.stopLossPercent}%</span></div>
                          {strategy.exitConditions.timeStopDte !== undefined && (
                            <div>DTE Stop: <span className="text-foreground">{strategy.exitConditions.timeStopDte} days</span></div>
                          )}
                          {strategy.exitConditions.timeStopTime && (
                            <div>Time Stop: <span className="text-foreground">{strategy.exitConditions.timeStopTime}</span></div>
                          )}
                          {strategy.exitConditions.trailingStopPercent && (
                            <div>Trailing: <span className="text-foreground">{strategy.exitConditions.trailingStopPercent}%</span></div>
                          )}
                        </div>
                      </div>
                      <div>
                        <h5 className="text-[10px] text-bloomberg-amber uppercase tracking-wider mb-2">Position Sizing</h5>
                        <div className="space-y-1 text-muted-foreground">
                          <div>Max Positions: <span className="text-foreground">{strategy.maxPositions}</span></div>
                          <div>Contracts: <span className="text-foreground">{strategy.positionSize}</span></div>
                        </div>
                        
                        {onDeleteStrategy && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onDeleteStrategy(strategy.id)}
                            className="mt-3 text-panic-red hover:bg-panic-red/20"
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Delete
                          </Button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
};
