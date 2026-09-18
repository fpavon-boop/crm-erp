import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { recordStockMovement } from '@/lib/automations/stock';
import { z } from 'zod';

const schema = z.object({
  productVariantId: z.string(),
  warehouseId: z.string(),
  type: z.enum(['IN', 'OUT', 'ADJUSTMENT']),
  quantity: z.coerce.number().positive(),
  reason: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  await recordStockMovement({
    ...parsed.data,
    referenceType: 'MANUAL_ADJUSTMENT',
    reason: parsed.data.reason || `Manual ${parsed.data.type.toLowerCase()} by ${session.user.name}`,
  });

  return NextResponse.json({ ok: true });
}
