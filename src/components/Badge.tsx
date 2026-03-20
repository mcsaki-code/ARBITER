'use client';

type BadgeVariant = 'amber' | 'green' | 'red' | 'blue' | 'gray' | 'purple';

const VARIANT_STYLES: Record<BadgeVariant, string> = {
  amber: 'bg-arbiter-amber/15 text-arbiter-amber border-arbiter-amber/30',
  green: 'bg-arbiter-green/15 text-arbiter-green border-arbiter-green/30',
  red: 'bg-arbiter-red/15 text-arbiter-red border-arbiter-red/30',
  blue: 'bg-arbiter-blue/15 text-arbiter-blue border-arbiter-blue/30',
  gray: 'bg-arbiter-border/30 text-arbiter-text-2 border-arbiter-border',
  purple: 'bg-arbiter-purple/15 text-arbiter-purple border-arbiter-purple/30',
};

interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant, children, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${VARIANT_STYLES[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
