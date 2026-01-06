import { cn } from '@/lib/utils';
import type { BadgeVariant } from '@/types/trading';

interface StatusBadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  green: 'bg-trading-green/20 text-trading-green border-trading-green',
  red: 'bg-panic-red/20 text-panic-red border-panic-red',
  amber: 'bg-bloomberg-amber/20 text-bloomberg-amber border-bloomberg-amber',
  blue: 'bg-terminal-blue/20 text-terminal-blue border-terminal-blue',
  gray: 'bg-neutral-gray/20 text-neutral-gray border-neutral-gray/50',
};

export const StatusBadge = ({ variant, children, className }: StatusBadgeProps) => {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase tracking-wider border',
        variantStyles[variant],
        className
      )}
    >
      {children}
    </span>
  );
};
