'use client';

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

interface BankrollCardProps {
  bankroll: number;
  pnl: number;
  winRate: number;
  totalBets: number;
  wins: number;
  losses: number;
  className?: string;
}

export function BankrollCard({
  bankroll,
  pnl,
  winRate,
  totalBets,
  wins,
  losses,
  className = '',
}: BankrollCardProps) {
  const pnlPositive = pnl >= 0;

  return (
    <div
      className={`bg-arbiter-card border border-arbiter-border rounded-lg p-4 ${className}`}
    >
      <div className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-2">
        Paper Bankroll
      </div>
      <div className="font-mono text-2xl font-medium text-arbiter-text">
        ${fmt(bankroll)}
      </div>
      <div className="flex items-center gap-3 mt-2">
        <span
          className={`font-mono text-sm font-medium ${
            pnlPositive ? 'text-arbiter-green' : 'text-arbiter-red'
          }`}
        >
          {pnlPositive ? '+' : ''}${fmt(pnl)}
        </span>
        <span className="text-arbiter-text-3 text-xs">|</span>
        <span className="font-mono text-sm text-arbiter-text-2">
          {(winRate * 100).toFixed(1)}% WR
        </span>
        <span className="text-arbiter-text-3 text-xs">|</span>
        <span className="font-mono text-xs text-arbiter-text-2">
          <span className="text-arbiter-green">{wins}W</span>
          /
          <span className="text-arbiter-red">{losses}L</span>
          {' '}({totalBets})
        </span>
      </div>
    </div>
  );
}
