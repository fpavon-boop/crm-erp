import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Price-list sync (docs/PRICE_SYNC.md). The fixture workbook mimics the real
 * CTBOS file: price/cost cells are FORMULAS with no stored result, in the
 * three row shapes it uses (cost-driven, fixed-retail, estimated-cost).
 */

type Mod = typeof import('../src/lib/inventory/price-sync');

interface PlRow {
  partNo: string;
  category: string;
  product: string;
  pcs?: number | '-';
  weight?: number | '-';
  cost: number | { formula: string };
  distFormula?: boolean;
  retail?: number | { formula: string };
  mDist?: number;
  mCont?: number;
  mRet?: number | { formula: string };
}

const HEADERS = [
  'PartNo', 'Category', 'Product', 'Description', 'Pcs/Plt', 'Weight (lbs)', 'Cost',
  'Distributor Price', 'Contractor Price', 'Retail Price', 'Markup_Dist%', 'Markup_Cont%', 'Markup_Ret%',
];

async function buildWorkbook(
  rows: PlRow[],
  woo: Array<Record<string, string | number>> = [],
  mutate?: (ws: ExcelJS.Worksheet) => void
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Price List');
  ws.addRow(HEADERS);
  rows.forEach((r, i) => {
    const n = i + 2;
    const row = ws.getRow(n);
    row.getCell('A').value = r.partNo;
    row.getCell('B').value = r.category;
    row.getCell('C').value = r.product;
    row.getCell('D').value = `${r.product} description`;
    row.getCell('E').value = r.pcs ?? '-';
    row.getCell('F').value = r.weight ?? '-';
    row.getCell('G').value = typeof r.cost === 'number' ? r.cost : r.cost;
    row.getCell('H').value = { formula: `ROUND(G${n}*(1+K${n}/100),2)` } as ExcelJS.CellFormulaValue;
    row.getCell('I').value = { formula: `ROUND(G${n}*(1+L${n}/100),2)` } as ExcelJS.CellFormulaValue;
    row.getCell('J').value =
      r.retail !== undefined
        ? (r.retail as ExcelJS.CellValue)
        : ({ formula: `ROUND(G${n}*(1+M${n}/100),2)` } as ExcelJS.CellFormulaValue);
    row.getCell('K').value = r.mDist ?? 20;
    row.getCell('L').value = r.mCont ?? 30;
    row.getCell('M').value = r.mRet ?? 40;
    row.commit();
  });
  mutate?.(ws);

  if (woo.length) {
    const wsw = wb.addWorksheet('WooCommerce Products');
    const cols = ['Type', 'SKU', 'Name', 'ID', 'Parent', 'Regular price', 'Length (in)', 'Width (in)', 'Height (in)'];
    wsw.addRow(cols);
    woo.forEach((w) => wsw.addRow(cols.map((c) => w[c] ?? null)));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// row 2 = cost-driven (pallet item), row 3 = fixed retail, row 4 = estimated
// cost + heavy, row 5 = plain light accessory
const BASE: PlRow[] = [
  { partNo: 'A-1', category: 'Medium Duty', product: 'Brick A', pcs: 888, weight: 3.9, cost: 1.38 },
  {
    partNo: 'B-1', category: 'Stain', product: 'Stain B', weight: 10, cost: 90, retail: 108.99,
    mRet: { formula: 'ROUND((J3/G3-1)*100,1)' },
  },
  {
    partNo: 'C-1', category: 'Gas Oven', product: 'Oven C', weight: 200,
    cost: { formula: 'ROUND(J4/(1+M4/100),2)' }, retail: 1600,
  },
  { partNo: 'D-1', category: 'Accessories', product: 'Tool D', weight: 5, cost: 10 },
];

let db: TestDb;
let mod: Mod;

// One database + one import for the whole file: the module's Prisma client
// is created on first import, so DATABASE_URL must already point at the
// throwaway test database by then.
beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  mod = await import('../src/lib/inventory/price-sync');
}, 60000);

afterAll(async () => {
  await db.stop();
});

describe('price-sync: parsing', () => {
  it('evaluates formula-only cells in all three row shapes', async () => {
    const parsed = await mod.parsePriceListWorkbook(await buildWorkbook(BASE));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(4);
    const [a, b, c, d] = parsed.rows;

    expect(a.acquisitionCost).toBe(1.38);
    expect([a.markupDistributor, a.markupContractor, a.markupRetail]).toEqual([20, 30, 40]);
    expect(a.retailPriceOverride).toBeNull();
    expect(a.costIsEstimated).toBe(false);

    expect(b.acquisitionCost).toBe(90);
    expect(b.retailPriceOverride).toBe(108.99);
    expect(b.markupRetail).toBe(21.1); // derived from the fixed retail price
    expect(b.costIsEstimated).toBe(false);

    expect(c.acquisitionCost).toBe(1142.86); // 1600 / 1.40
    expect(c.retailPriceOverride).toBe(1600);
    expect(c.costIsEstimated).toBe(true);

    expect(d.retailPriceOverride).toBeNull();
  });

  it('marks pallet items and items >=150 lb as LTL freight, everything else as parcel', async () => {
    const parsed = await mod.parsePriceListWorkbook(await buildWorkbook(BASE));
    const ship = Object.fromEntries(parsed.rows.map((r) => [r.partNo, r.shippingMethod]));
    expect(ship).toEqual({ 'A-1': 'LTL_FREIGHT', 'B-1': 'PARCEL', 'C-1': 'LTL_FREIGHT', 'D-1': 'PARCEL' });
    expect(parsed.rows[0].pcsPerPallet).toBe(888);
    expect(parsed.rows[1].pcsPerPallet).toBeNull(); // "-" becomes empty
  });

  it('maps categories to groups explicitly and warns (not fails) on an unknown one', async () => {
    const parsed = await mod.parsePriceListWorkbook(
      await buildWorkbook([...BASE, { partNo: 'E-1', category: 'Mystery', product: 'Thing', cost: 5 }])
    );
    const group = Object.fromEntries(parsed.rows.map((r) => [r.partNo, r.categoryGroup]));
    expect(group).toMatchObject({ 'A-1': 'REFRACTORY', 'B-1': 'STAIN_ENHANCER', 'C-1': 'OVEN', 'D-1': 'ACCESSORY', 'E-1': 'OTHER' });
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings.some((w) => w.partNo === 'E-1' && /Unknown category/.test(w.message))).toBe(true);
  });

  it('refuses a formula it does not recognise instead of guessing', async () => {
    const buf = await buildWorkbook(BASE, [], (ws) => {
      ws.getRow(2).getCell('G').value = { formula: 'SUM(J2:J3)*2' } as ExcelJS.CellFormulaValue;
    });
    const parsed = await mod.parsePriceListWorkbook(buf);
    expect(parsed.errors.some((e) => e.row === 2 && /unsupported formula/i.test(e.message))).toBe(true);
  });

  it('reports duplicate PartNos (case-insensitive), missing names and non-positive costs as errors', async () => {
    const parsed = await mod.parsePriceListWorkbook(
      await buildWorkbook([
        { partNo: 'X-1', category: 'Mortar', product: 'One', cost: 5 },
        { partNo: 'x-1', category: 'Mortar', product: 'Dup', cost: 5 },
        { partNo: 'X-2', category: 'Mortar', product: 'Free', cost: 0 },
      ])
    );
    const msgs = parsed.errors.map((e) => e.message).join(' | ');
    expect(msgs).toMatch(/Duplicate PartNo/);
    expect(msgs).toMatch(/Cost is missing or not greater than 0/);
  });

  it('errors clearly when the Price List sheet is missing', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Something else');
    const parsed = await mod.parsePriceListWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed.errors[0].message).toMatch(/no "Price List" sheet/);
  });

  it('takes dimensions from WooCommerce (by SKU and by WC-ID), cross-checks retail, and lists Woo-only products', async () => {
    const rows: PlRow[] = [
      { partNo: 'C-1', category: 'Gas Oven', product: 'Oven C', weight: 200, cost: { formula: 'ROUND(J2/(1+M2/100),2)' }, retail: 1600 },
      { partNo: 'WC-777', category: 'Brick Oven', product: 'Oven W', cost: 100 }, // retail = 140
    ];
    const woo = [
      { Type: 'variable', SKU: 'C-1', Name: 'Oven C', ID: 500, 'Length (in)': 20, 'Width (in)': 10.5, 'Height (in)': 5 },
      { Type: 'variation', Name: 'Oven C - Red', Parent: 'id:500', 'Regular price': 1500 }, // differs from 1600
      { Type: 'simple', Name: 'Oven W', ID: 777, 'Regular price': 140, 'Length (in)': '38.58', 'Width (in)': '33.46', 'Height (in)': '19.69' },
      { Type: 'variable', SKU: 'ONLY-WOO', Name: 'Only in Woo', ID: 999 },
    ];
    const parsed = await mod.parsePriceListWorkbook(await buildWorkbook(rows, woo));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0].dimensions).toBe('20 x 10.5 x 5 in');
    expect(parsed.rows[1].dimensions).toBe('38.58 x 33.46 x 19.69 in');
    expect(parsed.warnings.filter((w) => /Retail price differs/.test(w.message)).map((w) => w.partNo)).toEqual(['C-1']);
    expect(parsed.wooOnly.map((w) => w.sku)).toEqual(['ONLY-WOO']);
  });
});

describe('price-sync: plan, apply, mirror', () => {
  const parse = async (rows: PlRow[] = BASE) => mod.parsePriceListWorkbook(await buildWorkbook(rows));
  const run = (parsed: Awaited<ReturnType<typeof parse>>, apply: boolean, mirrorCore = false) =>
    mod.runPriceSync(parsed, { apply, mirrorCore, fileName: 'test.xlsx' });

  it('a dry run reports what would be created and writes nothing', async () => {
    const res = await run(await parse(), false);
    expect(res.applied).toBe(false);
    expect(res.summary).toMatchObject({ create: 4, update: 0, unchanged: 0, estimatedCost: 1, fixedRetail: 2, ltl: 2 });
    expect(await db.prisma.catalogProduct.count()).toBe(0);
  });

  it('apply creates the products with engine-computed prices, overrides and flags', async () => {
    const res = await run(await parse(), true);
    expect(res.summary.create).toBe(4);

    const a = await db.prisma.catalogProduct.findUniqueOrThrow({ where: { partNo: 'A-1' } });
    expect(Number(a.distributorPrice)).toBe(1.66);
    expect(Number(a.contractorPrice)).toBe(1.79);
    expect(Number(a.retailPrice)).toBe(1.93);
    expect(a.shippingMethod).toBe('LTL_FREIGHT');
    expect(a.categoryGroup).toBe('REFRACTORY');

    const c = await db.prisma.catalogProduct.findUniqueOrThrow({ where: { partNo: 'C-1' } });
    expect(c.costIsEstimated).toBe(true);
    expect(Number(c.retailPriceOverride)).toBe(1600);
    expect(Number(c.retailPrice)).toBe(1600);

    const audit = await db.prisma.auditLog.findFirst({ where: { action: 'PRICE_SYNC' } });
    expect(audit).not.toBeNull();
  });

  it('is idempotent: re-applying the same file changes nothing', async () => {
    const before = await db.prisma.catalogProduct.findMany({ orderBy: { partNo: 'asc' } });
    const res = await run(await parse(), true);
    expect(res.summary).toMatchObject({ create: 0, update: 0, unchanged: 4 });
    const after = await db.prisma.catalogProduct.findMany({ orderBy: { partNo: 'asc' } });
    expect(after.map((p) => p.updatedAt.getTime())).toEqual(before.map((p) => p.updatedAt.getTime()));
  });

  it('a cost change updates prices, shows the diff, and writes a price audit log row', async () => {
    const changed = BASE.map((r) => (r.partNo === 'A-1' ? { ...r, cost: 1.5 } : r));
    const dry = await run(await parse(changed), false);
    expect(dry.summary.update).toBe(1);
    expect(dry.changed[0].partNo).toBe('A-1');
    expect(dry.changed[0].diffs.map((d) => d.field)).toContain('acquisitionCost');

    await run(await parse(changed), true);
    const a = await db.prisma.catalogProduct.findUniqueOrThrow({ where: { partNo: 'A-1' } });
    expect(Number(a.acquisitionCost)).toBe(1.5);
    expect(Number(a.retailPrice)).toBe(2.1);
    const log = await db.prisma.catalogPriceAuditLog.findFirst({ where: { productId: a.id } });
    expect(Number(log?.oldCost)).toBe(1.38);
    expect(Number(log?.newCost)).toBe(1.5);
    expect(log?.triggerReason).toContain('test.xlsx');
  });

  it('keeps freight/fees entered elsewhere instead of resetting them to 0', async () => {
    await db.prisma.catalogProduct.update({ where: { partNo: 'D-1' }, data: { freightCost: 2 } });
    await run(await parse(), true);
    const d = await db.prisma.catalogProduct.findUniqueOrThrow({ where: { partNo: 'D-1' } });
    expect(Number(d.freightCost)).toBe(2);
    expect(Number(d.totalLandedCost)).toBe(12); // 10 cost + 2 freight
  });

  it('mirrors retail price and real cost onto matching core products only — never creates, never copies an estimated cost', async () => {
    const mk = (sku: string, price: number, cost: number) =>
      db.prisma.product.create({ data: { sku, name: `Core ${sku}`, price, cost } });
    await mk('A-1', 1, 1);
    await mk('C-1', 5, 5);
    await mk('UNRELATED', 9, 9);
    const before = await db.prisma.product.count();

    const res = await run(await parse(), true, true);
    expect(res.summary.mirrorUpdates).toBe(2);

    const a = await db.prisma.product.findUniqueOrThrow({ where: { sku: 'A-1' } });
    expect(Number(a.price)).toBe(1.93);
    expect(Number(a.cost)).toBe(1.38);

    const c = await db.prisma.product.findUniqueOrThrow({ where: { sku: 'C-1' } });
    expect(Number(c.price)).toBe(1600);
    expect(Number(c.cost)).toBe(5); // estimated cost NOT copied

    const other = await db.prisma.product.findUniqueOrThrow({ where: { sku: 'UNRELATED' } });
    expect(Number(other.price)).toBe(9);
    expect(await db.prisma.product.count()).toBe(before); // no products created
  });

  it('lists catalog products missing from the file but never deletes or deactivates them', async () => {
    await db.prisma.catalogProduct.create({
      data: {
        partNo: 'OLD-1', productName: 'Old', acquisitionCost: 1, totalLandedCost: 1,
        distributorPrice: 1, contractorPrice: 1, retailPrice: 1,
        netProfitDist: 0, netProfitCont: 0, netProfitRet: 0, trueMarginDist: 0, trueMarginCont: 0, trueMarginRet: 0,
      },
    });
    const res = await run(await parse(), true);
    expect(res.missingInFile.map((m) => m.partNo)).toContain('OLD-1');
    const old = await db.prisma.catalogProduct.findUniqueOrThrow({ where: { partNo: 'OLD-1' } });
    expect(old.isActive).toBe(true);
  });

  it('refuses to run (and writes nothing) when the file has errors', async () => {
    const bad = await parse([{ partNo: 'Z-1', category: 'Mortar', product: 'Free', cost: 0 }]);
    expect(bad.errors.length).toBeGreaterThan(0);
    const countBefore = await db.prisma.catalogProduct.count();
    await expect(run(bad, true)).rejects.toThrow(/nothing was synced/);
    expect(await db.prisma.catalogProduct.count()).toBe(countBefore);
  });
});
