import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { recalculateProductFinancials } from '@/lib/inventory/profitability';
import { z } from 'zod';

const schema = z.object({
  acquisitionCost: z.coerce.number().nonnegative().optional(),
  freightCost: z.coerce.number().nonnegative().optional(),
  importTaxesOrFees: z.coerce.number().nonnegative().optional(),
  packagingCost: z.coerce.number().nonnegative().optional(),
  shrinkageLossRate: z.coerce.number().optional(),
  paymentProcessingFeeRate: z.coerce.number().optional(),
  markupDistributor: z.coerce.number().optional(),
  markupContractor: z.coerce.number().optional(),
  markupRetail: z.coerce.number().optional(),
  // Pass null explicitly to clear a previously-set override and go back to
  // markup-computed pricing for that tier.
  distributorPriceOverride: z.coerce.number().nullable().optional(),
  contractorPriceOverride: z.coerce.number().nullable().optional(),
  retailPriceOverride: z.coerce.number().nullable().optional(),
  triggerReason: z.string().max(500).optional(),
});

/** Updates any part of a CatalogProduct's cost breakdown, fee rates,
 * markups, or price overrides, always recalculating totalLandedCost,
 * prices, net profit, and true margins from the result via the same
 * recalculateProductFinancials() the importer uses — never hand-edited
 * independently. Logs oldCost/newCost/oldFreight/newFreight to
 * CatalogPriceAuditLog whenever acquisitionCost or freightCost actually
 * changes (the two figures the audit trail is scoped to). */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { triggerReason, ...changes } = parsed.data;

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.catalogProduct.findUnique({ where: { id: params.id } });
    if (!existing) return null;

    const acquisitionCost = changes.acquisitionCost ?? Number(existing.acquisitionCost);
    const freightCost = changes.freightCost ?? Number(existing.freightCost);
    const importTaxesOrFees = changes.importTaxesOrFees ?? Number(existing.importTaxesOrFees);
    const packagingCost = changes.packagingCost ?? Number(existing.packagingCost);
    const shrinkageLossRate = changes.shrinkageLossRate ?? Number(existing.shrinkageLossRate);
    const paymentProcessingFeeRate = changes.paymentProcessingFeeRate ?? Number(existing.paymentProcessingFeeRate);
    const markupDistributor = changes.markupDistributor ?? Number(existing.markupDistributor);
    const markupContractor = changes.markupContractor ?? Number(existing.markupContractor);
    const markupRetail = changes.markupRetail ?? Number(existing.markupRetail);
    const distributorPriceOverride =
      'distributorPriceOverride' in changes
        ? changes.distributorPriceOverride
        : existing.distributorPriceOverride !== null
          ? Number(existing.distributorPriceOverride)
          : null;
    const contractorPriceOverride =
      'contractorPriceOverride' in changes
        ? changes.contractorPriceOverride
        : existing.contractorPriceOverride !== null
          ? Number(existing.contractorPriceOverride)
          : null;
    const retailPriceOverride =
      'retailPriceOverride' in changes
        ? changes.retailPriceOverride
        : existing.retailPriceOverride !== null
          ? Number(existing.retailPriceOverride)
          : null;

    const financials = recalculateProductFinancials({
      acquisitionCost,
      freightCost,
      importTaxesOrFees,
      packagingCost,
      shrinkageLossRate,
      paymentProcessingFeeRate,
      markupDistributor,
      markupContractor,
      markupRetail,
      distributorPriceOverride,
      contractorPriceOverride,
      retailPriceOverride,
    });

    const costChanged = changes.acquisitionCost !== undefined && acquisitionCost !== Number(existing.acquisitionCost);
    const freightChanged = changes.freightCost !== undefined && freightCost !== Number(existing.freightCost);
    if (costChanged || freightChanged) {
      await tx.catalogPriceAuditLog.create({
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

    return tx.catalogProduct.update({
      where: { id: existing.id },
      data: {
        acquisitionCost,
        freightCost,
        importTaxesOrFees,
        packagingCost,
        shrinkageLossRate,
        paymentProcessingFeeRate,
        markupDistributor,
        markupContractor,
        markupRetail,
        distributorPriceOverride,
        contractorPriceOverride,
        retailPriceOverride,
        ...financials,
      },
    });
  });

  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ product: updated });
}
