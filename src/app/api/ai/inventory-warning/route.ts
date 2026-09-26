import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAiModule } from '@/lib/ai/auth';
import { runAiSummaryFeature } from '@/lib/ai/service';
import { buildInventoryWarningFacts } from '@/lib/ai/facts';

const schema = z.object({ productVariantId: z.string().min(1), warehouseId: z.string().min(1) });

/** AI-Assisted Features (docs/AI_FEATURES.md): translates a low-stock
 * signal into a plain-language business-impact explanation (e.g. which
 * open orders it affects). Read-only — mirrors the exact quantity/reorder
 * point check src/lib/automations/engine.ts's checkLowStock() already
 * makes, without re-deriving the threshold logic. */
export async function POST(req: NextRequest) {
  const session = await requireAiModule('inventory');
  if (session instanceof NextResponse) return session;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let facts: string[];
  try {
    facts = await buildInventoryWarningFacts(parsed.data.productVariantId, parsed.data.warehouseId);
  } catch {
    return NextResponse.json({ error: 'Stock level not found' }, { status: 404 });
  }

  const result = await runAiSummaryFeature({
    feature: 'INVENTORY_WARNING',
    entityType: 'StockLevel',
    entityId: `${parsed.data.productVariantId}:${parsed.data.warehouseId}`,
    requestedById: session.user.id,
    facts,
    featureLabel: 'Inventory Warning Explanation',
    instructions:
      'Explain, in plain business language, what this stock level means and what impact it could have (e.g. on open orders). If the FACTS show stock is not actually low, say so plainly instead of describing a problem that does not exist.',
  });

  return NextResponse.json(result);
}
