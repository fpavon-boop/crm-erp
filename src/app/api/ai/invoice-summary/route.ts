import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAiModule } from '@/lib/ai/auth';
import { runAiSummaryFeature } from '@/lib/ai/service';
import { buildInvoiceAccountSummaryFacts } from '@/lib/ai/facts';

const schema = z.object({ companyId: z.string().min(1) });

/** AI-Assisted Features (docs/AI_FEATURES.md): summarizes one account's
 * outstanding balance, aging breakdown, and recent payment history.
 * Read-only — derived from getAccountsReceivableDashboard(), the same
 * source the AR dashboard and management dashboard already use. */
export async function POST(req: NextRequest) {
  const session = await requireAiModule('invoicing');
  if (session instanceof NextResponse) return session;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let facts: string[];
  try {
    facts = await buildInvoiceAccountSummaryFacts(parsed.data.companyId);
  } catch {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }

  const result = await runAiSummaryFeature({
    feature: 'INVOICE_SUMMARY',
    entityType: 'Company',
    entityId: parsed.data.companyId,
    companyId: parsed.data.companyId,
    requestedById: session.user.id,
    facts,
    featureLabel: 'Invoice / Account Summary',
    instructions: "Summarize this account's outstanding balance and payment history for a staff member, and suggest any collection or follow-up action worth considering.",
  });

  return NextResponse.json(result);
}
