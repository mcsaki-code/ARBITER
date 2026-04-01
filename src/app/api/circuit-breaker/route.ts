import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { shouldTrade, manualHalt, manualResume, resetPeak } from '@/lib/circuit-breaker';

export const dynamic = 'force-dynamic';

// GET /api/circuit-breaker — check current state
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const state = await shouldTrade(supabase);

    return NextResponse.json({
      ...state,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// POST /api/circuit-breaker — control actions
export async function POST(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const body = await request.json();

    switch (body.action) {
      case 'halt':
        await manualHalt(supabase);
        return NextResponse.json({ success: true, action: 'Trading halted' });

      case 'resume':
        await manualResume(supabase);
        return NextResponse.json({ success: true, action: 'Trading resumed, streaks reset' });

      case 'reset-peak':
        await resetPeak(supabase, body.newPeak);
        return NextResponse.json({ success: true, action: 'Peak bankroll reset' });

      default:
        return NextResponse.json(
          { error: 'Unknown action. Use: halt, resume, reset-peak' },
          { status: 400 }
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
