import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';

const CSV_COLUMNS = [
  'partNo',
  'category',
  'categoryGroup',
  'productName',
  'description',
  'pcsPerPallet',
  'weightLbs',
  'dimensions',
  'leadTimeDays',
  'acquisitionCost',
  'freightCost',
  'importTaxesOrFees',
  'packagingCost',
  'shrinkageLossRate',
  'paymentProcessingFeeRate',
  'totalLandedCost',
  'costIsEstimated',
  'shippingMethod',
  'freightClass',
  'markupDistributor',
  'markupContractor',
  'markupRetail',
  'distributorPriceOverride',
  'contractorPriceOverride',
  'retailPriceOverride',
  'distributorPrice',
  'contractorPrice',
  'retailPrice',
  'netProfitDist',
  'netProfitCont',
  'netProfitRet',
  'trueMarginDist',
  'trueMarginCont',
  'trueMarginRet',
  'isActive',
  'createdAt',
  'updatedAt',
] as const;

function toCsvValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Downloads the entire catalog — every category, every cost, freight,
 * fee, pricing tier, and net-margin figure — as CSV or JSON at any time.
 * This endpoint itself is the "download button": any authenticated request
 * to it (browser, curl, a script) gets the full current export, so no
 * separate UI control is needed to make the data available on demand. */
export async function GET(req: NextRequest) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const format = (req.nextUrl.searchParams.get('format') || 'json').toLowerCase();
  const products = await prisma.catalogProduct.findMany({ orderBy: { productName: 'asc' } });
  const today = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    const header = CSV_COLUMNS.join(',');
    const rows = products.map((p) =>
      CSV_COLUMNS.map((c) => toCsvValue((p as unknown as Record<string, unknown>)[c])).join(',')
    );
    const csv = [header, ...rows].join('\n');

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="catalog-export-${today}.csv"`,
      },
    });
  }

  return NextResponse.json({ products, count: products.length, exportedAt: new Date().toISOString() });
}
