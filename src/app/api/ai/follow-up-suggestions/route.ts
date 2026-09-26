import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAiModule } from '@/lib/ai/auth';
import { runAiSummaryFeature } from '@/lib/ai/service';
import { buildFollowUpFacts } from '@/lib/ai/facts';

const schema = z.object({ companyId: z.string().min(1) });

/** AI-Assisted Features (docs/AI_FEATURES.md): proposes proactive next
 * actions based on inactive quotes, aging invoices, and pending tasks for
 * one account. Read-only — never creates, sends, or modifies anything;
 * a human decides whether to act on any suggestion. */
export async function POST(req: NextRequest) {
  const session = await requireAiModule('companies');
  if (session instanceof NextResponse) return session;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let facts: string[];
  try {
    facts = await buildFollowUpFacts(parsed.data.companyId);
  } catch {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }

  const result = await runAiSummaryFeature({
    feature: 'FOLLOWUP_SUGGESTIONS',
    entityType: 'Company',
    entityId: parsed.data.companyId,
    companyId: parsed.data.companyId,
    requestedById: session.user.id,
    facts,
    featureLabel: 'Customer Follow-Up Suggestions',
    instructions:
      'Based on any inactive quotes, aging invoices, or pending tasks listed in the FACTS, suggest concrete proactive next actions a staff member could take. If none of those conditions apply, say so plainly rather than inventing a reason to follow up.',
  });

  return NextResponse.json(result);
}
