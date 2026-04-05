'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// SVG icon components — clean, minimal, no emojis
function IconHome({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
      <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
    </svg>
  );
}

function IconWeather({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
      <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
    </svg>
  );
}

function IconNews({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
      <path fillRule="evenodd" d="M2 5a2 2 0 012-2h8a2 2 0 012 2v10a2 2 0 002 2H4a2 2 0 01-2-2V5zm3 1h6v4H5V6zm6 6H5v2h6v-2z" clipRule="evenodd" />
      <path d="M15 7h1a2 2 0 012 2v5.5a1.5 1.5 0 01-3 0V7z" />
    </svg>
  );
}

function IconMarkets({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
      <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zm6-4a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zm6-3a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
    </svg>
  );
}

function IconTracker({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
      <path fillRule="evenodd" d="M12 7a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0V8.414l-4.293 4.293a1 1 0 01-1.414 0L8 10.414l-4.293 4.293a1 1 0 01-1.414-1.414l5-5a1 1 0 011.414 0L11 10.586 14.586 7H12z" clipRule="evenodd" />
    </svg>
  );
}


const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', Icon: IconHome },
  { href: '/weather', label: 'Weather', Icon: IconWeather },
  { href: '/performance', label: 'Performance', Icon: IconTracker },
];

export function NavShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen flex flex-col">
      {/* Desktop top nav */}
      <header className="hidden md:flex items-center justify-between px-6 py-3 border-b border-arbiter-border bg-arbiter-surface/80 backdrop-blur-sm sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 bg-arbiter-amber rounded-full" />
            <span className="text-arbiter-text font-semibold text-lg tracking-wider">
              ARBITER
            </span>
          </div>
          <div className="hidden lg:block h-4 w-px bg-arbiter-border" />
          <span className="text-arbiter-text-3 text-xs hidden lg:inline tracking-wide">
            AI-powered prediction market scanner
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-150 ${
                  isActive
                    ? 'bg-arbiter-elevated text-arbiter-text border border-arbiter-border'
                    : 'text-arbiter-text-2 hover:text-arbiter-text hover:bg-arbiter-card'
                }`}
              >
                <item.Icon className={isActive ? 'text-arbiter-amber' : ''} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      {/* Mobile top bar */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-arbiter-border bg-arbiter-surface/80 backdrop-blur-sm sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-1.5">
          <div className="w-2 h-2 bg-arbiter-amber rounded-full" />
          <span className="text-arbiter-text font-semibold text-lg tracking-wider">
            ARBITER
          </span>
        </Link>
        <span className="text-[10px] text-arbiter-text-3 tracking-widest uppercase">
          AI Scanner
        </span>
      </header>

      {/* Page content */}
      <main className="flex-1 pb-20 md:pb-0">{children}</main>

      {/* Mobile bottom nav — horizontally scrollable for 8 items */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t border-arbiter-border bg-arbiter-surface/95 backdrop-blur-sm z-50 overflow-x-auto mobile-nav-scroll">
        <div className="flex items-center py-1 px-1 min-w-max">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative flex flex-col items-center py-2 px-3 min-h-[44px] min-w-[48px] transition-all duration-150 ${
                  isActive
                    ? 'text-arbiter-amber'
                    : 'text-arbiter-text-3 hover:text-arbiter-text-2'
                }`}
              >
                <item.Icon />
                <span className={`text-[9px] mt-1 tracking-wide whitespace-nowrap ${isActive ? 'font-medium' : ''}`}>
                  {item.label}
                </span>
                {isActive && (
                  <div className="absolute bottom-1 w-4 h-0.5 bg-arbiter-amber rounded-full" />
                )}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
