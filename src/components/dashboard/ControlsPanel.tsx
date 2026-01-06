import { motion } from 'framer-motion';
import { Play, Square, Lock, Unlock, AlertTriangle, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Greeks, RiskStatus } from '@/types/trading';

interface ControlsPanelProps {
  greeks: Greeks;
  riskStatus: RiskStatus;
  isBotRunning: boolean;
  onToggleBot: () => void;
  onToggleKillSwitch: () => void;
  onEmergencyClose: () => void;
}

export const ControlsPanel = ({
  greeks,
  riskStatus,
  isBotRunning,
  onToggleBot,
  onToggleKillSwitch,
  onEmergencyClose,
}: ControlsPanelProps) => {
  const [confirmEmergency, setConfirmEmergency] = useState(false);
  
  const deltaDirection = greeks.delta > 10 ? 'Bullish' : greeks.delta < -10 ? 'Bearish' : 'Neutral';
  const deltaColor = greeks.delta > 10 ? 'text-trading-green' : greeks.delta < -10 ? 'text-panic-red' : 'text-muted-foreground';

  return (
    <motion.div
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.2 }}
      className="terminal-panel flex flex-col gap-4"
    >
      {/* Net Greeks Panel */}
      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1.5 mb-3">
          Net Greeks
        </div>
        <div className="grid grid-cols-4 gap-2">
          <div className="text-center">
            <div className="text-[10px] text-muted-foreground mb-0.5">Δ</div>
            <div className={cn("font-mono text-sm font-semibold", deltaColor)}>
              {greeks.delta.toFixed(1)}
            </div>
            <div className="text-[9px] text-muted-foreground">{deltaDirection}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-muted-foreground mb-0.5">Γ</div>
            <div className="font-mono text-sm font-semibold text-foreground">
              {greeks.gamma.toFixed(3)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-muted-foreground mb-0.5">Θ</div>
            <div className={cn(
              "font-mono text-sm font-semibold",
              greeks.theta > 0 ? "text-trading-green" : "text-panic-red"
            )}>
              ${greeks.theta.toFixed(1)}
            </div>
            <div className="text-[9px] text-muted-foreground">
              {greeks.theta > 0 ? 'Earning' : 'Paying'}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-muted-foreground mb-0.5">ν</div>
            <div className="font-mono text-sm font-semibold text-foreground">
              ${greeks.vega.toFixed(1)}
            </div>
          </div>
        </div>
      </div>

      {/* Risk Limits Panel */}
      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1.5 mb-3 flex items-center gap-1.5">
          <Gauge className="w-3 h-3" />
          Risk Limits
        </div>
        <div className="space-y-1.5 text-xs text-muted-foreground">
          <div className="flex justify-between">
            <span>Daily Loss Limit:</span>
            <span className="font-mono text-foreground">${riskStatus.maxDailyLoss.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span>Max Positions:</span>
            <span className="font-mono text-foreground">{riskStatus.maxPositions}</span>
          </div>
          <div className="flex justify-between">
            <span>Trades Today:</span>
            <span className="font-mono text-foreground">{riskStatus.tradeCount}</span>
          </div>
          {riskStatus.killSwitchActive && riskStatus.killSwitchReason && (
            <div className="mt-2 p-2 bg-panic-red/10 border border-panic-red/30 rounded text-panic-red text-[10px]">
              Kill Reason: {riskStatus.killSwitchReason}
            </div>
          )}
        </div>
      </div>

      {/* Controls Panel */}
      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1.5 mb-3">
          Controls
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={onToggleBot}
            disabled={riskStatus.killSwitchActive}
            variant={isBotRunning ? "secondary" : "default"}
            size="sm"
            className={cn(
              "w-full font-mono text-xs",
              isBotRunning 
                ? "bg-secondary hover:bg-secondary/80" 
                : "bg-trading-green hover:bg-trading-green/90 text-black"
            )}
          >
            {isBotRunning ? (
              <>
                <Square className="w-3 h-3 mr-1" />
                STOP
              </>
            ) : (
              <>
                <Play className="w-3 h-3 mr-1" />
                START
              </>
            )}
          </Button>
          
          <Button
            onClick={onToggleKillSwitch}
            variant="secondary"
            size="sm"
            className={cn(
              "w-full font-mono text-xs",
              riskStatus.killSwitchActive && "bg-panic-red/20 border-panic-red text-panic-red hover:bg-panic-red/30"
            )}
          >
            {riskStatus.killSwitchActive ? (
              <>
                <Unlock className="w-3 h-3 mr-1" />
                UNLOCK
              </>
            ) : (
              <>
                <Lock className="w-3 h-3 mr-1" />
                KILL
              </>
            )}
          </Button>
        </div>
        
        {riskStatus.killSwitchActive && (
          <div className="mt-2 text-[10px] text-bloomberg-amber flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            Kill switch blocks start
          </div>
        )}
        
        {/* Emergency Close */}
        <div className="mt-4 pt-4 border-t border-border">
          <div className="flex items-center gap-2 mb-2">
            <Checkbox 
              id="confirm-emergency"
              checked={confirmEmergency}
              onCheckedChange={(checked) => setConfirmEmergency(checked === true)}
              className="border-muted-foreground data-[state=checked]:bg-panic-red data-[state=checked]:border-panic-red"
            />
            <label 
              htmlFor="confirm-emergency" 
              className="text-[10px] text-muted-foreground uppercase tracking-wide cursor-pointer"
            >
              Confirm Close All
            </label>
          </div>
          <Button
            onClick={onEmergencyClose}
            disabled={!confirmEmergency}
            variant="secondary"
            size="sm"
            className="w-full font-mono text-xs bg-panic-red/10 border-panic-red/30 text-panic-red hover:bg-panic-red/20 disabled:opacity-50"
          >
            <AlertTriangle className="w-3 h-3 mr-1" />
            EMERGENCY CLOSE
          </Button>
        </div>
      </div>
    </motion.div>
  );
};
