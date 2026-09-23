import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { encryptSecret } from '@/lib/crypto';
import { createActiveWhatsAppAccount, WhatsAppAccountActivationRaceError } from '@/lib/whatsapp/accounts';
import { z } from 'zod';

const schema = z.object({
  label: z.string().min(1),
  phoneNumberId: z.string().min(1),
  businessAccountId: z.string().min(1),
  displayPhoneNumber: z.string().optional(),
  accessToken: z.string().min(1),
});

export async function GET() {
  const session = await requireApiModule('whatsapp');
  if (session instanceof NextResponse) return session;
  const accounts = await prisma.whatsAppAccount.findMany({
    select: { id: true, label: true, phoneNumberId: true, businessAccountId: true, displayPhoneNumber: true, active: true },
  });
  return NextResponse.json({ accounts });
}

/** Creating an account makes it the (only) active one — see
 * createActiveWhatsAppAccount(). This preserves the existing behavior
 * ("saving an account is how you switch numbers") while guaranteeing only
 * one account is ever active at a time. */
export async function POST(req: NextRequest) {
  const session = await requireApiModule('whatsapp');
  if (session instanceof NextResponse) return session;
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Only admins can configure WhatsApp accounts' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { accessToken, ...rest } = parsed.data;
  try {
    const account = await createActiveWhatsAppAccount({
      ...rest,
      encryptedAccessToken: encryptSecret(accessToken),
    });
    return NextResponse.json({ account: { id: account.id, label: account.label } }, { status: 201 });
  } catch (err) {
    if (err instanceof WhatsAppAccountActivationRaceError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
