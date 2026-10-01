import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { importCatalogProducts } from '@/lib/inventory/importer';
import { z } from 'zod';

const schema = z.object({ text: z.string().min(1) });

/** Accepts raw CSV/TSV/copy-pasted text for the whole catalog — ovens, iron
 * doors, refractory materials, accessories, tools, stains/enhancers — and
 * bulk-upserts CatalogProduct rows by partNo. Also accepts a raw text/csv
 * body directly (no JSON wrapper) for convenience. */
export async function POST(req: NextRequest) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const contentType = req.headers.get('content-type') || '';
  let text: string;
  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    text = parsed.data.text;
  } else {
    text = await req.text();
    if (!text.trim()) return NextResponse.json({ error: 'Request body is empty' }, { status: 400 });
  }

  const result = await importCatalogProducts(text);
  return NextResponse.json(result);
}
