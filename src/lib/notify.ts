// ============================================================
// ARBITER — Notification System
// ============================================================
// Lightweight email notification via Resend API.
// No npm package needed — just a single fetch call.
//
// Setup: Add RESEND_API_KEY and NOTIFICATION_EMAIL to env vars.
// Get a free Resend API key at https://resend.com (100 emails/day free).
// ============================================================

interface BetNotification {
  category: string;
  direction: string;
  outcomeLabel: string | null;
  entryPrice: number;
  amountUsd: number;
  marketQuestion?: string | null;
  isPaper: boolean;
  edge?: number | null;
  confidence?: string | null;
}

/**
 * Send an email notification when a bet is placed.
 * Fails silently — notifications should never block bet placement.
 */
export async function notifyBetPlaced(bet: BetNotification): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.NOTIFICATION_EMAIL;

  if (!apiKey || !toEmail) {
    // Silently skip if not configured
    return;
  }

  const side = bet.direction === 'BUY_YES' ? 'YES' : 'NO';
  const mode = bet.isPaper ? 'PAPER' : 'LIVE';
  const price = (bet.entryPrice * 100).toFixed(0);
  const tag = bet.category.toUpperCase();

  const subject = `[${tag}] Arbiter ${mode} Bet: ${side} $${bet.amountUsd.toFixed(2)}`;

  const lines = [
    `<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 500px; margin: 0 auto; background: #0d0d14; color: #e0e0e8; padding: 24px; border-radius: 12px;">`,
    `<h2 style="color: #f0b429; margin: 0 0 16px 0; font-size: 18px;">New ${mode} Bet Placed</h2>`,
    `<div style="background: #1a1a2e; padding: 16px; border-radius: 8px; margin-bottom: 12px;">`,
    bet.marketQuestion ? `<p style="margin: 0 0 8px 0; font-size: 14px; color: #e0e0e8;"><strong>Market:</strong> ${bet.marketQuestion}</p>` : '',
    bet.outcomeLabel ? `<p style="margin: 0 0 8px 0; font-size: 14px; color: #e0e0e8;"><strong>Outcome:</strong> ${bet.outcomeLabel}</p>` : '',
    `<p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Side:</strong> <span style="color: ${bet.direction === 'BUY_YES' ? '#00d4a0' : '#ff4d6d'};">${side}</span> at ${price}¢</p>`,
    `<p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Amount:</strong> $${bet.amountUsd.toFixed(2)}</p>`,
    bet.edge ? `<p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Edge:</strong> +${(bet.edge * 100).toFixed(1)}%</p>` : '',
    bet.confidence ? `<p style="margin: 0; font-size: 14px;"><strong>Confidence:</strong> ${bet.confidence}</p>` : '',
    `</div>`,
    `<p style="font-size: 12px; color: #555570; margin: 0;">`,
    `${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET · `,
    `<a href="https://arbit3r.netlify.app/tracker" style="color: #f0b429;">View Dashboard →</a>`,
    `</p>`,
    `</div>`,
  ];

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Arbiter <onboarding@resend.dev>',
        to: [toEmail],
        subject,
        html: lines.join('\n'),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[notify] Email send failed (${res.status}): ${text}`);
    }
  } catch (err) {
    // Never let notification errors affect bet placement
    console.warn(`[notify] Email error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Send a daily summary email with all bets placed that day.
 */
export async function notifyDailySummary(summary: {
  betsPlaced: number;
  totalDeployed: number;
  bankroll: number;
  winRate: number;
  openPositions: number;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.NOTIFICATION_EMAIL;

  if (!apiKey || !toEmail) return;

  const subject = `Arbiter Daily: ${summary.betsPlaced} bets, $${summary.totalDeployed.toFixed(0)} deployed`;

  const html = [
    `<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 500px; margin: 0 auto; background: #0d0d14; color: #e0e0e8; padding: 24px; border-radius: 12px;">`,
    `<h2 style="color: #f0b429; margin: 0 0 16px 0;">Daily Summary</h2>`,
    `<div style="background: #1a1a2e; padding: 16px; border-radius: 8px;">`,
    `<p style="margin: 0 0 8px 0;"><strong>Bets Today:</strong> ${summary.betsPlaced}</p>`,
    `<p style="margin: 0 0 8px 0;"><strong>Deployed:</strong> $${summary.totalDeployed.toFixed(2)}</p>`,
    `<p style="margin: 0 0 8px 0;"><strong>Bankroll:</strong> $${summary.bankroll.toFixed(2)}</p>`,
    `<p style="margin: 0 0 8px 0;"><strong>Win Rate:</strong> ${(summary.winRate * 100).toFixed(0)}%</p>`,
    `<p style="margin: 0;"><strong>Open Positions:</strong> ${summary.openPositions}</p>`,
    `</div>`,
    `<p style="font-size: 12px; color: #555570; margin-top: 12px;">`,
    `<a href="https://arbit3r.netlify.app/tracker" style="color: #f0b429;">View Full Dashboard →</a>`,
    `</p>`,
    `</div>`,
  ].join('\n');

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Arbiter <onboarding@resend.dev>',
        to: [toEmail],
        subject,
        html,
      }),
    });
  } catch {
    // Silent fail
  }
}
