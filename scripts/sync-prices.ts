/**
 * Price-list sync CLI.
 *
 *   npm run sync-prices -- [file.xlsx] [--apply] [--no-mirror] [--parse-only]
 *
 * Default is a DRY RUN: it prints what would change and writes nothing. Add
 * --apply to write. --parse-only validates the file without touching the
 * database at all. The file defaults to ./CTBOS-Complete-Price-List.xlsx.
 * Writes go to whatever DATABASE_URL points at (see docs/PRICE_SYNC.md).
 */
import fs from 'fs';
import path from 'path';
import { parsePriceListWorkbook, runPriceSync } from '@/lib/inventory/price-sync';
import { prisma } from '@/lib/prisma';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const fileArg = args.find((a) => !a.startsWith('--')) ?? 'CTBOS-Complete-Price-List.xlsx';
const apply = flags.has('--apply');
const mirrorCore = !flags.has('--no-mirror');
const parseOnly = flags.has('--parse-only');

function line(label: string, value: string | number) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

async function main() {
  const filePath = path.resolve(fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const parsed = await parsePriceListWorkbook(fs.readFileSync(filePath));
  console.log(`\nFile: ${filePath}`);

  if (parsed.errors.length) {
    console.error(`\n${parsed.errors.length} ERROR(S) — nothing will be synced:`);
    for (const e of parsed.errors) console.error(`  ${e.row ? `row ${e.row}` : 'file'}${e.partNo ? ` [${e.partNo}]` : ''}: ${e.message}`);
    process.exit(1);
  }

  const groups: Record<string, number> = {};
  parsed.rows.forEach((r) => (groups[r.categoryGroup] = (groups[r.categoryGroup] || 0) + 1));
  console.log('\nParsed OK');
  line('Products in "Price List"', parsed.rows.length);
  line('Category groups', Object.entries(groups).map(([k, v]) => `${k}:${v}`).join('  '));
  line('Estimated costs (retail ÷ markup)', parsed.rows.filter((r) => r.costIsEstimated).length);
  line('Fixed retail prices', parsed.rows.filter((r) => r.retailPriceOverride !== null).length);
  line('LTL freight (pallet or ≥150 lb)', parsed.rows.filter((r) => r.shippingMethod === 'LTL_FREIGHT').length);
  line('With Woo dimensions', parsed.rows.filter((r) => r.dimensions !== null).length);
  line('Warnings', parsed.warnings.length);
  line('Woo products not in Price List', parsed.wooOnly.length);

  if (parseOnly) {
    printWarnings(parsed.warnings);
    return;
  }

  const res = await runPriceSync(parsed, { apply, mirrorCore, fileName: path.basename(filePath) });
  const s = res.summary;
  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN (nothing written)'}`);
  line('New products', s.create);
  line('Changed products', s.update);
  line('Unchanged', s.unchanged);
  line('In database but not in file', `${s.missingInFile} (left untouched)`);
  line(`Mirror to core Product (${s.mirrorEnabled ? 'on' : 'off'})`, s.mirrorEnabled ? `${s.mirrorUpdates} updates, ${s.mirrorNoMatch} SKUs without a core product` : '—');

  if (res.created.length) {
    console.log('\nNew:');
    res.created.slice(0, 20).forEach((c) => console.log(`  + ${c.partNo}  ${c.name}  cost ${c.cost}${c.estimated ? '*' : ''}  retail ${c.retail}`));
    if (res.created.length > 20) console.log(`  … and ${res.created.length - 20} more`);
  }
  if (res.changed.length) {
    console.log('\nChanged:');
    res.changed.slice(0, 40).forEach((c) => console.log(`  ~ ${c.partNo}  ${c.diffs.map((d) => `${d.field} ${d.from} → ${d.to}`).join('; ')}`));
    if (res.changed.length > 40) console.log(`  … and ${res.changed.length - 40} more`);
  }
  printWarnings(res.warnings);
  if (!apply) console.log('\nRe-run with --apply to write these changes.');
}

function printWarnings(warnings: { row?: number; partNo?: string; message: string }[]) {
  if (!warnings.length) return;
  console.log(`\nWarnings (${warnings.length}):`);
  warnings.slice(0, 30).forEach((w) => console.log(`  ! ${w.partNo ?? ''}${w.row ? ` (row ${w.row})` : ''} ${w.message}`));
  if (warnings.length > 30) console.log(`  … and ${warnings.length - 30} more`);
}

main()
  .catch((err) => {
    console.error('\nSync failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
