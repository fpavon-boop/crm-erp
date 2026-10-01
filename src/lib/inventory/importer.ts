import { prisma } from '@/lib/prisma';
import { recalculateProductFinancials } from './profitability';
import type { CatalogCategoryGroup, ShippingMethod } from '@prisma/client';

/**
 * Bulk importer for the whole web catalog — ovens & oven kits, iron doors/
 * accessories/tools, refractory bricks/mortars/blankets, stains &
 * enhancers, and anything else sold (including future CUSTOM categories) —
 * from raw CSV, TSV, or copy-pasted text (e.g. pasted straight from a
 * spreadsheet or PDF table). No product data is hardcoded here: every
 * row's values come from the pasted/uploaded text itself, matched against
 * a flexible header-alias table so minor header spelling differences
 * (case, spacing, "Pcs/Plt" vs "Pcs Per Pallet") don't break the import.
 */

const HEADER_ALIASES: Record<string, string> = {
  'part no': 'partNo',
  partno: 'partNo',
  'part #': 'partNo',
  'part#': 'partNo',
  sku: 'partNo',
  category: 'category',
  'category group': 'categoryGroup',
  categorygroup: 'categoryGroup',
  type: 'categoryGroup',
  'product type': 'categoryGroup',
  producttype: 'categoryGroup',
  product: 'productName',
  'product name': 'productName',
  productname: 'productName',
  name: 'productName',
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
  dimensions: 'dimensions',
  dimension: 'dimensions',
  size: 'dimensions',
  'lead time': 'leadTimeDays',
  'lead time days': 'leadTimeDays',
  leadtimedays: 'leadTimeDays',
  leadtime: 'leadTimeDays',
  cost: 'acquisitionCost',
  'acquisition cost': 'acquisitionCost',
  acquisitioncost: 'acquisitionCost',
  freight: 'freightCost',
  'freight cost': 'freightCost',
  freightcost: 'freightCost',
  'import taxes': 'importTaxesOrFees',
  'import taxes or fees': 'importTaxesOrFees',
  'import fees': 'importTaxesOrFees',
  importtaxesorfees: 'importTaxesOrFees',
  duty: 'importTaxesOrFees',
  'packaging cost': 'packagingCost',
  packagingcost: 'packagingCost',
  packaging: 'packagingCost',
  'shrinkage rate': 'shrinkageLossRate',
  'shrinkage loss rate': 'shrinkageLossRate',
  shrinkagelossrate: 'shrinkageLossRate',
  shrinkage: 'shrinkageLossRate',
  'loss rate': 'shrinkageLossRate',
  'payment processing fee': 'paymentProcessingFeeRate',
  'payment processing fee rate': 'paymentProcessingFeeRate',
  paymentprocessingfeerate: 'paymentProcessingFeeRate',
  'processing fee': 'paymentProcessingFeeRate',
  'shipping method': 'shippingMethod',
  shippingmethod: 'shippingMethod',
  'ship method': 'shippingMethod',
  'freight type': 'shippingMethod',
  freighttype: 'shippingMethod',
  'freight class': 'freightClass',
  freightclass: 'freightClass',
  nmfc: 'freightClass',
  'nmfc class': 'freightClass',
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

const CATEGORY_GROUP_VALUES: CatalogCategoryGroup[] = [
  'OVEN',
  'IRON_DOOR',
  'REFRACTORY',
  'ACCESSORY',
  'TOOL',
  'STAIN_ENHANCER',
  'CUSTOM',
  'OTHER',
];

/** Matches an explicit categoryGroup column value (e.g. "oven", "Oven Kit",
 * "iron-door") against the enum; falls back to keyword inference from the
 * category/product name when no explicit value is given or it doesn't
 * match cleanly — never hardcodes a specific product, just generic
 * category vocabulary. Defaults to OTHER rather than guessing wrong, so
 * any future product line not yet covered by a named group still imports
 * cleanly (use categoryGroup=CUSTOM explicitly for a one-off item). */
function inferCategoryGroup(explicit: string | undefined, category: string | undefined, productName: string): CatalogCategoryGroup {
  const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_+|_+$/g, '');

  if (explicit) {
    const norm = normalize(explicit);
    const direct = CATEGORY_GROUP_VALUES.find((v) => norm === v || norm.includes(v) || v.includes(norm));
    if (direct) return direct;
  }

  const haystack = `${category || ''} ${productName}`.toLowerCase();
  if (/\boven/.test(haystack)) return 'OVEN';
  if (/\biron\s*door|\bdoor\b/.test(haystack)) return 'IRON_DOOR';
  if (/\brefractor|\bbrick|\bmortar|\bblanket|\bcastable/.test(haystack)) return 'REFRACTORY';
  if (/\bstain|\benhancer|\bsealer/.test(haystack)) return 'STAIN_ENHANCER';
  if (/\btool\b/.test(haystack)) return 'TOOL';
  if (/\baccessor/.test(haystack)) return 'ACCESSORY';
  return 'OTHER';
}

/** LTL/heavy-freight items are flagged either by an explicit column or by
 * keywords ("LTL", "freight", "pallet") in that column's text; everything
 * else defaults to standard parcel shipping. */
function inferShippingMethod(explicit: string | undefined): ShippingMethod {
  if (!explicit) return 'PARCEL';
  const norm = explicit.toLowerCase();
  if (/ltl|freight|pallet/.test(norm)) return 'LTL_FREIGHT';
  return 'PARCEL';
}

export interface ParsedCatalogRow {
  partNo?: string;
  category?: string;
  categoryGroup?: string;
  productName: string;
  description?: string;
  pcsPerPallet?: number;
  weightLbs?: number;
  dimensions?: string;
  leadTimeDays?: number;
  acquisitionCost?: number;
  freightCost?: number;
  importTaxesOrFees?: number;
  packagingCost?: number;
  shrinkageLossRate?: number;
  paymentProcessingFeeRate?: number;
  shippingMethod?: string;
  freightClass?: string;
  distributorPrice?: number;
  contractorPrice?: number;
  retailPrice?: number;
  markupDistributor?: number;
  markupContractor?: number;
  markupRetail?: number;
}

export interface ParseResult {
  rows: ParsedCatalogRow[];
  errors: Array<{ line: number; message: string }>;
}

/** Parses raw CSV/TSV/copy-pasted text into rows. Pure — does not touch the
 * database. Exported separately from importCatalogProducts so the parsing
 * logic itself is directly unit-testable without a DB. */
export function parseCatalogText(raw: string): ParseResult {
  const lines = raw.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { rows: [], errors: [{ line: 0, message: 'No data rows found — need a header row plus at least one data row.' }] };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headerCells = splitLine(lines[0], delimiter).map(normalizeHeader);
  const fieldKeys = headerCells.map((h) => HEADER_ALIASES[h]);

  const rows: ParsedCatalogRow[] = [];
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
      categoryGroup: record.categoryGroup || undefined,
      productName,
      description: record.description || undefined,
      pcsPerPallet: parseIntField(record.pcsPerPallet),
      weightLbs: parseNumber(record.weightLbs),
      dimensions: record.dimensions || undefined,
      leadTimeDays: parseIntField(record.leadTimeDays),
      acquisitionCost: parseNumber(record.acquisitionCost),
      freightCost: parseNumber(record.freightCost),
      importTaxesOrFees: parseNumber(record.importTaxesOrFees),
      packagingCost: parseNumber(record.packagingCost),
      shrinkageLossRate: parseNumber(record.shrinkageLossRate),
      paymentProcessingFeeRate: parseNumber(record.paymentProcessingFeeRate),
      shippingMethod: record.shippingMethod || undefined,
      freightClass: record.freightClass || undefined,
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
const DEFAULT_PAYMENT_PROCESSING_FEE_RATE = 2.9;

export interface ImportSummary {
  created: number;
  updated: number;
  errors: Array<{ line: number; message: string }>;
}

/**
 * Parses raw text and upserts each row by partNo, across every category in
 * the catalog. An explicitly-provided distributor/contractor/retail price
 * in the source data is stored as that tier's PRICE OVERRIDE (so it keeps
 * taking precedence on future recalculations, e.g. after a cost change),
 * rather than just being used once for this import. Everything else is
 * computed from acquisitionCost/freight/fees/markup via
 * recalculateProductFinancials — nothing is ever hardcoded here.
 */
export async function importCatalogProducts(rawText: string): Promise<ImportSummary> {
  const { rows, errors } = parseCatalogText(rawText);
  let created = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const partNo = row.partNo || generatePartNo(row.productName, i);
      const acquisitionCost = row.acquisitionCost ?? 0;
      const freightCost = row.freightCost ?? 0;
      const importTaxesOrFees = row.importTaxesOrFees ?? 0;
      const packagingCost = row.packagingCost ?? 0;
      const shrinkageLossRate = row.shrinkageLossRate ?? 0;
      const paymentProcessingFeeRate = row.paymentProcessingFeeRate ?? DEFAULT_PAYMENT_PROCESSING_FEE_RATE;
      const markupDistributor = row.markupDistributor ?? DEFAULT_MARKUPS.distributor;
      const markupContractor = row.markupContractor ?? DEFAULT_MARKUPS.contractor;
      const markupRetail = row.markupRetail ?? DEFAULT_MARKUPS.retail;
      const categoryGroup = inferCategoryGroup(row.categoryGroup, row.category, row.productName);
      const shippingMethod = inferShippingMethod(row.shippingMethod);

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
        distributorPriceOverride: row.distributorPrice,
        contractorPriceOverride: row.contractorPrice,
        retailPriceOverride: row.retailPrice,
      });

      const data = {
        category: row.category,
        categoryGroup,
        productName: row.productName,
        description: row.description,
        pcsPerPallet: row.pcsPerPallet,
        weightLbs: row.weightLbs,
        dimensions: row.dimensions,
        leadTimeDays: row.leadTimeDays,
        acquisitionCost,
        freightCost,
        importTaxesOrFees,
        packagingCost,
        shrinkageLossRate,
        paymentProcessingFeeRate,
        shippingMethod,
        freightClass: row.freightClass,
        markupDistributor,
        markupContractor,
        markupRetail,
        distributorPriceOverride: row.distributorPrice ?? null,
        contractorPriceOverride: row.contractorPrice ?? null,
        retailPriceOverride: row.retailPrice ?? null,
        ...financials,
      };

      const existing = await prisma.catalogProduct.findUnique({ where: { partNo } });
      if (existing) {
        await prisma.catalogProduct.update({ where: { partNo }, data });
        updated++;
      } else {
        await prisma.catalogProduct.create({ data: { partNo, ...data } });
        created++;
      }
    } catch (err) {
      errors.push({ line: i + 2, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { created, updated, errors };
}
