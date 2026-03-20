'use client';

import { useEffect, useCallback } from 'react';

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function Drawer({ isOpen, onClose, title, subtitle, children }: DrawerProps) {
  const handleEsc = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleEsc);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleEsc]);

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/60 bottom-sheet-overlay z-50"
        onClick={onClose}
      />

      {/* Desktop: right drawer */}
      <div className="hidden md:block fixed top-0 right-0 h-full w-[480px] max-w-[90vw] bg-arbiter-surface border-l border-arbiter-border z-50 overflow-y-auto animate-slide-in">
        <div className="sticky top-0 bg-arbiter-surface/95 backdrop-blur-sm border-b border-arbiter-border px-6 py-4 flex items-center justify-between">
          <div>
            {title && <h2 className="text-lg font-semibold">{title}</h2>}
            {subtitle && (
              <p className="text-sm text-arbiter-text-2 mt-0.5">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-arbiter-text-2 hover:text-arbiter-text p-1 min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ✕
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>

      {/* Mobile: bottom sheet */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 max-h-[85vh] bg-arbiter-surface border-t border-arbiter-border rounded-t-xl z-50 overflow-y-auto animate-slide-up">
        <div className="sticky top-0 bg-arbiter-surface/95 backdrop-blur-sm px-4 pt-3 pb-2">
          {/* Drag handle */}
          <div className="w-10 h-1 bg-arbiter-border-hi rounded-full mx-auto mb-3" />
          <div className="flex items-center justify-between">
            <div>
              {title && <h2 className="text-base font-semibold">{title}</h2>}
              {subtitle && (
                <p className="text-xs text-arbiter-text-2 mt-0.5">{subtitle}</p>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-arbiter-text-2 hover:text-arbiter-text min-w-[44px] min-h-[44px] flex items-center justify-center"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="px-4 py-3 pb-8">{children}</div>
      </div>

      <style jsx>{`
        @keyframes slide-in {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes slide-up {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        .animate-slide-in { animation: slide-in 0.25s ease-out; }
        .animate-slide-up { animation: slide-up 0.25s ease-out; }
      `}</style>
    </>
  );
}
