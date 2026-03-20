import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('system_config')
    .select('key, value, updated_at');

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch config' }, { status: 500 });
  }

  const config: Record<string, string> = {};
  data?.forEach((r) => {
    config[r.key] = r.value;
  });

  return NextResponse.json({ config });
}

export async function POST(req: NextRequest) {
  const supabase = getSupabaseAdmin();

  try {
    const body = await req.json();
    const { key, value } = body;

    if (!key || value === undefined) {
      return NextResponse.json({ error: 'Missing key or value' }, { status: 400 });
    }

    const { error } = await supabase
      .from('system_config')
      .upsert({
        key,
        value: String(value),
        updated_at: new Date().toISOString(),
      });

    if (error) {
      return NextResponse.json({ error: 'Failed to update config' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
