import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { recalculateRefractoryPricing } from '@/lib/inventory/profitability';
import { z } from 'zod';

const schema = z.object({
  acquisitionCost: z.coerce.number().nonnegative().optional(),
  freightCost: z.coerce.number().nonnegative().optional(),
  markupDistributor: z.coerce.number().optional(),
  markupContractor: z.coerce.number().optional(),
  markupRetail: z.coerce.number().optional(),
  triggerReason: z.string().max(500).optional(),
});

/** Updates a RefractoryProduct's cost/freight (and, optionally, its
 * markups), always recalculating totalLandedCost/prices/margins from the
 * result via the same recalculateRefractoryPricing() the importer uses —
 * never hand-edited independently. Logs oldCost/newCost/oldFreight/
 * newFreight to RefractoryPriceAuditLog whenever cost or freight actually
 * changes. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { triggerReason, ...changes } = parsed.data;

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.refractoryProduct.findUnique({ where: { id: params.id } });
    if (!existing) return null;

    const acquisitionCost = changes.acquisitionCost ?? Number(existing.acquisitionCost);
    const freightCost = changes.freightCost ?? Number(existing.freightCost);
    const markupDistributor = changes.markupDistributor ?? Number(existing.markupDistributor);
    const markupContractor = changes.markupContractor ?? Number(existing.markupContractor);
    const markupRetail = changes.markupRetail ?? Number(existing.markupRetail);

    const pricing = recalculateRefractoryPricing({
      acquisitionCost,
      freightCost,
      markupDistributor,
      markupContractor,
      markupRetail,
    });

    const costChanged = changes.acquisitionCost !== undefined && acquisitionCost !== Number(existing.acquisitionCost);
    const freightChanged = changes.freightCost !== undefined && freightCost !== Number(existing.freightCost);
    if (costChanged || freightChanged) {
      await tx.refractoryPriceAuditLog.create({
        data: {
          productId: existing.id,
          oldCost: existing.acquisitionCost,
          newCost: acquisitionCost,
          oldFreight: existing.freightCost,
          newFreight: freightCost,
          triggerReason: triggerReason || `Updated by ${session.user.name}`,
        },
      });
    }

    return tx.refractoryProduct.update({
      where: { id: existing.id },
      data: {
        acquisitionCost,
        freightCost,
        markupDistributor,
        markupContractor,
        markupRetail,
        ...pricing,
      },
    });
  });

  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ product: updated });
}
