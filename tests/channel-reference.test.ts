import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * docs/SALES_CHANNEL_ARCHITECTURE.md: ChannelReference is a new, additive
 * table — these tests only prove its own CRUD helpers work, not that
 * anything calls them yet (nothing does).
 */
describe('ChannelReference (sales channel abstraction)', () => {
  let db: TestDb;
  let upsertChannelReference: typeof import('../src/lib/channels/reference')['upsertChannelReference'];
  let findChannelReference: typeof import('../src/lib/channels/reference')['findChannelReference'];

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const mod = await import('../src/lib/channels/reference');
    upsertChannelReference = mod.upsertChannelReference;
    findChannelReference = mod.findChannelReference;
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  it('creates a mapping and finds it back by (channel, entityType, entityId)', async () => {
    const product = await db.prisma.product.create({ data: { sku: 'SKU-CH-1', name: 'Widget' } });

    await upsertChannelReference({
      channel: 'AMAZON',
      entityType: 'PRODUCT',
      entityId: product.id,
      externalProductId: 'B000AMZ123',
      externalSku: 'AMZ-SKU-1',
    });

    const found = await findChannelReference('AMAZON', 'PRODUCT', product.id);
    expect(found?.externalProductId).toBe('B000AMZ123');
    expect(found?.externalSku).toBe('AMZ-SKU-1');
  });

  it('upserting the same (channel, entityType, entityId) updates in place rather than duplicating', async () => {
    const product = await db.prisma.product.create({ data: { sku: 'SKU-CH-2', name: 'Gadget' } });

    await upsertChannelReference({
      channel: 'WALMART',
      entityType: 'PRODUCT',
      entityId: product.id,
      externalProductId: 'WM-1',
    });
    await upsertChannelReference({
      channel: 'WALMART',
      entityType: 'PRODUCT',
      entityId: product.id,
      externalProductId: 'WM-2',
    });

    const rows = await db.prisma.channelReference.findMany({
      where: { channel: 'WALMART', entityType: 'PRODUCT', entityId: product.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalProductId).toBe('WM-2');
  });

  it('the same internal record can have independent mappings on different channels', async () => {
    const order = await db.prisma.salesOrder.create({ data: { number: 'SO-CH-1' } });

    await upsertChannelReference({
      channel: 'AMAZON',
      entityType: 'SALES_ORDER',
      entityId: order.id,
      externalOrderId: 'AMZ-ORDER-1',
    });
    await upsertChannelReference({
      channel: 'TIKTOK_SHOP',
      entityType: 'SALES_ORDER',
      entityId: order.id,
      externalOrderId: 'TT-ORDER-1',
    });

    const amazon = await findChannelReference('AMAZON', 'SALES_ORDER', order.id);
    const tiktok = await findChannelReference('TIKTOK_SHOP', 'SALES_ORDER', order.id);
    expect(amazon?.externalOrderId).toBe('AMZ-ORDER-1');
    expect(tiktok?.externalOrderId).toBe('TT-ORDER-1');
  });
});
