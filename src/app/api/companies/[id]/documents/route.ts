import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { saveUploadedFile } from '@/lib/uploads';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('companies');
  if (session instanceof NextResponse) return session;

  const formData = await req.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const storedPath = await saveUploadedFile(`companies/${params.id}`, file.name, buffer);

  const document = await prisma.document.create({
    data: {
      entityType: 'COMPANY',
      entityId: params.id,
      companyId: params.id,
      filename: file.name,
      storedPath,
      mimeType: file.type || 'application/octet-stream',
      size: buffer.length,
      uploadedById: session.user.id,
    },
  });

  return NextResponse.json({ document }, { status: 201 });
}
