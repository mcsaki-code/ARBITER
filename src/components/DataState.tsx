'use client';

import { DataState } from '@/lib/types';
import { SkeletonCard } from './Skeleton';

interface DataStateWrapperProps {
  state: DataState;
  lastUpdated?: string | null;
  emptyMessage?: string;
  errorMessage?: string;
  children: React.ReactNode;
  skeletonCount?: number;
}

export function DataStateWrapper({
  state,
  lastUpdated,
  emptyMessage = 'No data available',
  errorMessage = 'Data unavailable — retrying',
  children,
  skeletonCount = 3,
}: DataStateWrapperProps) {
  if (state === 'loading') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="bg-arbiter-card border border-arbiter-red/30 rounded-lg p-6 text-center">
        <div className="text-arbiter-red text-sm font-medium">{errorMessage}</div>
        {lastUpdated && (
          <div className="text-arbiter-text-3 text-xs mt-1">
            Last updated: {lastUpdated}
          </div>
        )}
      </div>
    );
  }

  if (state === 'empty') {
    return (
      <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-6 text-center">
        <div className="text-arbiter-text-2 text-sm">{emptyMessage}</div>
      </div>
    );
  }

  return (
    <div className="relative">
      {state === 'stale' && (
        <div className="absolute -top-6 right-0 text-xs text-arbiter-amber flex items-center gap-1">
          <span className="w-1.5 h-1.5 bg-arbiter-amber rounded-full pulse-dot" />
          Last updated {lastUpdated || 'unknown'}
        </div>
      )}
      <div className={state === 'stale' ? 'opacity-75' : ''}>{children}</div>
    </div>
  );
}
