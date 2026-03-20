'use client';

interface EdgeMeterProps {
  edge: number; // -1 to 1
  className?: string;
}

export function EdgeMeter({ edge, className = '' }: EdgeMeterProps) {
  // Clamp edge to -1..1, map to 0..100 width
  const clamped = Math.max(-1, Math.min(1, edge));
  const pct = Math.abs(clamped) * 100;
  const isPositive = clamped >= 0;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex-1 h-1.5 bg-arbiter-border rounded-full overflow-hidden relative">
        {/* Center marker */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-arbiter-text-3" />
        {/* Edge bar */}
        <div
          className={`absolute top-0 bottom-0 rounded-full transition-all duration-300 ${
            isPositive ? 'bg-arbiter-green' : 'bg-arbiter-red'
          }`}
          style={{
            left: isPositive ? '50%' : `${50 - pct / 2}%`,
            width: `${pct / 2}%`,
          }}
        />
      </div>
      <span
        className={`font-mono text-xs font-medium ${
          isPositive ? 'text-arbiter-green' : edge === 0 ? 'text-arbiter-text-3' : 'text-arbiter-red'
        }`}
      >
        {isPositive ? '+' : ''}
        {(clamped * 100).toFixed(0)}%
      </span>
    </div>
  );
}
