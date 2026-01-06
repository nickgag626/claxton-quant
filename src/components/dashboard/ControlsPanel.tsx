import { motion } from 'framer-motion';
import { Play, Square, Lock, Unlock, AlertTriangle, Gauge, Settings, Save, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Greeks, RiskStatus, TradeSafeguards } from '@/types/trading';

interface ControlsPanelProps {
  greeks: Greeks;
  riskStatus: RiskStatus;
  safeguards: TradeSafeguards;
  isBotRunning: boolean;
  onToggleBot: () => void;
  onToggleKillSwitch: () => void;
  onEmergencyClose: () => void;
  onUpdateRiskSettings?: (settings: { maxDailyLoss: number; maxPositions: number }) => void;
  onUpdateSafeguards?: (safeguards: TradeSafeguards) => void;
}

export const ControlsPanel = ({
  greeks,
  riskStatus,
  safeguards,
  isBotRunning,
  onToggleBot,
  onToggleKillSwitch,
  onEmergencyClose,
  onUpdateRiskSettings,
  onUpdateSafeguards,
}: ControlsPanelProps) => {
  const [confirmEmergency, setConfirmEmergency] = useState(false);
  const [isEditingRisk, setIsEditingRisk] = useState(false);
  const [isEditingSafeguards, setIsEditingSafeguards] = useState(false);
  const [editMaxLoss, setEditMaxLoss] = useState(riskStatus.maxDailyLoss.toString());
  const [editMaxPositions, setEditMaxPositions] = useState(riskStatus.maxPositions.toString());
  const [editSpread, setEditSpread] = useState(safeguards.maxBidAskSpreadPercent);
  const [editCloseBuffer, setEditCloseBuffer] = useState(safeguards.zeroDteCloseBufferMinutes);
  const [editFillBuffer, setEditFillBuffer] = useState(safeguards.fillPriceBufferPercent);
  
  const deltaDirection = greeks.delta > 10 ? 'Bullish' : greeks.delta < -10 ? 'Bearish' : 'Neutral';
  const deltaColor = greeks.delta > 10 ? 'text-trading-green' : greeks.delta < -10 ? 'text-panic-red' : 'text-muted-foreground';

  const handleSaveRiskSettings = () => {
    const maxLoss = Math.max(0, Math.min(1000000, Number(editMaxLoss) || 1000));
    const maxPos = Math.max(1, Math.min(100, Number(editMaxPositions) || 5));
    
    onUpdateRiskSettings?.({ maxDailyLoss: maxLoss, maxPositions: maxPos });
    setIsEditingRisk(false);
  };

  const handleStartEdit = () => {
    setEditMaxLoss(riskStatus.maxDailyLoss.toString());
    setEditMaxPositions(riskStatus.maxPositions.toString());
    setIsEditingRisk(true);
  };

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
        <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1.5 mb-3 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Gauge className="w-3 h-3" />
            Risk Limits
          </div>
          {!isEditingRisk ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 opacity-50 hover:opacity-100"
              onClick={handleStartEdit}
              disabled={isBotRunning}
            >
              <Settings className="w-3 h-3" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 text-trading-green"
              onClick={handleSaveRiskSettings}
            >
              <Save className="w-3 h-3" />
            </Button>
          )}
        </div>
        <div className="space-y-1.5 text-xs text-muted-foreground">
          <div className="flex justify-between items-center">
            <span>Daily Loss Limit:</span>
            {isEditingRisk ? (
              <div className="flex items-center gap-1">
                <span className="text-foreground">$</span>
                <Input
                  type="number"
                  value={editMaxLoss}
                  onChange={(e) => setEditMaxLoss(e.target.value)}
                  className="h-6 w-20 text-xs font-mono text-right py-0 px-1"
                  min={0}
                  max={1000000}
                />
              </div>
            ) : (
              <span className="font-mono text-foreground">${riskStatus.maxDailyLoss.toLocaleString()}</span>
            )}
          </div>
          <div className="flex justify-between items-center">
            <span>Max Positions:</span>
            {isEditingRisk ? (
              <Input
                type="number"
                value={editMaxPositions}
                onChange={(e) => setEditMaxPositions(e.target.value)}
                className="h-6 w-16 text-xs font-mono text-right py-0 px-1"
                min={1}
                max={100}
              />
            ) : (
              <span className="font-mono text-foreground">{riskStatus.maxPositions}</span>
            )}
          </div>
          <div className="flex justify-between">
            <span>Trades Today:</span>
            <span className="font-mono text-foreground">{riskStatus.tradeCount}</span>
          </div>
          {isEditingRisk && (
            <div className="pt-2 flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="flex-1 text-xs h-6"
                onClick={() => setIsEditingRisk(false)}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                className="flex-1 text-xs h-6 bg-trading-green hover:bg-trading-green/90 text-black"
                onClick={handleSaveRiskSettings}
              >
                Save
              </Button>
            </div>
          )}
          {riskStatus.killSwitchActive && riskStatus.killSwitchReason && (
            <div className="mt-2 p-2 bg-panic-red/10 border border-panic-red/30 rounded text-panic-red text-[10px]">
              Kill Reason: {riskStatus.killSwitchReason}
            </div>
          )}
        </div>
      </div>

      {/* Trade Safeguards Panel */}
      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1.5 mb-3 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Shield className="w-3 h-3" />
            Trade Safeguards
          </div>
          {!isEditingSafeguards ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 opacity-50 hover:opacity-100"
              onClick={() => {
                setEditSpread(safeguards.maxBidAskSpreadPercent);
                setEditCloseBuffer(safeguards.zeroDteCloseBufferMinutes);
                setEditFillBuffer(safeguards.fillPriceBufferPercent);
                setIsEditingSafeguards(true);
              }}
              disabled={isBotRunning}
            >
              <Settings className="w-3 h-3" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 text-trading-green"
              onClick={() => {
                onUpdateSafeguards?.({
                  maxBidAskSpreadPercent: editSpread,
                  zeroDteCloseBufferMinutes: editCloseBuffer,
                  fillPriceBufferPercent: editFillBuffer,
                });
                setIsEditingSafeguards(false);
              }}
            >
              <Save className="w-3 h-3" />
            </Button>
          )}
        </div>
        <div className="space-y-3 text-xs text-muted-foreground">
          {/* Max Bid-Ask Spread */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <span>Max Bid-Ask Spread:</span>
              <span className="font-mono text-foreground">{isEditingSafeguards ? editSpread : safeguards.maxBidAskSpreadPercent}%</span>
            </div>
            {isEditingSafeguards && (
              <Slider
                value={[editSpread]}
                onValueChange={(v) => setEditSpread(v[0])}
                min={1}
                max={20}
                step={0.5}
                className="w-full"
              />
            )}
            <div className="text-[9px] text-muted-foreground/70">
              If spread too wide, bot waits for better pricing
            </div>
          </div>
          
          {/* 0DTE Close Buffer */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <span>0DTE Close Buffer:</span>
              <span className="font-mono text-foreground">{isEditingSafeguards ? editCloseBuffer : safeguards.zeroDteCloseBufferMinutes} min</span>
            </div>
            {isEditingSafeguards && (
              <Slider
                value={[editCloseBuffer]}
                onValueChange={(v) => setEditCloseBuffer(v[0])}
                min={15}
                max={60}
                step={5}
                className="w-full"
              />
            )}
            <div className="text-[9px] text-muted-foreground/70">
              Auto-close 0DTE before market close
            </div>
          </div>
          
          {/* Fill Price Buffer */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <span>Fill Price Buffer:</span>
              <span className="font-mono text-foreground">{isEditingSafeguards ? editFillBuffer : safeguards.fillPriceBufferPercent}%</span>
            </div>
            {isEditingSafeguards && (
              <Slider
                value={[editFillBuffer]}
                onValueChange={(v) => setEditFillBuffer(v[0])}
                min={0}
                max={10}
                step={0.5}
                className="w-full"
              />
            )}
            <div className="text-[9px] text-muted-foreground/70">
              Accounts for delayed data in paper trading
            </div>
          </div>
          
          {isEditingSafeguards && (
            <div className="pt-2 flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="flex-1 text-xs h-6"
                onClick={() => setIsEditingSafeguards(false)}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                className="flex-1 text-xs h-6 bg-trading-green hover:bg-trading-green/90 text-black"
                onClick={() => {
                  onUpdateSafeguards?.({
                    maxBidAskSpreadPercent: editSpread,
                    zeroDteCloseBufferMinutes: editCloseBuffer,
                    fillPriceBufferPercent: editFillBuffer,
                  });
                  setIsEditingSafeguards(false);
                }}
              >
                Save
              </Button>
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
