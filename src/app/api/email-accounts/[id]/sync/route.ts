import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { syncEmailAccount } from '@/lib/email/imap';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inbox');
  if (session instanceof NextResponse) return session;

  try {
    const result = await syncEmailAccount(params.id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
