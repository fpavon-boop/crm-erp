import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';

vi.mock('@/marketing/security/guard', () => ({ requireMarketingAction: vi.fn() }));

import { requireMarketingAction } from '@/marketing/security/guard';
import { marketingRoute, actionForTarget, MAX_BODY_BYTES } from '@/marketing/http/route';
import { MarketingError } from '@/marketing/errors';
import { CampaignError } from '@/marketing/campaigns/errors';
import { MarketingAiError } from '@/marketing/ai/pipeline';

/** Phase 13: the shared route wrapper (guard wiring, body parsing, error → status). */

const guard = vi.mocked(requireMarketingAction);
beforeEach(() => {
  guard.mockReset();
  guard.mockResolvedValue({ userId: 'u1', role: 'ADMIN' });
});

const req = (body?: string, headers: Record<string, string> = { 'content-type': 'application/json' }, method = 'POST') =>
  new Request('http://localhost/api/marketing/x?page=2', { method, body, headers });

describe('marketingRoute', () => {
  it('passes actor, parsed body, query and params to the handler', async () => {
    const h = vi.fn(async (ctx: { actor: unknown; body: unknown; query: unknown; params: unknown }) => ctx);
    const res = await marketingRoute<{ id: string }>('draft', h as never)(req('{"a":1}'), { params: { id: 'p1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ actor: { userId: 'u1' }, body: { a: 1 }, query: { page: '2' }, params: { id: 'p1' } });
    expect(guard).toHaveBeenCalledWith('draft');
  });

  it('returns the guard response untouched (401/403/503) and never runs the handler', async () => {
    guard.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    const h = vi.fn();
    expect((await marketingRoute('approve', h)(req('{}'))).status).toBe(403);
    expect(h).not.toHaveBeenCalled();
  });

  it('resolves the action from the body for transitions', async () => {
    await marketingRoute((b) => actionForTarget(b), async () => ({}))(req('{"to":"APPROVED"}'));
    expect(guard).toHaveBeenLastCalledWith('approve');
    expect(actionForTarget({ to: 'SCHEDULED' })).toBe('schedule');
    expect(actionForTarget({ to: 'HUMAN_REVIEW' })).toBe('submit_for_review');
    expect(actionForTarget({ to: 'bogus' })).toBe('draft');
    expect(actionForTarget(null)).toBe('draft');
  });

  it('rejects bad bodies: invalid JSON 400, wrong content type 415, oversized 413', async () => {
    const r = marketingRoute('draft', async () => ({}));
    expect((await r(req('{nope'))).status).toBe(400);
    expect((await r(req('{}', { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await r(req('x'.repeat(MAX_BODY_BYTES + 1)))).status).toBe(413);
    expect(guard).not.toHaveBeenCalled(); // rejected before auth work
  });

  it('maps errors to status codes without leaking internals', async () => {
    const run = (err: unknown) => marketingRoute('view', async () => { throw err; })(req(undefined, {}, 'GET'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const zod = (() => { try { z.object({ a: z.string() }).parse({}); } catch (e) { return e; } })();
    expect((await run(zod)).status).toBe(400);
    expect((await run(new MarketingError('NOT_FOUND', 'Asset x not found', 404))).status).toBe(404);
    expect((await run(new CampaignError('SAFEGUARD_BLOCKED', 'blocked', 422))).status).toBe(422);
    expect((await run(new MarketingAiError('failed', 'TIMEOUT', [], 'log1'))).status).toBe(502);
    expect((await run(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: '5' }))).status).toBe(404);
    expect((await run(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: '5' }))).status).toBe(409);
    const boom = await run(new Error('password=hunter2 at db.internal:5432'));
    expect(boom.status).toBe(500);
    expect(await boom.text()).not.toContain('hunter2');
    spy.mockRestore();
  });

  it('204 for handlers returning nothing; custom success status', async () => {
    expect((await marketingRoute('draft', async () => undefined)(req('{}'))).status).toBe(204);
    expect((await marketingRoute('draft', async () => ({ id: 1 }), { status: 201 })(req('{}'))).status).toBe(201);
  });
});
