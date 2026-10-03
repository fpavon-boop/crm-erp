import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { parsePriceListWorkbook, runPriceSync } from '@/lib/inventory/price-sync';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;

/** Price-list sync (admin only). Upload the workbook as multipart `file`.
 * Default is a dry run that returns the plan and writes nothing; send
 * `apply=true` plus the `expectedHash` from the dry run to write. `mirrorCore`
 * (default true) also copies retail price/cost onto matching core products. */
export async function POST(req: NextRequest) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!form || !(file instanceof File)) return NextResponse.json({ error: 'An .xlsx file is required' }, { status: 400 });
  if (!file.name.toLowerCase().endsWith('.xlsx')) return NextResponse.json({ error: 'Only .xlsx files are supported' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File is larger than 10MB' }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    return NextResponse.json({ error: 'That is not a valid .xlsx file' }, { status: 400 });
  }

  const apply = form.get('apply') === 'true';
  const mirrorCore = form.get('mirrorCore') !== 'false';

  let parsed;
  try {
    parsed = await parsePriceListWorkbook(buffer);
  } catch (err) {
    console.error('Price list could not be read', err);
    return NextResponse.json({ error: 'Could not read that Excel file' }, { status: 400 });
  }

  if (parsed.errors.length) {
    return NextResponse.json({ ok: false, errors: parsed.errors, warnings: parsed.warnings }, { status: 422 });
  }

  if (apply && form.get('expectedHash') !== parsed.fileHash) {
    return NextResponse.json({ error: 'The file differs from the one that was previewed. Preview it again.' }, { status: 409 });
  }

  try {
    const result = await runPriceSync(parsed, { apply, mirrorCore, fileName: file.name, userId: session.user.id });
    return NextResponse.json(result);
  } catch (err) {
    console.error('Price sync failed', err);
    return NextResponse.json({ error: 'The sync failed and nothing was changed' }, { status: 500 });
  }
}
