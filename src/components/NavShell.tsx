'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/', label: 'Home', icon: '⌂', mobileIcon: '🏠' },
  { href: '/weather', label: 'Weather', icon: '🌤', mobileIcon: '🌤' },
  { href: '/news', label: 'News', icon: '📰', mobileIcon: '📰', disabled: true },
  { href: '/markets', label: 'Markets', icon: '📊', mobileIcon: '📊', disabled: true },
  { href: '/tracker', label: 'Tracker', icon: '📈', mobileIcon: '📈' },
];

export function NavShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen flex flex-col">
      {/* Desktop top nav */}
      <header className="hidden md:flex items-center justify-between px-6 py-3 border-b border-arbiter-border bg-arbiter-surface/80 backdrop-blur-sm sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-arbiter-amber font-semibold text-lg tracking-wider">
            ARBITER
          </span>
          <span className="text-arbiter-text-3 text-xs hidden lg:inline">
            Read the world. Beat the market.
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.disabled ? '#' : item.href}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  item.disabled
                    ? 'text-arbiter-text-3 cursor-not-allowed opacity-50'
                    : isActive
                    ? 'bg-arbiter-elevated text-arbiter-text'
                    : 'text-arbiter-text-2 hover:text-arbiter-text hover:bg-arbiter-card'
                }`}
                onClick={(e) => item.disabled && e.preventDefault()}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      {/* Mobile top bar */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-arbiter-border bg-arbiter-surface/80 backdrop-blur-sm sticky top-0 z-50">
        <Link href="/" className="text-arbiter-amber font-semibold text-lg tracking-wider">
          ARBITER
        </Link>
      </header>

      {/* Page content */}
      <main className="flex-1 pb-20 md:pb-0">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 flex items-center justify-around border-t border-arbiter-border bg-arbiter-surface/95 backdrop-blur-sm z-50 safe-area-pb">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.disabled ? '#' : item.href}
              className={`flex flex-col items-center py-2 px-3 min-h-[44px] min-w-[44px] transition-colors ${
                item.disabled
                  ? 'text-arbiter-text-3 opacity-40'
                  : isActive
                  ? 'text-arbiter-amber'
                  : 'text-arbiter-text-2'
              }`}
              onClick={(e) => item.disabled && e.preventDefault()}
            >
              <span className="text-lg leading-none">{item.mobileIcon}</span>
              <span className="text-[10px] mt-0.5">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
