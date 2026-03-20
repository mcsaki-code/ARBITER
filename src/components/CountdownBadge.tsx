'use client';

interface CountdownBadgeProps {
  daysRemaining: number;
  betsNeeded: number;
  winRateNeeded: boolean;
  className?: string;
}

export function CountdownBadge({
  daysRemaining,
  betsNeeded,
  winRateNeeded,
  className = '',
}: CountdownBadgeProps) {
  const allClear = daysRemaining <= 0 && betsNeeded <= 0 && !winRateNeeded;

  return (
    <div
      className={`border rounded-lg p-3 ${
        allClear
          ? 'bg-arbiter-green/10 border-arbiter-green/30'
          : 'bg-arbiter-card border-arbiter-border'
      } ${className}`}
    >
      <div className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-1">
        {allClear ? 'Real Trading Unlocked' : 'Real Money Unlock'}
      </div>
      {allClear ? (
        <div className="text-arbiter-green font-medium text-sm">
          All criteria met — ready to trade live
        </div>
      ) : (
        <div className="space-y-1">
          {daysRemaining > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-arbiter-amber font-mono text-lg font-medium">
                {daysRemaining}d
              </span>
              <span className="text-arbiter-text-2 text-xs">remaining</span>
            </div>
          )}
          {betsNeeded > 0 && (
            <div className="text-xs text-arbiter-text-2">
              <span className="font-mono text-arbiter-text">{betsNeeded}</span> more bets needed
            </div>
          )}
          {winRateNeeded && (
            <div className="text-xs text-arbiter-text-2">
              Win rate must reach <span className="font-mono text-arbiter-text">58%</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
