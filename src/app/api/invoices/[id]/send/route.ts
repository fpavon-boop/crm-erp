import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { sendInvoiceByEmail } from '@/lib/automations/notifications';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('invoicing');
  if (session instanceof NextResponse) return session;

  const result = await sendInvoiceByEmail(params.id);
  if (result.sent) {
    await prisma.invoice.update({
      where: { id: params.id },
      data: { status: 'SENT' },
    });
  }
  return NextResponse.json(result);
}
