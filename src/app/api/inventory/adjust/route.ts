import { NextRequest, NextResponse } from 'next/server';
import { requireApiModule } from '@/lib/api-auth';
import { recordStockMovement } from '@/lib/automations/stock';
import { claimIdempotencyKey } from '@/lib/automations/idempotency';
import { z } from 'zod';

const schema = z.object({
  productVariantId: z.string(),
  warehouseId: z.string(),
  type: z.enum(['IN', 'OUT', 'ADJUSTMENT']),
  quantity: z.coerce.number().positive(),
  reason: z.string().optional(),
  // Phase 13: a client-generated key — unlike the WooCommerce sync's
  // delta-based stock updates (already idempotent by construction), a
  // manual adjustment is a plain "add/remove N units" command with no
  // natural idempotency, so a double-click would otherwise post the
  // movement twice.
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export async function POST(req: NextRequest) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { idempotencyKey, ...data } = parsed.data;

  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(idempotencyKey, 'inventory_adjust');
    if (!claim.claimed) return NextResponse.json({ ok: true, duplicate: true });
  }

  await recordStockMovement({
    ...data,
    referenceType: 'MANUAL_ADJUSTMENT',
    reason: data.reason || `Manual ${data.type.toLowerCase()} by ${session.user.name}`,
  });

  return NextResponse.json({ ok: true });
}
