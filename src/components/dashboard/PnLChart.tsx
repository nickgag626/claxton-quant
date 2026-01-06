import { motion } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface PnLChartProps {
  dailyPnl: number;
}

// Generate mock intraday P&L data
const generateIntradayData = (currentPnl: number) => {
  const data = [];
  const startTime = 9.5; // 9:30 AM
  const endTime = 16; // 4:00 PM
  
  let runningPnl = 0;
  
  for (let hour = startTime; hour <= endTime; hour += 0.5) {
    const volatility = Math.random() * 100 - 50;
    runningPnl += volatility;
    
    const hourInt = Math.floor(hour);
    const minutes = (hour % 1) * 60;
    const timeLabel = `${hourInt}:${minutes === 0 ? '00' : '30'}`;
    
    data.push({
      time: timeLabel,
      pnl: runningPnl,
    });
  }
  
  // Normalize to match current P&L
  const scaleFactor = currentPnl / (runningPnl || 1);
  return data.map(d => ({ ...d, pnl: d.pnl * scaleFactor }));
};

export const PnLChart = ({ dailyPnl }: PnLChartProps) => {
  const data = generateIntradayData(dailyPnl);
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
