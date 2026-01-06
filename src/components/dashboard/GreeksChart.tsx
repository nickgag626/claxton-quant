import { motion } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useMemo } from 'react';

export interface DeltaDataPoint {
  time: string;
  delta: number;
}

interface GreeksChartProps {
  currentDelta: number;
  deltaHistory?: DeltaDataPoint[];
}

export const GreeksChart = ({ currentDelta, deltaHistory }: GreeksChartProps) => {
  const data = useMemo(() => {
    if (deltaHistory && deltaHistory.length > 0) {
      return deltaHistory;
    }
    const now = new Date();
    const timeLabel = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    return [{ time: timeLabel, delta: currentDelta }];
  }, [deltaHistory, currentDelta]);
  
  const isPositive = currentDelta >= 0;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
      className="terminal-panel"
    >
      <div className="text-[10px] text-muted-foreground uppercase tracking-widest border-b border-border pb-1.5 mb-3 flex items-center justify-between">
        <span>Portfolio Delta</span>
        <span className={`text-xs font-mono ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
          {currentDelta >= 0 ? '+' : ''}{currentDelta.toFixed(2)}Δ
        </span>
      </div>
      
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            <defs>
              <linearGradient id="deltaGradientPositive" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="deltaGradientNegative" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(280, 70%, 60%)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(280, 70%, 60%)" stopOpacity={0} />
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
            <ReferenceLine y={0} stroke="hsl(0, 0%, 30%)" strokeDasharray="3 3" />
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
                `${value >= 0 ? '+' : ''}${value.toFixed(2)}`,
                'Delta'
              ]}
            />
            <Area
              type="monotone"
              dataKey="delta"
              stroke={isPositive ? 'hsl(217, 91%, 60%)' : 'hsl(280, 70%, 60%)'}
              strokeWidth={2}
              fill={isPositive ? 'url(#deltaGradientPositive)' : 'url(#deltaGradientNegative)'}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
};
