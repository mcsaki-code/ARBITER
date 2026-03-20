'use client';

import { AgreementLevel } from '@/lib/types';

interface ModelDotsProps {
  agreement: AgreementLevel;
  modelsUsed?: string[];
  className?: string;
}

const DOT_COLORS: Record<AgreementLevel, string> = {
  HIGH: 'bg-arbiter-green',
  MEDIUM: 'bg-arbiter-amber',
  LOW: 'bg-arbiter-red',
};

const LABELS: Record<string, string> = {
  nws: 'NWS',
  gfs: 'GFS',
  ecmwf: 'ECM',
  icon: 'ICN',
};

export function ModelDots({ agreement, modelsUsed, className = '' }: ModelDotsProps) {
  const models = modelsUsed || ['gfs', 'ecmwf', 'icon'];
  const dotColor = DOT_COLORS[agreement];

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {models.map((m, i) => (
        <div key={m} className="flex items-center gap-0.5">
          <div className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
          <span className="text-[10px] text-arbiter-text-3 font-mono">
            {LABELS[m] || m.toUpperCase().slice(0, 3)}
          </span>
          {i < models.length - 1 && (
            <span className="text-arbiter-text-3 text-[10px]">·</span>
          )}
        </div>
      ))}
    </div>
  );
}
