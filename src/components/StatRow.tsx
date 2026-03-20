'use client';

interface StatRowProps {
  label: string;
  value: string | number;
  valueColor?: string;
  className?: string;
}

export function StatRow({ label, value, valueColor, className = '' }: StatRowProps) {
  return (
    <div className={`flex items-center justify-between py-1 ${className}`}>
      <span className="text-sm text-arbiter-text-2">{label}</span>
      <span
        className={`font-mono text-sm font-medium ${valueColor || 'text-arbiter-text'}`}
      >
        {value}
      </span>
    </div>
  );
}
