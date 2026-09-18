import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { syncWordPressSite } from '@/lib/wordpress/client';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('wordpress');
  if (session instanceof NextResponse) return session;

  try {
    const result = await syncWordPressSite(params.id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
