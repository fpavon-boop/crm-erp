import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiSession } from '@/lib/api-auth';
import { readStoredFile } from '@/lib/uploads';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiSession();
  if (session instanceof NextResponse) return session;

  const doc = await prisma.document.findUnique({ where: { id: params.id } });
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const buffer = await readStoredFile(doc.storedPath);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': doc.mimeType,
      'Content-Disposition': `attachment; filename="${doc.filename}"`,
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiSession();
  if (session instanceof NextResponse) return session;

  await prisma.document.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
