import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export async function GET() {
  return NextResponse.json({ message: 'V3: Weather-only system. This endpoint is disabled.' });
}
