import { motion } from 'framer-motion';
import { StatusBadge } from './StatusBadge';
import type { MarketState } from '@/types/trading';

interface StatusRibbonProps {
  isApiConnected: boolean;
  isQuotesLive: boolean;
  isBotRunning: boolean;
  killSwitchActive: boolean;
  marketState: MarketState;
  positionCount: number;
  nearestDte: number | null;
  lastUpdate: Date;
  lastCheckExitsTime?: Date | null;
}

export const StatusRibbon = ({
  isApiConnected,
  isQuotesLive,
  isBotRunning,
  killSwitchActive,
  marketState,
  positionCount,
  nearestDte,
  lastUpdate,
  lastCheckExitsTime,
}: StatusRibbonProps) => {
  // Calculate heartbeat status for check_exits
  const getHeartbeatStatus = (): { variant: 'green' | 'amber' | 'red' | 'gray'; text: string } => {
    if (!lastCheckExitsTime) {
      return { variant: 'gray', text: 'EXITS:--' };
    }
    const ageMs = Date.now() - lastCheckExitsTime.getTime();
    const ageSec = Math.floor(ageMs / 1000);

    if (ageSec < 45) {
      return { variant: 'green', text: `EXITS:${ageSec}s` };
    } else if (ageSec < 90) {
      return { variant: 'amber', text: `EXITS:${ageSec}s` };
    } else {
      return { variant: 'red', text: `EXITS:${ageSec}s` };
    }
  };

  const heartbeat = getHeartbeatStatus();

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card/80 backdrop-blur-sm border border-border rounded-md px-4 py-2 flex flex-wrap items-center gap-2"
    >
      <StatusBadge variant={isApiConnected ? 'green' : 'red'}>
        API:{isApiConnected ? 'CONNECTED' : 'DISCONNECTED'}
      </StatusBadge>
      
      <StatusBadge variant={isQuotesLive ? 'green' : 'amber'}>
        QUOTES:{isQuotesLive ? 'LIVE' : 'DELAYED'}
      </StatusBadge>
      
      <StatusBadge variant={isBotRunning ? 'green' : 'gray'}>
        BOT:{isBotRunning ? 'RUNNING' : 'STOPPED'}
      </StatusBadge>

      <StatusBadge variant={heartbeat.variant}>
        {heartbeat.text}
      </StatusBadge>

      <StatusBadge variant={killSwitchActive ? 'red' : 'gray'}>
        KILL:{killSwitchActive ? 'ACTIVE' : 'OFF'}
      </StatusBadge>
      
      <StatusBadge variant="blue">
        TICK:{lastUpdate.toLocaleTimeString('en-US', { hour12: false })}
      </StatusBadge>
      
      <StatusBadge variant="amber">
        ENV:PAPER
      </StatusBadge>
      
      <StatusBadge variant="blue">
        POS:{positionCount}
      </StatusBadge>
      
      <StatusBadge variant={nearestDte !== null ? 'amber' : 'gray'}>
        DTE:{nearestDte !== null ? nearestDte : '--'}
      </StatusBadge>
      
      <StatusBadge variant={marketState === 'open' ? 'green' : marketState === 'closed' ? 'red' : 'amber'}>
        MKT:{marketState.toUpperCase()}
      </StatusBadge>
    </motion.div>
  );
};
