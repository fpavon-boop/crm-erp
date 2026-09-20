import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { readStoredFile } from '@/lib/uploads';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('finance');
  if (session instanceof NextResponse) return session;

  const entry = await prisma.billEntry.findUnique({ where: { id: params.id } });
  if (!entry?.storedPath) return NextResponse.json({ error: 'No file' }, { status: 404 });

  let data: Buffer;
  try {
    data = await readStoredFile(entry.storedPath);
  } catch {
    return NextResponse.json({ error: 'File not found on the server' }, { status: 404 });
  }

  const name = (entry.fileName || 'bill').replace(/[^a-zA-Z0-9._-]/g, '_');
  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': entry.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
