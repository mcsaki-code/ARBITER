'use client';

interface PriceBarProps {
  outcomes: string[];
  prices: number[];
  highlightIdx?: number | null;
  className?: string;
}

export function PriceBar({ outcomes, prices, highlightIdx, className = '' }: PriceBarProps) {
  const maxPrice = Math.max(...prices, 0.01);

  return (
    <div className={`flex items-end gap-0.5 h-8 ${className}`}>
      {prices.map((price, i) => {
        const heightPct = (price / maxPrice) * 100;
        const isHighlight = highlightIdx === i;
        return (
          <div
            key={i}
            className="flex-1 flex flex-col items-center justify-end"
            title={`${outcomes[i]}: $${price.toFixed(2)}`}
          >
            <div
              className={`w-full rounded-t-sm transition-all ${
                isHighlight
                  ? 'bg-arbiter-amber'
                  : 'bg-arbiter-border-hi'
              }`}
              style={{ height: `${Math.max(heightPct, 4)}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}
