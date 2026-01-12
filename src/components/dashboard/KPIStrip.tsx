import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown, Minus, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Greeks, Quote, RiskStatus } from '@/types/trading';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface KPIStripProps {
  riskStatus: RiskStatus;
  greeks: Greeks;
  quotes: Record<string, Quote>;
  enabledStrategiesCount: number;
  positionCount: number;
}

const TerminalPanel = ({ 
  title, 
  children, 
  className,
  titleSuffix,
}: { 
  title: string; 
  children: React.ReactNode;
  className?: string;
  titleSuffix?: React.ReactNode;
}) => (
  <div className={cn("terminal-panel", className)}>
    <div className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1.5 mb-2">
      {title}
      {titleSuffix}
    </div>
    {children}
  </div>
);

const PriceDisplay = ({ quote }: { quote: Quote }) => {
  const isPositive = quote.change >= 0;
  const Icon = quote.change > 0 ? TrendingUp : quote.change < 0 ? TrendingDown : Minus;
  
  return (
    <div className="flex items-center gap-2">
      <span className={cn(
        "font-mono text-sm font-semibold",
        isPositive ? "text-trading-green" : "text-panic-red"
      )}>
        ${quote.last.toFixed(2)}
      </span>
      <span className={cn(
        "flex items-center gap-0.5 text-xs font-mono",
        isPositive ? "text-trading-green" : "text-panic-red"
      )}>
        <Icon className="w-3 h-3" />
        {isPositive ? '+' : ''}{quote.changePercent.toFixed(2)}%
      </span>
    </div>
  );
};

const formatPnl = (value: number, showSign = true): string => {
  const sign = value >= 0 ? (showSign ? '+' : '') : '';
  return `${sign}$${value.toFixed(2)}`;
};

export const KPIStrip = ({
  riskStatus,
  greeks,
  quotes,
  enabledStrategiesCount,
  positionCount,
}: KPIStripProps) => {
  const isPnlPositive = riskStatus.dailyPnl >= 0;
  const lossRemaining = riskStatus.maxDailyLoss + (riskStatus.dailyPnl < 0 ? riskStatus.dailyPnl : 0);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"
    >
      {/* P&L Today with tooltip breakdown */}
      <TerminalPanel 
        title="P&L Today" 
        className="col-span-2 md:col-span-1"
        titleSuffix={
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="w-3 h-3 cursor-help opacity-60 hover:opacity-100" />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="font-mono text-xs max-w-xs">
                <div className="space-y-1.5">
                  <div className="font-semibold border-b border-border pb-1 mb-1">P&L Breakdown (America/New_York)</div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Realized:</span>
                    <span className={riskStatus.realizedPnl >= 0 ? "text-trading-green" : "text-panic-red"}>
                      {formatPnl(riskStatus.realizedPnl)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Unrealized:</span>
                    <span className={riskStatus.unrealizedPnl >= 0 ? "text-trading-green" : "text-panic-red"}>
                      {formatPnl(riskStatus.unrealizedPnl)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4 border-t border-border pt-1 font-semibold">
                    <span>Total:</span>
                    <span className={riskStatus.dailyPnl >= 0 ? "text-trading-green" : "text-panic-red"}>
                      {formatPnl(riskStatus.dailyPnl)}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground pt-1 border-t border-border mt-1">
                    <div>• Realized = filled trades, verified, pnl ≠ null</div>
                    <div>• Unrealized = open positions from broker</div>
                    <div>• Today = close_filled_at ≥ midnight ET</div>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        }
      >
        <div className={cn(
          "font-mono text-xl font-bold",
          isPnlPositive ? "text-trading-green" : "text-panic-red"
        )}>
          {isPnlPositive ? '+' : ''}${riskStatus.dailyPnl.toFixed(2)}
        </div>
      </TerminalPanel>

      {/* Risk Remaining */}
      <TerminalPanel title="Risk Left">
        <div className="font-mono text-lg font-semibold text-bloomberg-amber">
          ${lossRemaining.toFixed(0)}
        </div>
      </TerminalPanel>

      {/* Net Greeks */}
      <TerminalPanel title="Net Greeks" className="col-span-2 lg:col-span-1">
        <div className="font-mono text-xs text-bloomberg-amber flex flex-wrap gap-x-2">
          <span>Δ{greeks.delta.toFixed(1)}</span>
          <span>Γ{greeks.gamma.toFixed(3)}</span>
          <span>Θ{greeks.theta.toFixed(1)}</span>
          <span>ν{greeks.vega.toFixed(1)}</span>
        </div>
      </TerminalPanel>

      {/* Exposure */}
      <TerminalPanel title="Exposure">
        <div className="font-mono text-sm text-terminal-blue">
          {positionCount} pos | {enabledStrategiesCount} strat
        </div>
      </TerminalPanel>

      {/* SPY */}
      <TerminalPanel title="SPY">
        {quotes.SPY && <PriceDisplay quote={quotes.SPY} />}
      </TerminalPanel>

      {/* QQQ */}
      <TerminalPanel title="QQQ">
        {quotes.QQQ && <PriceDisplay quote={quotes.QQQ} />}
      </TerminalPanel>
    </motion.div>
  );
};
