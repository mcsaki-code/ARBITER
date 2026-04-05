import type { Metadata } from 'next';
import './globals.css';
import { NavShell } from '@/components/NavShell';

export const metadata: Metadata = {
  title: 'ARBITER — Weather Prediction Markets',
  description: 'AI-powered weather prediction market scanner and analyzer',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-arbiter-bg text-arbiter-text min-h-screen">
        <NavShell>{children}</NavShell>
      </body>
    </html>
  );
}
