import { motion } from 'framer-motion';
import { ChevronDown, Trash2 } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { ActivityEvent } from '@/types/trading';

interface ActivityLogProps {
  events: ActivityEvent[];
  onClearHistory?: () => void;
}

const typeColors: Record<ActivityEvent['type'], string> = {
  BOT: 'text-terminal-blue',
  TRADE: 'text-trading-green',
  RISK: 'text-bloomberg-amber',
  EMERGENCY: 'text-panic-red',
  SYSTEM: 'text-muted-foreground',
};

export const ActivityLog = ({ events, onClearHistory }: ActivityLogProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="terminal-panel flex items-center justify-between py-2">
          <CollapsibleTrigger className="flex-1 flex items-center justify-between hover:bg-secondary/30 transition-colors">
            <span className="text-xs text-muted-foreground flex items-center gap-2">
              📋 ACTIVITY LOG
            </span>
            <ChevronDown className={cn(
              "w-4 h-4 text-muted-foreground transition-transform",
              isOpen && "rotate-180"
            )} />
          </CollapsibleTrigger>
          {onClearHistory && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onClearHistory();
              }}
              className="ml-2 h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Clear
            </Button>
          )}
        </div>
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
