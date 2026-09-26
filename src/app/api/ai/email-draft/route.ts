import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAiModule } from '@/lib/ai/auth';
import { runAiDraftFeature } from '@/lib/ai/service';
import { buildEmailDraftFacts } from '@/lib/ai/facts';

const INTENT_LABELS = {
  follow_up: 'a friendly follow-up message checking in with this customer',
  confirmation: 'a confirmation message for a recent order or appointment',
  quote: 'a message presenting or following up on a quote',
} as const;

const schema = z.object({
  companyId: z.string().min(1),
  contactId: z.string().min(1).optional().nullable(),
  intent: z.enum(['follow_up', 'confirmation', 'quote']),
  relatedType: z.enum(['QUOTE', 'SALES_ORDER', 'INVOICE']).optional().nullable(),
  relatedId: z.string().min(1).optional().nullable(),
});

/**
 * AI-Assisted Features (docs/AI_FEATURES.md): generates an EDITABLE draft
 * subject/body for a follow-up, confirmation, or quote email, grounded in
 * the customer's actual communication timeline and (optionally) one
 * related quote/order/invoice. This route never sends anything — it only
 * returns draft text for a human to review, edit, and explicitly submit
 * through the existing send flow (src/components/SendCommunicationForm.tsx
 * / POST /api/communications/send), the same human-in-the-loop pattern
 * every other communication in this app already follows.
 */
export async function POST(req: NextRequest) {
  const session = await requireAiModule('inbox');
  if (session instanceof NextResponse) return session;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { companyId, contactId, intent, relatedType, relatedId } = parsed.data;

  let facts: string[];
  let recipientEmail: string | null;
  try {
    ({ facts, recipientEmail } = await buildEmailDraftFacts({ companyId, contactId, relatedType, relatedId }));
  } catch {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }

  const result = await runAiDraftFeature({
    feature: 'EMAIL_DRAFT',
    entityType: 'Company',
    entityId: companyId,
    companyId,
    requestedById: session.user.id,
    facts,
    intentLabel: INTENT_LABELS[intent],
    instructions: 'Write a short, professional, specific message — not a generic template.',
  });

  return NextResponse.json({ ...result, recipientEmail });
}
