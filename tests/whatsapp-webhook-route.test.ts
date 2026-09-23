import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/** Item 5 (Phase 0), part 2: the webhook route itself must not swallow a
 * genuine internal-processing failure into a silent 200. See
 * docs/SYSTEM_AUDIT.md C3. */
describe('WhatsApp webhook route: internal failures are surfaced, not swallowed', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    process.env.WHATSAPP_FORWARD_SECRET = 'test-forward-secret';
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  it('returns 401 for a request without the correct shared secret (unchanged, still correct)', async () => {
    const { POST } = await import('../src/app/api/whatsapp/webhook/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify({ entry: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 with stored/failed counts for a normal delivery', async () => {
    const { POST } = await import('../src/app/api/whatsapp/webhook/route');
    const { NextRequest } = await import('next/server');
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: '18604310505' },
                messages: [{ id: `wamid.${Math.random()}`, from: '19995554444', type: 'text', text: { body: 'hello' } }],
              },
            },
          ],
        },
      ],
    });
    const req = new NextRequest('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'x-forward-secret': 'test-forward-secret' },
      body,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stored).toBe(1);
    expect(json.failed).toBe(0);
  });

  it('THE FIX: an internal processing failure returns a non-200 (so Meta retries) and is logged, instead of a silent 200', async () => {
    vi.doMock('@/lib/whatsapp/client', () => ({
      handleInboundWebhook: vi.fn().mockRejectedValue(new Error('simulated internal failure')),
    }));
    vi.resetModules();

    const { POST } = await import('../src/app/api/whatsapp/webhook/route');
    const { NextRequest } = await import('next/server');
    const body = JSON.stringify({ entry: [] });
    const req = new NextRequest('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'x-forward-secret': 'test-forward-secret' },
      body,
    });

    const res = await POST(req);
    expect(res.status).toBe(500);

    const logs = await db.prisma.automationLog.findMany({ where: { entityType: 'WHATSAPP_WEBHOOK', success: false } });
    expect(logs.some((l) => l.message?.includes('simulated internal failure'))).toBe(true);

    vi.doUnmock('@/lib/whatsapp/client');
    vi.resetModules();
  });
});
