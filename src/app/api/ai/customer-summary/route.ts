import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { requireAiModule } from '@/lib/ai/auth';
import { runAiSummaryFeature } from '@/lib/ai/service';
import { buildCustomerSummaryFacts, CompanyNotFoundError } from '@/lib/ai/facts';

const schema = z.object({ companyId: z.string().min(1) });

/** AI-Assisted Features (docs/AI_FEATURES.md): synthesizes a company's
 * orders, quotes, invoices, payments, communications, notes, and tasks
 * into a plain-English summary + suggested next actions. Read-only — this
 * route never writes anything but its own AiGenerationLog audit row. */
export async function POST(req: NextRequest) {
  const session = await requireAiModule('companies');
  if (session instanceof NextResponse) return session;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let facts: string[];
  try {
    ({ facts } = await buildCustomerSummaryFacts(parsed.data.companyId, session.user.role as Role));
  } catch (err) {
    if (err instanceof CompanyNotFoundError) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    throw err;
  }

  const result = await runAiSummaryFeature({
    feature: 'CUSTOMER_SUMMARY',
    entityType: 'Company',
    entityId: parsed.data.companyId,
    companyId: parsed.data.companyId,
    requestedById: session.user.id,
    facts,
    featureLabel: 'Customer Summary',
    instructions:
      'Summarize this customer account for a staff member about to contact them, and suggest what (if anything) they should do next.',
  });

  return NextResponse.json(result);
}
