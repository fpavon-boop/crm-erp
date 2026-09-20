import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { saveUploadedFile } from '@/lib/uploads';
import { ALLOWED_BILL_TYPES, MAX_BILL_FILE_BYTES } from '@/lib/bills';

export const runtime = 'nodejs';

/** Accepts one or more bill files (PDF, photo, sheet). Each becomes a draft entry to review. */
export async function POST(req: NextRequest) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 });

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: 'No files received' }, { status: 400 });

  const kind = form.get('kind') === 'EXPENSE' ? 'EXPENSE' : 'BILL';
  const created: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const file of files) {
    const ext = ALLOWED_BILL_TYPES[file.type];
    if (!ext) {
      skipped.push({ name: file.name, reason: 'File type not supported (use PDF, photo, CSV or Excel)' });
      continue;
    }
    if (file.size > MAX_BILL_FILE_BYTES) {
      skipped.push({ name: file.name, reason: 'File is larger than 15 MB' });
      continue;
    }
    const storedPath = await saveUploadedFile('bills', file.name, Buffer.from(await file.arrayBuffer()));
    const entry = await prisma.billEntry.create({
      data: {
        kind,
        fileName: file.name,
        storedPath,
        mimeType: file.type,
        size: file.size,
        source: 'UPLOAD',
        uploadedById: session.user.id,
      },
    });
    created.push(entry.id);
  }

  if (created.length > 0) {
    await logAudit({
      userId: session.user.id,
      action: 'BILLS_UPLOADED',
      entityType: 'BillEntry',
      entityId: created[0],
      changes: { count: created.length },
    });
  }
  return NextResponse.json({ created: created.length, skipped }, { status: created.length ? 201 : 400 });
}
