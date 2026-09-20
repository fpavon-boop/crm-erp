import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { decryptSecret } from '@/lib/crypto';

export const runtime = 'nodejs';

const schema = z.object({
  action: z.enum(['request_code', 'verify_code', 'register', 'status', 'subscriptions', 'subscribe']),
  wabaId: z.string().regex(/^\d{5,25}$/).optional(),
  pin: z.string().regex(/^\d{6}$/).optional(),
  code: z.string().regex(/^\d{4,8}$/).optional(),
  method: z.enum(['SMS', 'VOICE']).optional(),
});

/** Admin-only helper that drives Meta's official phone-number onboarding calls
 * (request/verify code, register with a 6-digit PIN) and returns Meta's raw
 * response so the real error is visible. */
export async function POST(req: NextRequest) {
  const session = await requireApiModule('whatsapp');
  if (session instanceof NextResponse) return session;
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Only admins can register numbers' }, { status: 403 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  const { action, pin, code, method, wabaId } = parsed.data;

  const account = await prisma.whatsAppAccount.findFirst({ where: { active: true } });
  if (!account) return NextResponse.json({ error: 'No WhatsApp account saved' }, { status: 400 });
  const token = decryptSecret(account.encryptedAccessToken);
  const base = `https://graph.facebook.com/v20.0/${account.phoneNumberId}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let res: Response;
  if (action === 'subscriptions' || action === 'subscribe') {
    // Which apps (and callback URLs) receive webhooks for a WhatsApp Business Account.
    const waba = wabaId || account.businessAccountId;
    res = await fetch(`https://graph.facebook.com/v20.0/${waba}/subscribed_apps`, {
      method: action === 'subscribe' ? 'POST' : 'GET',
      headers,
    });
  } else if (action === 'status') {
    res = await fetch(`${base}?fields=display_phone_number,verified_name,code_verification_status,quality_rating,name_status,status,platform_type,webhook_configuration`, { headers });
  } else if (action === 'request_code') {
    res = await fetch(`${base}/request_code`, {
      method: 'POST', headers, body: JSON.stringify({ code_method: method || 'SMS', language: 'en_US' }),
    });
  } else if (action === 'verify_code') {
    if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });
    res = await fetch(`${base}/verify_code`, { method: 'POST', headers, body: JSON.stringify({ code }) });
  } else {
    if (!pin) return NextResponse.json({ error: 'pin required' }, { status: 400 });
    res = await fetch(`${base}/register`, {
      method: 'POST', headers, body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
  }

  const body = await res.json().catch(() => ({}));
  return NextResponse.json({ ok: res.ok, status: res.status, meta: body });
}
