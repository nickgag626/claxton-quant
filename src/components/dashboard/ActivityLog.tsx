import { motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { ActivityEvent } from '@/types/trading';

interface ActivityLogProps {
  events: ActivityEvent[];
}

const typeColors: Record<ActivityEvent['type'], string> = {
  BOT: 'text-terminal-blue',
  TRADE: 'text-trading-green',
  RISK: 'text-bloomberg-amber',
  EMERGENCY: 'text-panic-red',
  SYSTEM: 'text-muted-foreground',
};

export const ActivityLog = ({ events }: ActivityLogProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="w-full terminal-panel flex items-center justify-between py-2 hover:bg-secondary/30 transition-colors">
          <span className="text-xs text-muted-foreground flex items-center gap-2">
            📋 ACTIVITY LOG
          </span>
          <ChevronDown className={cn(
            "w-4 h-4 text-muted-foreground transition-transform",
            isOpen && "rotate-180"
          )} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="terminal-panel mt-1 max-h-48 overflow-auto">
            {events.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">No recent activity</div>
            ) : (
              <div className="space-y-0.5">
                {events.map((event) => (
                  <div 
                    key={event.id}
                    className="flex items-start gap-2 text-xs font-mono py-1 border-b border-border/50 last:border-0"
                  >
                    <span className="text-muted-foreground/60 shrink-0">
                      {event.timestamp.toLocaleTimeString('en-US', { hour12: false })}
                    </span>
                    <span className={cn("shrink-0", typeColors[event.type])}>
                      [{event.type}]
                    </span>
                    <span className="text-muted-foreground">
                      {event.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </motion.div>
  );
};
