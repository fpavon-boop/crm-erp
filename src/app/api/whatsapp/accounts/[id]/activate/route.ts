import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { activateWhatsAppAccount, WhatsAppAccountActivationRaceError } from '@/lib/whatsapp/accounts';
import { Prisma } from '@prisma/client';

/** Makes this account the only active one (e.g. to switch back to a
 * previously-saved number, or re-activate one after a mistaken change),
 * without needing to re-enter its access token. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('whatsapp');
  if (session instanceof NextResponse) return session;
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Only admins can configure WhatsApp accounts' }, { status: 403 });
  }

  try {
    const account = await activateWhatsAppAccount(params.id);
    return NextResponse.json({ account: { id: account.id, label: account.label, active: account.active } });
  } catch (err) {
    if (err instanceof WhatsAppAccountActivationRaceError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    throw err;
  }
}
