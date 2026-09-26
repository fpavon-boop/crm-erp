import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiModule } from '@/lib/api-auth';
import { sendCommunication } from '@/lib/communications/send';
import { TEMPLATE_KEYS } from '@/lib/communications/templates';

// Mirrors prisma/schema.prisma's RelatedEntityType enum — kept as an
// explicit literal list (rather than z.nativeEnum) to match this
// codebase's existing convention of importing Prisma enums as types only.
const RELATED_TYPES = [
  'COMPANY',
  'CONTACT',
  'OPPORTUNITY',
  'QUOTE',
  'SALES_ORDER',
  'INVOICE',
  'PURCHASE_ORDER',
  'SUPPLIER_INVOICE',
  'PRODUCT',
  'TASK',
] as const;

const schema = z.object({
  channel: z.enum(['email', 'whatsapp']),
  to: z.string().min(1),
  subject: z.string().optional(),
  body: z.string().min(1),
  templateKey: z.enum(TEMPLATE_KEYS).optional(),
  companyId: z.string().optional(),
  contactId: z.string().optional(),
  relatedType: z.enum(RELATED_TYPES).optional(),
  relatedId: z.string().optional(),
  // Phase 13: one crypto.randomUUID() generated client-side per compose of
  // the form, resent verbatim on any retry — see
  // src/lib/communications/send.ts.
  idempotencyKey: z.string().min(1).max(200).optional(),
});

/**
 * The one send endpoint behind the "Send communication" form (Phase 10,
 * docs/CUSTOMER_COMMUNICATION.md). Always a human-initiated POST — there is
 * no automated caller of this route. Channel-gated by the same module
 * access every other email/WhatsApp action in this app already uses
 * (`inbox` for email, `whatsapp` for WhatsApp), so a role that can't send
 * one channel can't send it here either.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const requiredModule = parsed.data.channel === 'email' ? 'inbox' : 'whatsapp';
  const session = await requireApiModule(requiredModule);
  if (session instanceof NextResponse) return session;

  const result = await sendCommunication({
    channel: parsed.data.channel,
    to: parsed.data.to,
    subject: parsed.data.subject,
    body: parsed.data.body,
    templateKey: parsed.data.templateKey,
    companyId: parsed.data.companyId,
    contactId: parsed.data.contactId,
    relatedType: parsed.data.relatedType,
    relatedId: parsed.data.relatedId,
    userId: session.user.id,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  // Never echo back anything beyond the outcome — no account/credential
  // data ever flows through this response (see docs/CUSTOMER_COMMUNICATION.md
  // "Security").
  return NextResponse.json({ sent: result.sent, reason: result.reason, communicationLogId: result.communicationLogId });
}
