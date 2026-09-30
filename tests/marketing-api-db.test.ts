import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

vi.mock('next-auth', async () => {
  const actual = await vi.importActual<typeof import('next-auth')>('next-auth');
  return { ...actual, getServerSession: vi.fn() };
});

/**
 * Phase 13: the logged-in /api/marketing/* REST API on a REAL Postgres,
 * with the real guard and services — only the NextAuth session is mocked.
 * Verifies authentication, the role matrix (incl. fresh-DB ADMIN checks for
 * demoted/deactivated admins), the kill switch, input sanitisation, the main
 * flows per area, and that no core ERP table changes.
 */

type Handler = (req: Request, ctx?: { params?: Record<string, string> }) => Promise<Response>;

describe('marketing REST API on a real database', () => {
  let db: TestDb;
  let getServerSession: ReturnType<typeof vi.fn>;
  const users: Record<'admin' | 'sales' | 'demoted' | 'inactive', { id: string; role: string }> = {} as never;
  let routes: Record<string, Record<string, Handler>>;
  let coreBefore: number[];

  const CORE = ['company', 'contact', 'product', 'productVariant', 'stockLevel', 'stockMovement', 'salesOrder', 'salesOrderItem', 'invoice', 'payment', 'document', 'wordPressLead', 'communicationLog', 'auditLog'] as const;
  const coreCounts = () => Promise.all(CORE.map((t) => (db.prisma[t] as unknown as { count: () => Promise<number> }).count()));

  beforeAll(async () => {
    db = await startTestDb();
    Object.assign(process.env, { DATABASE_URL: db.url, MARKETING_ENABLED: 'true' });
    delete process.env.ANTHROPIC_API_KEY;
    getServerSession = vi.mocked((await import('next-auth')).getServerSession) as never;

    const mk = async (email: string, role: string, active = true) => (await db.prisma.user.create({ data: { email, name: email, passwordHash: 'x', role: role as never, active } })).id;
    users.admin = { id: await mk('admin@x.com', 'ADMIN'), role: 'ADMIN' };
    users.sales = { id: await mk('sales@x.com', 'SALES'), role: 'SALES' };
    users.demoted = { id: await mk('demoted@x.com', 'SALES'), role: 'ADMIN' }; // stale JWT still says ADMIN
    users.inactive = { id: await mk('gone@x.com', 'ADMIN', false), role: 'ADMIN' };

    const load = (p: string) => import(`../src/app/api/marketing/${p}/route`) as Promise<Record<string, Handler>>;
    const paths = [
      'campaigns', 'campaigns/[id]', 'campaigns/[id]/transition', 'campaigns/[id]/safeguards',
      'content/[id]', 'content/generate',
      'social-accounts', 'social-accounts/[id]',
      'posts', 'posts/[id]', 'posts/[id]/transition', 'posts/[id]/schedule', 'posts/[id]/retry', 'posts/dispatch',
      'videos', 'videos/[id]', 'videos/[id]/scenes', 'videos/[id]/scenes/[sceneId]', 'videos/[id]/transition', 'videos/[id]/render',
      'audiences', 'audiences/[id]', 'audiences/[id]/preview',
      'analytics/campaigns/[id]', 'analytics/campaigns/[id]/attribution',
    ];
    routes = Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await load(p)] as const)));
    coreBefore = await coreCounts();
  }, 120000);

  afterAll(async () => {
    await db?.stop();
  });

  const as = (who: keyof typeof users | null) =>
    getServerSession.mockResolvedValue(who ? { user: { id: users[who].id, role: users[who].role }, expires: '' } : null);

  async function call(path: string, method: string, opts: { params?: Record<string, string>; body?: unknown; query?: string; raw?: string; headers?: Record<string, string> } = {}) {
    const handler = routes[path][method];
    const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...opts.headers } };
    const bodyAllowed = method !== 'GET' && method !== 'HEAD';
    if (bodyAllowed && opts.raw !== undefined) init.body = opts.raw;
    else if (bodyAllowed && opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await handler(new Request(`http://localhost/api/marketing/${path}${opts.query ? `?${opts.query}` : ''}`, init), { params: opts.params ?? { id: 'x', sceneId: 'y' } });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  // ===========================================================================
  it('every route: 401 without a session, 503 when the kill switch is off', async () => {
    as(null);
    for (const [path, mod] of Object.entries(routes)) {
      for (const method of Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))) {
        expect((await call(path, method, { body: {} })).status, `${method} ${path}`).toBe(401);
      }
    }
    as('admin');
    process.env.MARKETING_ENABLED = 'false';
    for (const [path, mod] of Object.entries(routes)) {
      for (const method of Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))) {
        expect((await call(path, method, { body: {} })).status, `${method} ${path}`).toBe(503);
      }
    }
    process.env.MARKETING_ENABLED = 'true';
  });

  // ===========================================================================
  it('ADMIN-only endpoints refuse SALES and stale/deactivated ADMIN sessions (fresh DB check)', async () => {
    const adminOnly: Array<[string, string, unknown]> = [
      ['social-accounts', 'POST', { platform: 'FACEBOOK', externalAccountId: 'fb1' }],
      ['social-accounts/[id]', 'PATCH', { status: 'REVOKED' }],
      ['posts/[id]/schedule', 'POST', { scheduledFor: new Date().toISOString() }],
      ['posts/[id]/schedule', 'PATCH', { scheduledFor: new Date().toISOString() }],
      ['posts/[id]/schedule', 'DELETE', undefined],
      ['posts/[id]/retry', 'POST', { scheduledFor: new Date().toISOString() }],
      ['posts/dispatch', 'POST', {}],
      ['videos/[id]/render', 'POST', {}],
      ['campaigns/[id]/transition', 'POST', { to: 'APPROVED' }],
      ['posts/[id]/transition', 'POST', { to: 'APPROVED' }],
      ['videos/[id]/transition', 'POST', { to: 'REJECTED', comment: 'no' }],
    ];
    for (const who of ['sales', 'demoted', 'inactive'] as const) {
      as(who);
      for (const [path, method, body] of adminOnly) expect((await call(path, method, { body })).status, `${who} ${method} ${path}`).toBe(403);
    }
    expect(await db.prisma.socialAccount.count()).toBe(0);
  });

  // ===========================================================================
  it('input sanitisation: strict schemas, JSON only, size limit, no token storage', async () => {
    as('admin');
    expect((await call('social-accounts', 'POST', { raw: '{bad' })).status).toBe(400);
    expect((await call('social-accounts', 'POST', { raw: '{}', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await call('social-accounts', 'POST', { raw: JSON.stringify({ x: 'y'.repeat(300_000) }) })).status).toBe(413);
    const withToken = await call('social-accounts', 'POST', { body: { platform: 'INSTAGRAM', externalAccountId: '1784', accessToken: 'EAAB...' } });
    expect(withToken).toMatchObject({ status: 400, json: { code: 'INVALID_INPUT' } });
    expect((await call('social-accounts', 'POST', { body: { platform: 'INSTAGRAM', externalAccountId: '1784', n8nCredentialRef: 'EAAB+abc/def==' } })).status).toBe(400);
    expect((await call('social-accounts', 'POST', { body: { platform: 'MYSPACE', externalAccountId: '1' } })).status).toBe(400);
    expect((await call('campaigns', 'GET', { query: 'page=abc' })).status).toBe(400);
    expect((await call('campaigns/[id]/transition', 'POST', { params: { id: 'nope' }, body: { to: 'DRAFT', hack: true } })).status).toBe(400);
    expect((await call('analytics/campaigns/[id]', 'GET', { params: { id: 'nope' }, query: 'from=not-a-date' })).status).toBe(400);
    expect((await call('campaigns/[id]', 'GET', { params: { id: 'nope' } })).status).toBe(404);
    expect(await db.prisma.socialAccount.count()).toBe(0);
  });

  // ===========================================================================
  it('campaigns: generation gates, CRUD, approvals, safeguards; content edit and generation', async () => {
    // Generation: unknown product → stock/margin safeguard BLOCK (422), before any AI call; nothing saved.
    as('sales');
    const blocked = await call('campaigns', 'POST', { body: { prompt: 'Fall promo', productId: 'missing-product' } });
    expect(blocked).toMatchObject({ status: 422, json: { code: 'SAFEGUARD_BLOCKED' } });
    // No brand profile yet → 412.
    expect((await call('campaigns', 'POST', { body: { prompt: 'Brand awareness' } })).json.code).toBe('BRAND_PROFILE_REQUIRED');
    const { createBrandProfile } = await import('../src/marketing/content/brand-profile');
    const { brandInput } = await import('./marketing-fixtures');
    await createBrandProfile(brandInput, users.admin.id, db.prisma);
    // Brand present, AI not configured → 502, nothing saved.
    expect((await call('campaigns', 'POST', { body: { prompt: 'Brand awareness' } })).status).toBe(502);
    expect(await db.prisma.marketingCampaign.count()).toBe(0);

    const c = await db.prisma.marketingCampaign.create({ data: { name: 'Fall', productIds: [], channels: ['FACEBOOK'] } });
    const content = await db.prisma.marketingContent.create({ data: { campaignId: c.id, channel: 'FACEBOOK', type: 'POST_COPY', language: 'en', body: 'Fall ovens. Prices subject to change.' } });
    const id = { id: c.id };

    expect((await call('campaigns', 'GET', { query: 'search=fall' })).json).toMatchObject({ total: 1 });
    expect((await call('campaigns/[id]', 'PATCH', { params: id, body: { name: 'Fall 2026' } })).json).toMatchObject({ name: 'Fall 2026', status: 'DRAFT' });
    const edited = await call('content/[id]', 'PATCH', { params: { id: content.id }, body: { body: 'Guaranteed best oven.' } });
    expect(edited).toMatchObject({ status: 200, json: { compliance: { verdict: 'BLOCK' } } });
    await call('content/[id]', 'PATCH', { params: { id: content.id }, body: { body: 'Fall ovens. Prices subject to change.' } });

    expect((await call('campaigns/[id]/transition', 'POST', { params: id, body: { to: 'HUMAN_REVIEW' } })).json.status).toBe('HUMAN_REVIEW');
    expect((await call('campaigns/[id]/transition', 'POST', { params: id, body: { to: 'APPROVED' } })).status).toBe(403);
    expect((await call('campaigns/[id]/safeguards', 'GET', { params: id })).json).toMatchObject({ verdict: 'PASS' });

    as('admin');
    expect((await call('campaigns/[id]/transition', 'POST', { params: id, body: { to: 'APPROVED' } })).json).toMatchObject({ status: 'APPROVED', approvedById: users.admin.id });
    expect((await call('campaigns/[id]', 'DELETE', { params: id })).status).toBe(409); // not a fresh draft

    // Content generation preview: AI unavailable → 502; unknown template → 400.
    expect((await call('content/generate', 'POST', { body: { template: 'ctas', input: { objective: 'x', channel: 'EMAIL' }, campaignId: c.id } })).status).toBe(502);
    expect((await call('content/generate', 'POST', { body: { template: 'nope', input: {} } })).status).toBe(400);
  });

  // ===========================================================================
  it('social accounts + posts: register, review, approve, schedule, reschedule, unschedule, dispatch', async () => {
    as('admin');
    const acct = await call('social-accounts', 'POST', { body: { platform: 'FACEBOOK', externalAccountId: `fb_${crypto.randomUUID().slice(0, 8)}`, handle: '@ctbrick', n8nCredentialRef: 'fb-page-main' } });
    expect(acct.status).toBe(201);
    expect((await call('social-accounts', 'POST', { body: { platform: 'FACEBOOK', externalAccountId: acct.json.externalAccountId } })).status).toBe(409);
    expect((await call('social-accounts', 'GET', { query: 'platform=FACEBOOK' })).json).toHaveLength(1);

    const campaign = await db.prisma.marketingCampaign.create({ data: { name: 'Posts', status: 'APPROVED', productIds: [] } });
    as('sales');
    const post = await call('posts', 'POST', { body: { socialAccountId: acct.json.id, campaignId: campaign.id, caption: 'Fall ovens are here.' } });
    expect(post).toMatchObject({ status: 201, json: { status: 'DRAFT' } });
    const pid = { id: post.json.id };
    expect((await call('posts/[id]', 'GET', { params: pid })).json.phase).toBe('DRAFT');
    await call('posts/[id]/transition', 'POST', { params: pid, body: { to: 'REVIEW' } });

    as('admin');
    // Advisory warnings (e.g. missing disclaimer) must be explicitly acknowledged.
    expect((await call('posts/[id]/transition', 'POST', { params: pid, body: { to: 'APPROVED' } })).json.code).toBe('WARNINGS_NOT_ACKNOWLEDGED');
    expect((await call('posts/[id]/transition', 'POST', { params: pid, body: { to: 'APPROVED', acknowledgeWarnings: true } })).json).toMatchObject({ status: 'APPROVED' });
    const at = new Date(Date.now() + 3600_000).toISOString();
    const sched = await call('posts/[id]/schedule', 'POST', { params: pid, body: { scheduledFor: at } });
    expect(sched).toMatchObject({ status: 201, json: { created: true } });
    expect((await call('posts/[id]/schedule', 'POST', { params: pid, body: { scheduledFor: at } })).json.created).toBe(false); // idempotent
    expect((await call('posts/[id]/schedule', 'PATCH', { params: pid, body: { scheduledFor: new Date(Date.now() + 7200_000).toISOString() } })).status).toBe(200);
    expect((await call('posts/[id]/schedule', 'DELETE', { params: pid })).json.status).toBe('APPROVED');
    expect((await call('posts/[id]/retry', 'POST', { params: pid, body: { scheduledFor: at } })).status).toBe(409); // not FAILED
    expect((await call('posts/dispatch', 'POST', { body: {} })).json).toMatchObject({ ran: true, social: [], video: [] });
    expect((await call('social-accounts/[id]', 'PATCH', { params: { id: acct.json.id }, body: { status: 'DISCONNECTED' } })).json.status).toBe('DISCONNECTED');
  });

  // ===========================================================================
  it('videos: project, scenes (add / reorder / move / IDOR guard), review, render gate', async () => {
    const campaign = await db.prisma.marketingCampaign.create({ data: { name: 'Video', status: 'APPROVED', productIds: [] } });
    as('sales');
    const v = await call('videos', 'POST', { body: { campaignId: campaign.id, title: 'Reel', targetDurationSec: 15 } });
    expect(v).toMatchObject({ status: 201, json: { aspectRatio: '9:16' } });
    const vid = { id: v.json.id };
    const s1 = await call('videos/[id]/scenes', 'POST', { params: vid, body: { scene: { durationSec: 5, visualCue: 'Flames', onScreenText: 'Hot' } } });
    const s2 = await call('videos/[id]/scenes', 'POST', { params: vid, body: { scene: { durationSec: 5, visualCue: 'Slice', onScreenText: 'Crispy' }, position: 1 } });
    expect([s1.status, s2.status]).toEqual([201, 201]);
    expect((await call('videos/[id]/scenes', 'PUT', { params: vid, body: { sceneIds: [s1.json.id, s2.json.id] } })).status).toBe(204);
    expect((await call('videos/[id]/scenes/[sceneId]', 'PATCH', { params: { id: v.json.id, sceneId: s1.json.id }, body: { position: 2 } })).status).toBe(204);
    expect((await call('videos/[id]/scenes', 'PUT', { params: vid, body: { sceneIds: [s1.json.id] } })).status).toBe(400); // not a permutation

    const other = await call('videos', 'POST', { body: { campaignId: campaign.id, title: 'Other' } });
    expect((await call('videos/[id]/scenes/[sceneId]', 'DELETE', { params: { id: other.json.id, sceneId: s1.json.id } })).status).toBe(404);

    const got = await call('videos/[id]', 'GET', { params: vid });
    expect(got.json.scenes.map((s: { onScreenText: string }) => s.onScreenText)).toEqual(['Crispy', 'Hot']);
    expect((await call('videos/[id]/transition', 'POST', { params: vid, body: { to: 'REVIEW' } })).json.status).toBe('HUMAN_REVIEW');

    as('admin');
    expect((await call('videos/[id]/render', 'POST', { params: vid, body: {} })).status).toBe(409); // not approved yet
    expect((await call('videos/[id]/transition', 'POST', { params: vid, body: { to: 'APPROVED' } })).json.code).toBe('WARNINGS_NOT_ACKNOWLEDGED');
    expect((await call('videos/[id]/transition', 'POST', { params: vid, body: { to: 'APPROVED', acknowledgeWarnings: true } })).json).toMatchObject({ status: 'APPROVED' });
    expect((await call('videos/[id]/render', 'POST', { params: vid, body: { callbackUrl: 'http://insecure' } })).status).toBe(400);
  });

  // ===========================================================================
  it('audiences (rules + live estimate) and analytics (read-only summaries)', async () => {
    as('sales');
    const aud = await call('audiences', 'POST', { body: { name: 'CT customers', channel: 'EMAIL', criteria: { companyTypes: ['CUSTOMER'] } } });
    expect(aud.status).toBe(201);
    expect((await call('audiences', 'POST', { body: { name: 'x', channel: 'EMAIL', criteria: { memberIds: ['c1'] } } })).status).toBe(400);
    expect((await call('audiences/[id]/preview', 'GET', { params: { id: aud.json.id } })).json).toMatchObject({ channel: 'EMAIL', eligibleCount: 0 });
    expect((await call('audiences/[id]', 'PUT', { params: { id: aud.json.id }, body: { name: 'CT', channel: 'EMAIL', criteria: { states: ['CT'] } } })).status).toBe(200);
    expect((await call('audiences', 'GET')).json.total).toBe(1);

    const campaign = await db.prisma.marketingCampaign.findFirstOrThrow();
    const perf = await call('analytics/campaigns/[id]', 'GET', { params: { id: campaign.id } });
    expect(perf).toMatchObject({ status: 200, json: { campaignId: campaign.id, attribution: { derived: true } } });
    expect((await call('analytics/campaigns/[id]/attribution', 'GET', { params: { id: campaign.id }, query: 'model=LAST_TOUCH_WINDOW&windowDays=7' })).json).toMatchObject({ derived: true, model: 'LAST_TOUCH_WINDOW' });
    expect((await call('analytics/campaigns/[id]/attribution', 'GET', { params: { id: campaign.id }, query: 'windowDays=9999' })).status).toBe(400);
  });

  // ===========================================================================
  it('no core ERP table changed across the whole API run', async () => {
    expect(await coreCounts()).toEqual(coreBefore);
  });
});
