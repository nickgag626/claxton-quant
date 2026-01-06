import { motion } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useMemo } from 'react';

interface PnLDataPoint {
  time: string;
  pnl: number;
}

interface PnLChartProps {
  dailyPnl: number;
  pnlHistory?: PnLDataPoint[];
}

export const PnLChart = ({ dailyPnl, pnlHistory }: PnLChartProps) => {
  // Use provided history or show single current point
  const data = useMemo(() => {
    if (pnlHistory && pnlHistory.length > 0) {
      return pnlHistory;
    }
    // If no history, show current P&L as single point
    const now = new Date();
    const timeLabel = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    return [{ time: timeLabel, pnl: dailyPnl }];
  }, [pnlHistory, dailyPnl]);
  
  const isPositive = dailyPnl >= 0;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25 }}
      className="terminal-panel"
    >
      <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1.5 mb-3">
        Intraday P&L Curve
      </div>
      
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            <defs>
              <linearGradient id="pnlGradientPositive" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(142, 71%, 45%)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(142, 71%, 45%)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="pnlGradientNegative" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(0, 72%, 60%)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(0, 72%, 60%)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis 
              dataKey="time" 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(0, 0%, 50%)', fontSize: 9, fontFamily: 'JetBrains Mono' }}
              interval="preserveStartEnd"
            />
            <YAxis 
              hide
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(0, 0%, 8%)',
                border: '1px solid hsl(0, 0%, 15%)',
                borderRadius: '4px',
                fontSize: '11px',
                fontFamily: 'JetBrains Mono',
              }}
              labelStyle={{ color: 'hsl(0, 0%, 50%)' }}
              formatter={(value: number) => [
                `$${value.toFixed(2)}`,
                'P&L'
              ]}
            />
            <Area
              type="monotone"
              dataKey="pnl"
              stroke={isPositive ? 'hsl(142, 71%, 45%)' : 'hsl(0, 72%, 60%)'}
              strokeWidth={2}
              fill={isPositive ? 'url(#pnlGradientPositive)' : 'url(#pnlGradientNegative)'}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
};
