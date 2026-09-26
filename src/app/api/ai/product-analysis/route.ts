import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAiModule } from '@/lib/ai/auth';
import { runAiSummaryFeature } from '@/lib/ai/service';
import { buildProductAnalysisFacts } from '@/lib/ai/facts';

const schema = z.object({ productId: z.string().min(1) });

/** AI-Assisted Features (docs/AI_FEATURES.md): highlights a product's
 * performance trend, demand momentum, and reorder velocity. Read-only —
 * derived from getProductProfitability() (the same source the
 * Profitability Reporting module uses) plus current stock levels. */
export async function POST(req: NextRequest) {
  const session = await requireAiModule('inventory');
  if (session instanceof NextResponse) return session;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let facts: string[];
  try {
    facts = await buildProductAnalysisFacts(parsed.data.productId);
  } catch {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  }

  const result = await runAiSummaryFeature({
    feature: 'PRODUCT_ANALYSIS',
    entityType: 'Product',
    entityId: parsed.data.productId,
    requestedById: session.user.id,
    facts,
    featureLabel: 'Product Sales Analysis',
    instructions: 'Explain this product\'s recent sales performance and demand trend, and suggest any inventory or purchasing action worth considering.',
  });

  return NextResponse.json(result);
}
