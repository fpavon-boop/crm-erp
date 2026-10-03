import crypto from 'crypto';
import ExcelJS from 'exceljs';
import { prisma } from '@/lib/prisma';
import { logAudit } from '@/lib/audit';
import { recalculateProductFinancials, type ProductFinancialsResult } from './profitability';
import type { CatalogCategoryGroup, Prisma, ShippingMethod } from '@prisma/client';

/**
 * Price-list sync: reads the CTBOS price-list workbook ("Price List" sheet
 * = source of truth for names, costs, markups and fixed prices;
 * "WooCommerce Products" sheet = enrichment/cross-check only) and upserts
 * CatalogProduct rows keyed by partNo, optionally mirroring retail price
 * and cost onto existing core `Product` rows with the same SKU.
 *
 * Safety properties (see docs/PRICE_SYNC.md):
 * - Parsing never writes anything; `planSync` never writes anything.
 * - Any problem in the file (unknown formula, bad cost, duplicate PartNo...)
 *   is reported as an error and the whole run is refused — no partial sync.
 * - Writes happen in ONE transaction (all-or-nothing) and only for rows
 *   that actually changed, so re-running the same file changes nothing.
 * - Nothing is ever deleted or deactivated.
 */

export const PRICE_LIST_SHEET = 'Price List';
export const WOO_SHEET = 'WooCommerce Products';
/** Items at or above this weight ship LTL freight (as does anything with a
 * Pcs/Plt value, since those are sold and shipped by the pallet). */
export const LTL_WEIGHT_THRESHOLD_LBS = 150;
const DEFAULT_PAYMENT_FEE_RATE = 2.9;

const CATEGORY_GROUPS: Record<string, CatalogCategoryGroup> = {
  'medium duty': 'REFRACTORY',
  'jet d.p.': 'REFRACTORY',
  'pilot d.p.': 'REFRACTORY',
  'high alumina': 'REFRACTORY',
  'fireclay brick': 'REFRACTORY',
  insulation: 'REFRACTORY',
  castable: 'REFRACTORY',
  clay: 'REFRACTORY',
  mortar: 'REFRACTORY',
  tile: 'REFRACTORY',
  stain: 'STAIN_ENHANCER',
  accessories: 'ACCESSORY',
  'portable oven': 'OVEN',
  'gas oven': 'OVEN',
  'wood oven': 'OVEN',
  'brick oven': 'OVEN',
  'neapolitan oven': 'OVEN',
  'hp high base oven': 'OVEN',
  'hp dome kit': 'OVEN',
};

export class SyncParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncParseError';
  }
}

export interface SyncIssue {
  row?: number;
  partNo?: string;
  message: string;
}

export interface SyncRow {
  sheetRow: number;
  partNo: string;
  category: string | null;
  categoryGroup: CatalogCategoryGroup;
  productName: string;
  description: string | null;
  pcsPerPallet: number | null;
  weightLbs: number | null;
  dimensions: string | null;
  acquisitionCost: number;
  costIsEstimated: boolean;
  markupDistributor: number;
  markupContractor: number;
  markupRetail: number;
  distributorPriceOverride: number | null;
  contractorPriceOverride: number | null;
  retailPriceOverride: number | null;
  shippingMethod: ShippingMethod;
}

export interface ParsedWorkbook {
  fileHash: string;
  rows: SyncRow[];
  errors: SyncIssue[];
  warnings: SyncIssue[];
  wooOnly: Array<{ id: string | null; sku: string | null; name: string }>;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Cell reading & the (small, closed) set of formulas the price list uses.
// The workbook is generated without stored formula results, so values have
// to be evaluated here; anything not recognised is an error, never a guess.
// ---------------------------------------------------------------------------

const F_MUL = /^ROUND\(([A-Z]+)(\d+)\*\(1\+([A-Z]+)(\d+)\/100\),2\)$/;
const F_DIV = /^ROUND\(([A-Z]+)(\d+)\/\(1\+([A-Z]+)(\d+)\/100\),2\)$/;
const F_MARKUP = /^ROUND\(\(([A-Z]+)(\d+)\/([A-Z]+)(\d+)-1\)\*100,1\)$/;

interface Evaluated {
  value: number | null;
  /** Formula text when the cell is a formula, else null. */
  formula: string | null;
}

function evalCell(ws: ExcelJS.Worksheet, rowNum: number, col: string | number, depth = 0): Evaluated {
  if (depth > 4) throw new SyncParseError(`Row ${rowNum}: formulas nested too deeply`);
  const v = ws.getRow(rowNum).getCell(col).value as unknown;

  if (v === null || v === undefined || v === '') return { value: null, formula: null };
  if (typeof v === 'number') return { value: v, formula: null };
  if (typeof v === 'string') {
    const t = v.trim().replace(/[$,%\s]/g, '');
    if (t === '' || t === '-') return { value: null, formula: null };
    const n = Number(t);
    if (!Number.isFinite(n)) throw new SyncParseError(`Row ${rowNum}: "${v}" is not a number`);
    return { value: n, formula: null };
  }

  if (typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) {
    const f = v as { formula?: string; sharedFormula?: string; result?: unknown };
    const text = f.formula ?? null;
    if (typeof f.result === 'number') return { value: f.result, formula: text };
    if (f.result !== undefined && f.result !== null) {
      throw new SyncParseError(`Row ${rowNum}: a formula cell holds an error value (${JSON.stringify(f.result)})`);
    }
    if (!text) {
      throw new SyncParseError(
        `Row ${rowNum}: a shared formula has no stored value — open the file in Excel, save it, and try again`
      );
    }

    const sameRow = (...refs: string[]) => {
      if (refs.some((r) => Number(r) !== rowNum)) {
        throw new SyncParseError(`Row ${rowNum}: formula "${text}" references another row, which isn't supported`);
      }
    };
    const need = (e: Evaluated, label: string): number => {
      if (e.value === null) throw new SyncParseError(`Row ${rowNum}: formula "${text}" needs a value in ${label}`);
      return e.value;
    };

    let m = F_MUL.exec(text);
    if (m) {
      sameRow(m[2], m[4]);
      const a = need(evalCell(ws, rowNum, m[1], depth + 1), m[1]);
      const b = need(evalCell(ws, rowNum, m[3], depth + 1), m[3]);
      return { value: round(a * (1 + b / 100), 2), formula: text };
    }
    m = F_DIV.exec(text);
    if (m) {
      sameRow(m[2], m[4]);
      const a = need(evalCell(ws, rowNum, m[1], depth + 1), m[1]);
      const b = need(evalCell(ws, rowNum, m[3], depth + 1), m[3]);
      return { value: round(a / (1 + b / 100), 2), formula: text };
    }
    m = F_MARKUP.exec(text);
    if (m) {
      sameRow(m[2], m[4]);
      const a = need(evalCell(ws, rowNum, m[1], depth + 1), m[1]);
      const b = need(evalCell(ws, rowNum, m[3], depth + 1), m[3]);
      if (b === 0) throw new SyncParseError(`Row ${rowNum}: formula "${text}" divides by zero`);
      return { value: round((a / b - 1) * 100, 1), formula: text };
    }
    throw new SyncParseError(`Row ${rowNum}: unsupported formula "${text}" — refusing to guess its value`);
  }

  throw new SyncParseError(`Row ${rowNum}: unsupported cell value`);
}

function cellText(ws: ExcelJS.Worksheet, rowNum: number, col: string | number): string | null {
  const v = ws.getRow(rowNum).getCell(col).value as unknown;
  if (v === null || v === undefined) return null;
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else if (typeof v === 'object' && 'richText' in v) s = (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('');
  else if (typeof v === 'object' && 'text' in v) s = String((v as { text: unknown }).text);
  else if (typeof v === 'object' && 'result' in v) s = String((v as { result: unknown }).result ?? '');
  else return null;
  s = s.trim();
  return s === '' ? null : s;
}

function headerMap(ws: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  ws.getRow(1).eachCell((cell, colNumber) => {
    const t = cellText(ws, 1, colNumber);
    if (t) map.set(t.toLowerCase(), colNumber);
  });
  return map;
}

function numOrNull(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Workbook parsing
// ---------------------------------------------------------------------------

interface WooRow {
  id: string | null;
  sku: string | null;
  type: string;
  name: string;
  parent: string | null;
  price: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
}

function readWooSheet(ws: ExcelJS.Worksheet): WooRow[] {
  const h = headerMap(ws);
  const col = (name: string) => h.get(name.toLowerCase());
  const out: WooRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const get = (name: string) => (col(name) ? cellText(ws, r, col(name)!) : null);
    const name = get('Name');
    const id = get('ID');
    if (!name && !id) continue;
    out.push({
      id,
      sku: get('SKU'),
      type: (get('Type') || '').toLowerCase(),
      name: name || '',
      parent: get('Parent'),
      price: numOrNull(get('Regular price')),
      length: numOrNull(get('Length (in)')),
      width: numOrNull(get('Width (in)')),
      height: numOrNull(get('Height (in)')),
    });
  }
  return out;
}

function fmtDim(n: number): string {
  return String(round(n, 2));
}

/** Parses the workbook into validated rows. Never touches the database. A
 * returned `errors` entry means the run must be refused. */
export async function parsePriceListWorkbook(buffer: Buffer): Promise<ParsedWorkbook> {
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const errors: SyncIssue[] = [];
  const warnings: SyncIssue[] = [];

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const ws = wb.getWorksheet(PRICE_LIST_SHEET);
  if (!ws) {
    return { fileHash, rows: [], errors: [{ message: `The workbook has no "${PRICE_LIST_SHEET}" sheet.` }], warnings, wooOnly: [] };
  }

  const h = headerMap(ws);
  const required = ['partno', 'product', 'cost', 'markup_dist%', 'markup_cont%', 'markup_ret%'];
  const missing = required.filter((k) => !h.has(k));
  if (missing.length) {
    return {
      fileHash,
      rows: [],
      errors: [{ message: `"${PRICE_LIST_SHEET}" is missing column(s): ${missing.join(', ')}` }],
      warnings,
      wooOnly: [],
    };
  }
  const C = (name: string) => h.get(name)!;
  const optionalCol = (name: string) => h.get(name);

  // Woo sheet (optional enrichment)
  const wooSheet = wb.getWorksheet(WOO_SHEET);
  const woo = wooSheet ? readWooSheet(wooSheet) : [];
  if (!wooSheet) warnings.push({ message: `No "${WOO_SHEET}" sheet — skipping dimensions and the retail-price cross-check.` });
  const wooBySku = new Map<string, WooRow>();
  const wooById = new Map<string, WooRow>();
  const wooChildren = new Map<string, WooRow[]>();
  for (const w of woo) {
    if (w.sku) wooBySku.set(w.sku, w);
    if (w.id) wooById.set(w.id, w);
    if (w.parent && w.parent.startsWith('id:')) {
      const pid = w.parent.slice(3);
      wooChildren.set(pid, [...(wooChildren.get(pid) || []), w]);
    }
  }
  const wooMatched = new Set<WooRow>();

  const rows: SyncRow[] = [];
  const seen = new Map<string, number>();

  for (let r = 2; r <= ws.rowCount; r++) {
    const partNo = cellText(ws, r, C('partno'));
    const productName = cellText(ws, r, C('product'));
    const costCell = ws.getRow(r).getCell(C('cost')).value;
    if (!partNo && !productName && (costCell === null || costCell === undefined)) continue; // blank row

    const fail = (message: string) => errors.push({ row: r, partNo: partNo ?? undefined, message });

    if (!partNo) { fail('Missing PartNo'); continue; }
    if (!productName) { fail('Missing Product name'); continue; }
    const key = partNo.toLowerCase();
    if (seen.has(key)) { fail(`Duplicate PartNo (also on row ${seen.get(key)})`); continue; }
    seen.set(key, r);

    try {
      const cost = evalCell(ws, r, C('cost'));
      const mDist = evalCell(ws, r, C('markup_dist%')).value;
      const mCont = evalCell(ws, r, C('markup_cont%')).value;
      const mRet = evalCell(ws, r, C('markup_ret%')).value;

      if (cost.value === null || !(cost.value > 0)) { fail('Cost is missing or not greater than 0'); continue; }
      if (mDist === null || mCont === null || mRet === null) { fail('A markup % is missing'); continue; }
      if (![mDist, mCont, mRet].every((m) => m > -100 && m < 10000)) { fail('A markup % is out of range'); continue; }

      // A tier price typed in as a number is a fixed override; a formula is
      // just the markup calculation and is recomputed by the engine.
      const tier = (name: string): { override: number | null; computed: number | null } => {
        const c = optionalCol(name);
        if (!c) return { override: null, computed: null };
        const e = evalCell(ws, r, c);
        if (e.formula !== null) return { override: null, computed: e.value };
        return { override: e.value, computed: null };
      };
      const dist = tier('distributor price');
      const cont = tier('contractor price');
      const ret = tier('retail price');
      for (const o of [dist.override, cont.override, ret.override]) {
        if (o !== null && !(o >= 0)) throw new SyncParseError(`Row ${r}: a price is negative`);
      }

      // The cost cell holds "retail / (1 + markup)" instead of a real cost
      // → it's an estimate, and downstream must not treat it as real.
      const costIsEstimated = cost.formula !== null && F_DIV.test(cost.formula);

      const categoryCol = optionalCol('category');
      const category = categoryCol ? cellText(ws, r, categoryCol) : null;
      const groupKey = (category || '').toLowerCase();
      let categoryGroup = CATEGORY_GROUPS[groupKey];
      if (!categoryGroup) {
        categoryGroup = 'OTHER';
        warnings.push({ row: r, partNo, message: `Unknown category "${category ?? ''}" — grouped as OTHER` });
      }

      const pcsRaw = optionalCol('pcs/plt') ? evalCell(ws, r, optionalCol('pcs/plt')!).value : null;
      const weight = optionalCol('weight (lbs)') ? evalCell(ws, r, optionalCol('weight (lbs)')!).value : null;
      const pcsPerPallet = pcsRaw !== null ? Math.round(pcsRaw) : null;
      const shippingMethod: ShippingMethod =
        pcsPerPallet !== null || (weight !== null && weight >= LTL_WEIGHT_THRESHOLD_LBS) ? 'LTL_FREIGHT' : 'PARCEL';

      const row: SyncRow = {
        sheetRow: r,
        partNo,
        category,
        categoryGroup,
        productName,
        description: optionalCol('description') ? cellText(ws, r, optionalCol('description')!) : null,
        pcsPerPallet,
        weightLbs: weight,
        dimensions: null,
        acquisitionCost: cost.value,
        costIsEstimated,
        markupDistributor: mDist,
        markupContractor: mCont,
        markupRetail: mRet,
        distributorPriceOverride: dist.override,
        contractorPriceOverride: cont.override,
        retailPriceOverride: ret.override,
        shippingMethod,
      };

      // Sanity: the engine's price must agree with what the sheet's own
      // formula says; a difference means the sheet's math changed.
      const fin = recalculateProductFinancials({
        acquisitionCost: row.acquisitionCost,
        freightCost: 0,
        importTaxesOrFees: 0,
        packagingCost: 0,
        shrinkageLossRate: 0,
        paymentProcessingFeeRate: DEFAULT_PAYMENT_FEE_RATE,
        markupDistributor: mDist,
        markupContractor: mCont,
        markupRetail: mRet,
        distributorPriceOverride: dist.override,
        contractorPriceOverride: cont.override,
        retailPriceOverride: ret.override,
      });
      for (const [label, sheetVal, engineVal] of [
        ['Distributor', dist.computed, fin.distributorPrice],
        ['Contractor', cont.computed, fin.contractorPrice],
        ['Retail', ret.computed, fin.retailPrice],
      ] as const) {
        if (sheetVal !== null && Math.abs(sheetVal - engineVal) > 0.011) {
          warnings.push({ row: r, partNo, message: `${label} price in the sheet (${sheetVal}) differs from the computed ${engineVal}` });
        }
      }

      // Woo enrichment + cross-check
      const idMatch = /^WC-(\d+)$/.exec(partNo);
      const w = wooBySku.get(partNo) ?? (idMatch ? wooById.get(idMatch[1]) : undefined);
      if (w) {
        wooMatched.add(w);
        const kids = w.id ? wooChildren.get(w.id) || [] : [];
        kids.forEach((k) => wooMatched.add(k));
        const withDims = [w, ...kids].find((x) => x.length && x.width && x.height);
        if (withDims) row.dimensions = `${fmtDim(withDims.length!)} x ${fmtDim(withDims.width!)} x ${fmtDim(withDims.height!)} in`;

        const prices = w.price !== null ? [w.price] : kids.map((k) => k.price).filter((p): p is number => p !== null);
        const distinct = [...new Set(prices.map((p) => round(p, 2)))];
        if (distinct.length === 1 && Math.abs(distinct[0] - fin.retailPrice) >= 0.005) {
          warnings.push({ row: r, partNo, message: `Retail price differs: price list ${fin.retailPrice} vs WooCommerce ${distinct[0]}` });
        } else if (distinct.length > 1) {
          warnings.push({ row: r, partNo, message: `WooCommerce has several variation prices (${distinct.join(', ')}) — retail not cross-checked` });
        }
      }

      rows.push(row);
    } catch (err) {
      if (err instanceof SyncParseError) fail(err.message);
      else throw err;
    }
  }

  if (rows.length === 0 && errors.length === 0) errors.push({ message: `"${PRICE_LIST_SHEET}" has no product rows.` });

  const wooOnly = woo
    .filter((x) => x.type !== 'variation' && !wooMatched.has(x))
    .map((x) => ({ id: x.id, sku: x.sku, name: x.name }));

  return { fileHash, rows, errors, warnings, wooOnly };
}

// ---------------------------------------------------------------------------
// Planning (read-only) and applying (one transaction)
// ---------------------------------------------------------------------------

type Db = typeof prisma | Prisma.TransactionClient;

export interface FieldDiff {
  field: string;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
}

interface PlannedRow {
  row: SyncRow;
  financials: ProductFinancialsResult;
  data: Record<string, unknown>;
}

export interface SyncPlan {
  create: PlannedRow[];
  update: Array<PlannedRow & { existingId: string; diffs: FieldDiff[]; costChanged: { from: number; to: number; freight: number } | null }>;
  unchanged: number;
  missingInFile: Array<{ partNo: string; productName: string }>;
  mirror: {
    enabled: boolean;
    updates: Array<{ id: string; sku: string; name: string; price: { from: number; to: number }; cost: { from: number; to: number } | null }>;
    noMatch: number;
  };
}

function norm(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return v.toFixed(2);
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  // Prisma.Decimal
  return Number(v as { toString(): string }).toFixed(2);
}

const DISPLAY_FIELDS = [
  'productName', 'category', 'categoryGroup', 'description', 'pcsPerPallet', 'weightLbs', 'dimensions',
  'acquisitionCost', 'costIsEstimated', 'markupDistributor', 'markupContractor', 'markupRetail',
  'distributorPriceOverride', 'contractorPriceOverride', 'retailPriceOverride', 'shippingMethod',
  'distributorPrice', 'contractorPrice', 'retailPrice',
] as const;
const DERIVED_FIELDS = [
  'totalLandedCost', 'netProfitDist', 'netProfitCont', 'netProfitRet', 'trueMarginDist', 'trueMarginCont', 'trueMarginRet',
] as const;

function plain(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return Number(v as { toString(): string });
}

export async function planSync(db: Db, rows: SyncRow[], opts: { mirrorCore: boolean }): Promise<SyncPlan> {
  const partNos = rows.map((r) => r.partNo);
  const existing = await db.catalogProduct.findMany({ where: { partNo: { in: partNos } } });
  const byPart = new Map(existing.map((e) => [e.partNo, e]));

  const plan: SyncPlan = {
    create: [],
    update: [],
    unchanged: 0,
    missingInFile: [],
    mirror: { enabled: opts.mirrorCore, updates: [], noMatch: 0 },
  };
  const finByPart = new Map<string, ProductFinancialsResult>();

  for (const row of rows) {
    const ex = byPart.get(row.partNo);
    // Freight/fees/shrinkage/fee-rate aren't in the file — keep whatever is
    // already on the product (entered via the API) instead of resetting it.
    const financials = recalculateProductFinancials({
      acquisitionCost: row.acquisitionCost,
      freightCost: ex ? Number(ex.freightCost) : 0,
      importTaxesOrFees: ex ? Number(ex.importTaxesOrFees) : 0,
      packagingCost: ex ? Number(ex.packagingCost) : 0,
      shrinkageLossRate: ex ? Number(ex.shrinkageLossRate) : 0,
      paymentProcessingFeeRate: ex ? Number(ex.paymentProcessingFeeRate) : DEFAULT_PAYMENT_FEE_RATE,
      markupDistributor: row.markupDistributor,
      markupContractor: row.markupContractor,
      markupRetail: row.markupRetail,
      distributorPriceOverride: row.distributorPriceOverride,
      contractorPriceOverride: row.contractorPriceOverride,
      retailPriceOverride: row.retailPriceOverride,
    });
    finByPart.set(row.partNo, financials);

    const data: Record<string, unknown> = {
      category: row.category,
      categoryGroup: row.categoryGroup,
      productName: row.productName,
      description: row.description,
      pcsPerPallet: row.pcsPerPallet,
      weightLbs: row.weightLbs,
      // Dimensions only come from the Woo sheet — never wipe them when a
      // product has no Woo match this time.
      ...(row.dimensions !== null ? { dimensions: row.dimensions } : {}),
      acquisitionCost: row.acquisitionCost,
      costIsEstimated: row.costIsEstimated,
      markupDistributor: row.markupDistributor,
      markupContractor: row.markupContractor,
      markupRetail: row.markupRetail,
      distributorPriceOverride: row.distributorPriceOverride,
      contractorPriceOverride: row.contractorPriceOverride,
      retailPriceOverride: row.retailPriceOverride,
      shippingMethod: row.shippingMethod,
      ...financials,
    };

    if (!ex) {
      plan.create.push({ row, financials, data });
      continue;
    }

    const diffs: FieldDiff[] = [];
    for (const f of DISPLAY_FIELDS) {
      if (!(f in data)) continue;
      const before = (ex as unknown as Record<string, unknown>)[f];
      if (norm(before) !== norm(data[f])) diffs.push({ field: f, from: plain(before), to: plain(data[f]) });
    }
    const derivedChanged = DERIVED_FIELDS.some(
      (f) => norm((ex as unknown as Record<string, unknown>)[f]) !== norm((financials as unknown as Record<string, unknown>)[f])
    );
    if (diffs.length === 0 && !derivedChanged) {
      plan.unchanged++;
    } else {
      const costDiff = diffs.find((d) => d.field === 'acquisitionCost');
      plan.update.push({
        row,
        financials,
        data,
        existingId: ex.id,
        diffs,
        costChanged: costDiff ? { from: Number(ex.acquisitionCost), to: row.acquisitionCost, freight: Number(ex.freightCost) } : null,
      });
    }
  }

  const missing = await db.catalogProduct.findMany({
    where: { isActive: true, partNo: { notIn: partNos } },
    select: { partNo: true, productName: true },
    orderBy: { partNo: 'asc' },
  });
  plan.missingInFile = missing;

  if (opts.mirrorCore) {
    const products = await db.product.findMany({
      where: { sku: { in: partNos } },
      select: { id: true, sku: true, name: true, price: true, cost: true },
    });
    const rowByPart = new Map(rows.map((r) => [r.partNo, r]));
    for (const p of products) {
      const row = rowByPart.get(p.sku);
      const fin = finByPart.get(p.sku);
      if (!row || !fin) continue;
      // An estimated cost is never copied onto the ERP product — the ERP's
      // profitability reports would treat it as a real cost.
      const costTo = row.costIsEstimated ? null : fin.totalLandedCost;
      const priceChanged = norm(p.price) !== norm(fin.retailPrice);
      const costChanged = costTo !== null && norm(p.cost) !== norm(costTo);
      if (priceChanged || costChanged) {
        plan.mirror.updates.push({
          id: p.id,
          sku: p.sku,
          name: p.name,
          price: { from: Number(p.price), to: fin.retailPrice },
          cost: costChanged && costTo !== null ? { from: Number(p.cost), to: costTo } : null,
        });
      }
    }
    plan.mirror.noMatch = rows.length - products.length;
  }

  return plan;
}

async function writePlan(tx: Prisma.TransactionClient, plan: SyncPlan, fileName: string) {
  for (const c of plan.create) {
    await tx.catalogProduct.create({ data: { partNo: c.row.partNo, ...c.data } as Prisma.CatalogProductUncheckedCreateInput });
  }
  for (const u of plan.update) {
    if (u.costChanged) {
      await tx.catalogPriceAuditLog.create({
        data: {
          productId: u.existingId,
          oldCost: u.costChanged.from,
          newCost: u.costChanged.to,
          oldFreight: u.costChanged.freight,
          newFreight: u.costChanged.freight,
          triggerReason: `Price list sync (${fileName})`,
        },
      });
    }
    await tx.catalogProduct.update({ where: { id: u.existingId }, data: u.data as Prisma.CatalogProductUncheckedUpdateInput });
  }
  for (const m of plan.mirror.updates) {
    await tx.product.update({
      where: { id: m.id },
      data: { price: m.price.to, ...(m.cost ? { cost: m.cost.to } : {}) },
    });
  }
}

// ---------------------------------------------------------------------------
// Public entry point + response shape shared by the API route, the admin
// page and the CLI.
// ---------------------------------------------------------------------------

export interface SyncResponse {
  ok: true;
  applied: boolean;
  fileHash: string;
  summary: {
    rows: number;
    create: number;
    update: number;
    unchanged: number;
    estimatedCost: number;
    fixedRetail: number;
    ltl: number;
    missingInFile: number;
    mirrorUpdates: number;
    mirrorNoMatch: number;
    mirrorEnabled: boolean;
  };
  created: Array<{ partNo: string; name: string; categoryGroup: string; cost: number; retail: number; estimated: boolean }>;
  changed: Array<{ partNo: string; name: string; diffs: FieldDiff[] }>;
  missingInFile: Array<{ partNo: string; productName: string }>;
  mirror: Array<{ sku: string; name: string; price: { from: number; to: number }; cost: { from: number; to: number } | null }>;
  warnings: SyncIssue[];
  wooOnly: ParsedWorkbook['wooOnly'];
  truncated: boolean;
}

const CAP = 300;

export async function runPriceSync(
  parsed: ParsedWorkbook,
  opts: { apply: boolean; mirrorCore: boolean; fileName: string; userId?: string | null }
): Promise<SyncResponse> {
  if (parsed.errors.length) throw new SyncParseError('The file has errors; nothing was synced.');

  let plan: SyncPlan;
  if (opts.apply) {
    plan = await prisma.$transaction(
      async (tx) => {
        const p = await planSync(tx, parsed.rows, { mirrorCore: opts.mirrorCore });
        await writePlan(tx, p, opts.fileName);
        return p;
      },
      { timeout: 60000, maxWait: 10000 }
    );
  } else {
    plan = await planSync(prisma, parsed.rows, { mirrorCore: opts.mirrorCore });
  }

  const fin = (p: PlannedRow) => p.financials;
  const response: SyncResponse = {
    ok: true,
    applied: opts.apply,
    fileHash: parsed.fileHash,
    summary: {
      rows: parsed.rows.length,
      create: plan.create.length,
      update: plan.update.length,
      unchanged: plan.unchanged,
      estimatedCost: parsed.rows.filter((r) => r.costIsEstimated).length,
      fixedRetail: parsed.rows.filter((r) => r.retailPriceOverride !== null).length,
      ltl: parsed.rows.filter((r) => r.shippingMethod === 'LTL_FREIGHT').length,
      missingInFile: plan.missingInFile.length,
      mirrorUpdates: plan.mirror.updates.length,
      mirrorNoMatch: plan.mirror.noMatch,
      mirrorEnabled: plan.mirror.enabled,
    },
    created: plan.create.slice(0, CAP).map((c) => ({
      partNo: c.row.partNo,
      name: c.row.productName,
      categoryGroup: c.row.categoryGroup,
      cost: c.row.acquisitionCost,
      retail: fin(c).retailPrice,
      estimated: c.row.costIsEstimated,
    })),
    changed: plan.update.slice(0, CAP).map((u) => ({ partNo: u.row.partNo, name: u.row.productName, diffs: u.diffs })),
    missingInFile: plan.missingInFile.slice(0, CAP),
    mirror: plan.mirror.updates.slice(0, CAP).map(({ sku, name, price, cost }) => ({ sku, name, price, cost })),
    warnings: parsed.warnings,
    wooOnly: parsed.wooOnly,
    truncated: plan.create.length > CAP || plan.update.length > CAP || plan.mirror.updates.length > CAP,
  };

  if (opts.apply) {
    try {
      await logAudit({
        userId: opts.userId ?? null,
        action: 'PRICE_SYNC',
        entityType: 'CatalogProduct',
        entityId: 'price-sync',
        changes: { file: opts.fileName, fileHash: parsed.fileHash, ...response.summary },
      });
    } catch (err) {
      console.error('Price sync applied, but writing the audit log failed', err);
    }
  }

  return response;
}
