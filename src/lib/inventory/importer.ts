import { prisma } from '@/lib/prisma';
import { recalculateRefractoryPricing, computeTrueMargin } from './profitability';

/**
 * Bulk importer for the refractory price-list structure — raw CSV, TSV, or
 * copy-pasted text (e.g. pasted straight from a spreadsheet or PDF table).
 * No product data is hardcoded here: every row's values come from the
 * pasted/uploaded text itself, matched against a flexible header-alias
 * table so minor header spelling differences (case, spacing, "Pcs/Plt" vs
 * "Pcs Per Pallet") don't break the import.
 */

const HEADER_ALIASES: Record<string, string> = {
  'part no': 'partNo',
  partno: 'partNo',
  'part #': 'partNo',
  'part#': 'partNo',
  sku: 'partNo',
  category: 'category',
  product: 'productName',
  'product name': 'productName',
  productname: 'productName',
  description: 'description',
  desc: 'description',
  'pcs/plt': 'pcsPerPallet',
  'pcs per pallet': 'pcsPerPallet',
  pcsplt: 'pcsPerPallet',
  pcsperpallet: 'pcsPerPallet',
  weight: 'weightLbs',
  'weight lbs': 'weightLbs',
  'weight (lbs)': 'weightLbs',
  weightlbs: 'weightLbs',
  cost: 'acquisitionCost',
  'acquisition cost': 'acquisitionCost',
  acquisitioncost: 'acquisitionCost',
  freight: 'freightCost',
  'freight cost': 'freightCost',
  freightcost: 'freightCost',
  distributor: 'distributorPrice',
  'distributor price': 'distributorPrice',
  distributorprice: 'distributorPrice',
  contractor: 'contractorPrice',
  'contractor price': 'contractorPrice',
  contractorprice: 'contractorPrice',
  retail: 'retailPrice',
  'retail price': 'retailPrice',
  retailprice: 'retailPrice',
  'markup dist': 'markupDistributor',
  'markup distributor': 'markupDistributor',
  markupdistributor: 'markupDistributor',
  'markup cont': 'markupContractor',
  'markup contractor': 'markupContractor',
  markupcontractor: 'markupContractor',
  'markup retail': 'markupRetail',
  markupretail: 'markupRetail',
  'margin dist': 'trueMarginDist',
  'true margin dist': 'trueMarginDist',
  margindist: 'trueMarginDist',
  'margin cont': 'trueMarginCont',
  'true margin cont': 'trueMarginCont',
  margincont: 'trueMarginCont',
  'margin retail': 'trueMarginRet',
  'margin ret': 'trueMarginRet',
  'true margin retail': 'trueMarginRet',
  marginret: 'trueMarginRet',
};

type Delimiter = 'tab' | 'comma' | 'whitespace';

function detectDelimiter(headerLine: string): Delimiter {
  if (headerLine.includes('\t')) return 'tab';
  if (headerLine.includes(',')) return 'comma';
  return 'whitespace';
}

/** Minimal RFC4180-style single-line CSV split (handles quoted fields with
 * embedded commas); does not handle quoted fields spanning multiple lines. */
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function splitLine(line: string, delimiter: Delimiter): string[] {
  if (delimiter === 'tab') return line.split('\t');
  if (delimiter === 'comma') return splitCsvLine(line);
  return line.trim().split(/\s{2,}/);
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(/[$,%\s]/g, '').trim();
  if (cleaned === '' || cleaned === '-') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function parseIntField(raw: string | undefined): number | undefined {
  const n = parseNumber(raw);
  return n === undefined ? undefined : Math.round(n);
}

export interface ParsedRefractoryRow {
  partNo?: string;
  category?: string;
  productName: string;
  description?: string;
  pcsPerPallet?: number;
  weightLbs?: number;
  acquisitionCost?: number;
  freightCost?: number;
  distributorPrice?: number;
  contractorPrice?: number;
  retailPrice?: number;
  markupDistributor?: number;
  markupContractor?: number;
  markupRetail?: number;
}

export interface ParseResult {
  rows: ParsedRefractoryRow[];
  errors: Array<{ line: number; message: string }>;
}

/** Parses raw CSV/TSV/copy-pasted text into rows. Pure — does not touch the
 * database. Exported separately from importRefractoryProducts so the
 * parsing logic itself is directly unit-testable without a DB. */
export function parseRefractoryText(raw: string): ParseResult {
  const lines = raw.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { rows: [], errors: [{ line: 0, message: 'No data rows found — need a header row plus at least one data row.' }] };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headerCells = splitLine(lines[0], delimiter).map(normalizeHeader);
  const fieldKeys = headerCells.map((h) => HEADER_ALIASES[h]);

  const rows: ParsedRefractoryRow[] = [];
  const errors: Array<{ line: number; message: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delimiter);
    const record: Record<string, string> = {};
    fieldKeys.forEach((key, idx) => {
      if (key && cells[idx] !== undefined) record[key] = cells[idx].trim();
    });

    const productName = record.productName || record.description;
    if (!productName) {
      errors.push({ line: i + 1, message: 'Missing product name — row skipped.' });
      continue;
    }

    rows.push({
      partNo: record.partNo && record.partNo !== '-' ? record.partNo : undefined,
      category: record.category || undefined,
      productName,
      description: record.description || undefined,
      pcsPerPallet: parseIntField(record.pcsPerPallet),
      weightLbs: parseNumber(record.weightLbs),
      acquisitionCost: parseNumber(record.acquisitionCost),
      freightCost: parseNumber(record.freightCost),
      distributorPrice: parseNumber(record.distributorPrice),
      contractorPrice: parseNumber(record.contractorPrice),
      retailPrice: parseNumber(record.retailPrice),
      markupDistributor: parseNumber(record.markupDistributor),
      markupContractor: parseNumber(record.markupContractor),
      markupRetail: parseNumber(record.markupRetail),
    });
  }

  return { rows, errors };
}

/** Auto-generates a stable-looking part number for a row whose PartNo is
 * missing or '-', from the product name plus a time-based suffix so two
 * rows in the same import batch never collide. */
function generatePartNo(productName: string, index: number): string {
  const base = productName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16);
  return `GEN-${base || 'ITEM'}-${Date.now().toString(36).toUpperCase()}-${index}`;
}

const DEFAULT_MARKUPS = { distributor: 20, contractor: 30, retail: 40 };

export interface ImportSummary {
  created: number;
  updated: number;
  errors: Array<{ line: number; message: string }>;
}

/**
 * Parses raw text and upserts each row by partNo. Explicitly-provided
 * prices/margins in the source data are trusted as-is; anything not given
 * is computed from acquisitionCost/freightCost/markup via
 * recalculateRefractoryPricing — nothing is ever hardcoded here.
 */
export async function importRefractoryProducts(rawText: string): Promise<ImportSummary> {
  const { rows, errors } = parseRefractoryText(rawText);
  let created = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const partNo = row.partNo || generatePartNo(row.productName, i);
      const acquisitionCost = row.acquisitionCost ?? 0;
      const freightCost = row.freightCost ?? 0;
      const markupDistributor = row.markupDistributor ?? DEFAULT_MARKUPS.distributor;
      const markupContractor = row.markupContractor ?? DEFAULT_MARKUPS.contractor;
      const markupRetail = row.markupRetail ?? DEFAULT_MARKUPS.retail;

      const computed = recalculateRefractoryPricing({
        acquisitionCost,
        freightCost,
        markupDistributor,
        markupContractor,
        markupRetail,
      });
      const totalLandedCost = computed.totalLandedCost;
      const distributorPrice = row.distributorPrice ?? computed.distributorPrice;
      const contractorPrice = row.contractorPrice ?? computed.contractorPrice;
      const retailPrice = row.retailPrice ?? computed.retailPrice;
      const trueMarginDist =
        row.distributorPrice !== undefined ? computeTrueMargin(distributorPrice, totalLandedCost) : computed.trueMarginDist;
      const trueMarginCont =
        row.contractorPrice !== undefined ? computeTrueMargin(contractorPrice, totalLandedCost) : computed.trueMarginCont;
      const trueMarginRet =
        row.retailPrice !== undefined ? computeTrueMargin(retailPrice, totalLandedCost) : computed.trueMarginRet;

      const data = {
        category: row.category,
        productName: row.productName,
        description: row.description,
        pcsPerPallet: row.pcsPerPallet,
        weightLbs: row.weightLbs,
        acquisitionCost,
        freightCost,
        totalLandedCost,
        distributorPrice,
        contractorPrice,
        retailPrice,
        markupDistributor,
        markupContractor,
        markupRetail,
        trueMarginDist,
        trueMarginCont,
        trueMarginRet,
      };

      const existing = await prisma.refractoryProduct.findUnique({ where: { partNo } });
      if (existing) {
        await prisma.refractoryProduct.update({ where: { partNo }, data });
        updated++;
      } else {
        await prisma.refractoryProduct.create({ data: { partNo, ...data } });
        created++;
      }
    } catch (err) {
      errors.push({ line: i + 2, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { created, updated, errors };
}
