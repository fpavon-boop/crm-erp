import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { verifyWebhook } from '@/marketing/security/signing';
import { signedJobRequest } from '@/marketing/scheduling/outbound';
import { startTestDb, type TestDb } from './test-db';

/**
 * Contract tests for the importable n8n workflows in n8n-workflows/: their
 * Code nodes are executed here against the CRM's real signing functions, so
 * the HMAC scheme, headers and payload schemas can't drift apart silently.
 */

const OUT = 'o'.repeat(40);
const IN = 'i'.repeat(40);
const DIR = path.resolve(__dirname, '../n8n-workflows');
const nodeRequire = createRequire(__filename);

interface N8nNode {
  name: string;
  type: string;
  parameters: Record<string, any>;
}
interface N8nWorkflow {
  nodes: N8nNode[];
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

function load(file: string): N8nWorkflow {
  return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
}

type Items = Array<{ json: any; binary?: any }>;

/** Runs a Code node the way n8n does (run-once-for-all-items). */
async function runCode(wf: N8nWorkflow, name: string, ctx: { input: Items; nodes?: Record<string, Items>; env?: Record<string, string>; binary?: Buffer; staticData?: any; executionId?: string }) {
  const node = wf.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`no node ${name}`);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction('$input', '$env', '$', '$execution', '$getWorkflowStaticData', 'require', node.parameters.jsCode);
  const $input = { first: () => ctx.input[0], all: () => ctx.input };
  const $ = (n: string) => {
    const items = ctx.nodes?.[n];
    if (!items) throw new Error(`node ${n} not provided`);
    return { first: () => items[0], all: () => items };
  };
  const helpers = {
    getBinaryDataBuffer: async () => {
      if (!ctx.binary) throw new Error('no binary');
      return ctx.binary;
    },
  };
  const staticData = ctx.staticData ?? {};
  return (await fn.call({ helpers }, $input, { MARKETING_N8N_OUTBOUND_SECRET: OUT, MARKETING_N8N_INBOUND_SECRET: IN, ...(ctx.env ?? {}) }, $, { id: ctx.executionId ?? 'exec-1' }, () => staticData, nodeRequire)) as Items;
}

function crmRequest(body: Record<string, unknown>) {
  const req = signedJobRequest(body, body.jobId as string, `key-${body.jobId}`, OUT, Date.now());
  return { json: { headers: req.headers, body: JSON.parse(req.body) }, raw: Buffer.from(req.body) };
}

/** Evaluates an n8n parameter ("={{ expr }}" or "=text {{ expr }} text") like n8n's expression engine does for these simple cases. */
function evalParam(value: unknown, ctx: { json?: unknown; env?: Record<string, string>; execution?: unknown; $?: unknown }): unknown {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const tpl = value.slice(1);
  const run = (expr: string) => new Function('$json', '$env', '$execution', '$', `return (${expr});`)(ctx.json, ctx.env ?? {}, ctx.execution ?? {}, ctx.$);
  const whole = /^\{\{([\s\S]*)\}\}$/.exec(tpl.trim());
  if (whole && !whole[1].includes('}}')) return run(whole[1]);
  return tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) => String(run(expr)));
}

/** A local stand-in for api.creatomate.com that records what the workflow sends. */
async function mockCreatomate() {
  const http = await import('node:http');
  const requests: Array<{ path: string; headers: Record<string, unknown>; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(data || 'null') });
      const ok = req.method === 'POST' && req.url === '/v1/renders' && req.headers.authorization === 'Bearer ck_test_123';
      res.writeHead(ok ? 202 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? [{ id: 'render-1', status: 'planned' }] : { error: 'unauthorized' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const CREATOMATE_ENV = { CREATOMATE_API_KEY: 'ck_test_123', CREATOMATE_TEMPLATE_ID: 'tmpl_456' };

const renderPkg = {
  schema: 'marketing.video.render/v1',
  jobId: 'vr-1',
  project: { id: 'vp1', title: 'Oven promo', platform: 'TIKTOK' },
  template: { fields: { product_name: 'Pizza Oven 36"', price: '$2,499.00', promo_price: '$2,249.00' } },
  scenes: [{ asset: null }, { asset: { type: 'IMAGE', url: 'https://cdn.example.com/oven.jpg' } }],
};

const socialPkg = {
  schema: 'marketing.social.publish/v1',
  jobId: 'job-1',
  platform: 'INSTAGRAM',
  account: { id: 'a1', externalAccountId: '1784', handle: 'shop', n8nCredentialRef: 'meta' },
  post: { id: 'p1', caption: 'Hello', language: 'EN' },
  media: [{ position: 1, type: 'IMAGE', url: 'https://cdn.example.com/a.jpg' }],
  callback: { url: 'https://crm.example.com/api/marketing/webhooks/n8n', events: ['post.published', 'post.failed'] },
};

describe('n8n workflows', () => {
  it('are well-formed: unique names, every connection targets an existing node, webhook paths match the CRM', () => {
    const paths: string[] = [];
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
      const wf = load(file);
      const names = new Set(wf.nodes.map((n) => n.name));
      expect(names.size).toBe(wf.nodes.length);
      for (const [from, c] of Object.entries(wf.connections)) {
        expect(names.has(from), `${file}: ${from}`).toBe(true);
        for (const out of c.main) for (const e of out) expect(names.has(e.node), `${file}: ${e.node}`).toBe(true);
      }
      for (const n of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook')) paths.push(n.parameters.path);
    }
    // src/marketing/publishing/deps.ts appends exactly these to N8N_MARKETING_WEBHOOK_URL.
    expect(paths.sort()).toEqual(['social-publish', 'video-render']);
  });

  it('social-publish verifies a CRM-signed package and dedupes the idempotency key', async () => {
    const wf = load('social-publish.json');
    const { json, raw } = crmRequest(socialPkg);
    const staticData = {};
    const [ok] = await runCode(wf, 'Verify CRM signature', { input: [{ json }], binary: raw, staticData });
    expect(ok.json).toMatchObject({ ok: true, jobId: 'job-1' });
    const [dup] = await runCode(wf, 'Verify CRM signature', { input: [{ json }], binary: raw, staticData });
    expect(dup.json).toMatchObject({ ok: false, status: 409 });
  });

  it('rejects tampered bodies, wrong secrets, stale timestamps and wrong schemas', async () => {
    const wf = load('social-publish.json');
    const { json, raw } = crmRequest(socialPkg);
    const tampered = Buffer.from(raw.toString().replace('Hello', 'Hacked'));
    expect((await runCode(wf, 'Verify CRM signature', { input: [{ json }], binary: tampered }))[0].json).toMatchObject({ ok: false, status: 401 });
    expect((await runCode(wf, 'Verify CRM signature', { input: [{ json }], binary: raw, env: { MARKETING_N8N_OUTBOUND_SECRET: 'x'.repeat(40) } }))[0].json).toMatchObject({ ok: false, status: 401 });
    const stale = signedJobRequest(socialPkg, 'job-1', 'k', OUT, Date.now() - 10 * 60_000);
    expect((await runCode(wf, 'Verify CRM signature', { input: [{ json: { headers: stale.headers } }], binary: Buffer.from(stale.body) }))[0].json).toMatchObject({ ok: false, reason: 'stale or invalid timestamp' });
    const other = crmRequest({ ...socialPkg, schema: 'marketing.video.render/v1' });
    expect((await runCode(wf, 'Verify CRM signature', { input: [{ json: other.json }], binary: other.raw }))[0].json).toMatchObject({ ok: false, status: 400 });
  });

  it('falls back to the parsed body when Raw Body is off (canonical JSON re-serializes identically)', async () => {
    const wf = load('social-publish.json');
    const { json } = crmRequest(socialPkg);
    expect((await runCode(wf, 'Verify CRM signature', { input: [{ json }] }))[0].json.ok).toBe(true);
  });

  it('routes each platform to the right Graph/TikTok request', async () => {
    const wf = load('social-publish.json');
    const route = async (pkg: any) => (await runCode(wf, 'Route by platform', { input: [{ json: { pkg } }] }))[0].json;
    expect((await route(socialPkg)).request).toEqual({ url: 'https://graph.facebook.com/v21.0/1784/media', body: { image_url: 'https://cdn.example.com/a.jpg', caption: 'Hello' } });
    expect((await route({ ...socialPkg, platform: 'FACEBOOK', media: [] })).request.url).toBe('https://graph.facebook.com/v21.0/1784/feed');
    const tt = await route({ ...socialPkg, platform: 'TIKTOK', media: [{ type: 'VIDEO', url: 'https://cdn.example.com/v.mp4' }] });
    expect(tt.request.body.source_info).toEqual({ source: 'PULL_FROM_URL', video_url: 'https://cdn.example.com/v.mp4' });
    expect((await route({ ...socialPkg, platform: 'TIKTOK' })).unsupported).toMatch(/video/);
  });

  it('signs callbacks the CRM accepts, with a stable eventId and the package job id', async () => {
    const wf = load('social-publish.json');
    const [signed] = await runCode(wf, 'Sign callback', {
      input: [{ json: { event: { type: 'post.published', data: { externalPostId: '99' } } } }],
      nodes: { 'Verify CRM signature': [{ json: { pkg: socialPkg } }] },
      executionId: '42',
    });
    expect(signed.json.url).toBe(socialPkg.callback.url);
    expect(JSON.parse(signed.json.body)).toEqual({ eventId: '42:post.published', type: 'post.published', jobId: 'job-1', data: { externalPostId: '99' } });
    expect(verifyWebhook({ rawBody: signed.json.body, secret: IN, timestamp: signed.json.timestamp, signature: signed.json.signature }).ok).toBe(true);
  });

  it('video-render verifies CRM-signed render payloads', async () => {
    const wf = load('video-render.json');
    const { json, raw } = crmRequest(renderPkg);
    expect((await runCode(wf, 'Verify CRM signature', { input: [{ json }], binary: raw }))[0].json.ok).toBe(true);
  });

  it('video-render maps the CRM render payload onto the Creatomate template elements', async () => {
    const wf = load('video-render.json');
    const nodes = { 'Verify CRM signature': [{ json: { pkg: renderPkg } }] };
    const [mods] = await runCode(wf, 'Creatomate modifications', { input: [{ json: {} }], nodes, env: CREATOMATE_ENV });
    expect(mods.json).toEqual({ title: 'Pizza Oven 36"', price: '$2,249.00', imageUrl: 'https://cdn.example.com/oven.jpg' });

    // Falls back to the project title and the list price.
    const plain = { ...renderPkg, template: { fields: { price: '$2,499.00' } } };
    const [fallback] = await runCode(wf, 'Creatomate modifications', { input: [{ json: {} }], nodes: { 'Verify CRM signature': [{ json: { pkg: plain } }] }, env: CREATOMATE_ENV });
    expect(fallback.json).toMatchObject({ title: 'Oven promo', price: '$2,499.00' });

    const noImage = { ...renderPkg, scenes: [{ asset: { type: 'VIDEO', url: 'https://cdn.example.com/clip.mp4' } }] };
    await expect(runCode(wf, 'Creatomate modifications', { input: [{ json: {} }], nodes: { 'Verify CRM signature': [{ json: { pkg: noImage } }] }, env: CREATOMATE_ENV })).rejects.toThrow(/Product_Image/);
    await expect(runCode(wf, 'Creatomate modifications', { input: [{ json: {} }], nodes })).rejects.toThrow(/CREATOMATE_API_KEY/);
  });

  it('video-render sends Creatomate the exact render request (mock Creatomate server)', async () => {
    const wf = load('video-render.json');
    const node = wf.nodes.find((n) => n.name === 'Creatomate: create render')!;
    const ctx = {
      json: { title: 'Pizza Oven 36"', price: '$2,249.00', imageUrl: 'https://cdn.example.com/oven.jpg' },
      env: CREATOMATE_ENV,
      execution: { id: '77', resumeUrl: 'https://n8n.example.com/webhook-waiting/77' },
    };
    const p = node.parameters;
    expect(p.method).toBe('POST');
    expect(evalParam(p.url, ctx)).toBe('https://api.creatomate.com/v1/renders');
    const headers = Object.fromEntries(p.headerParameters.parameters.map((h: { name: string; value: string }) => [h.name, evalParam(h.value, ctx)]));
    const body = evalParam(p.jsonBody, ctx) as string;

    const mock = await mockCreatomate();
    try {
      const res = await fetch(mock.url + new URL(evalParam(p.url, ctx) as string).pathname, { method: p.method, headers: { ...headers, 'content-type': 'application/json' }, body });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual([{ id: 'render-1', status: 'planned' }]);
    } finally {
      await mock.close();
    }
    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0];
    expect(req.path).toBe('/v1/renders');
    expect(req.headers.authorization).toBe('Bearer ck_test_123');
    expect(req.body).toEqual({
      template_id: 'tmpl_456',
      webhook_url: 'https://n8n.example.com/webhook-waiting/77',
      modifications: { Product_Name: 'Pizza Oven 36"', Price: '$2,249.00', Product_Image: 'https://cdn.example.com/oven.jpg' },
    });
    // A retry would start (and bill) a second render.
    expect((node as { retryOnFail?: boolean }).retryOnFail).not.toBe(true);

    // The result is re-fetched from Creatomate's API with the same auth, by the created render's id.
    const fetchNode = wf.nodes.find((n) => n.name === 'Creatomate: fetch render')!;
    const fetchCtx = { ...ctx, $: (n: string) => ({ first: () => ({ json: n === 'Creatomate: create render' ? { id: 'render-1' } : {} }) }) };
    expect(evalParam(fetchNode.parameters.url, fetchCtx)).toBe('https://api.creatomate.com/v1/renders/render-1');
    expect(evalParam(fetchNode.parameters.headerParameters.parameters[0].value, fetchCtx)).toBe('Bearer ck_test_123');
  });

  it('video-render turns the fetched Creatomate render into render.completed / render.failed', async () => {
    const wf = load('video-render.json');
    const render = { id: 'render-1', status: 'succeeded', url: 'https://f002.backblazeb2.com/out.mp4', output_format: 'mp4', width: 1080, height: 1920, duration: 15.2, file_size: 1234567 };
    const [done] = await runCode(wf, 'Build render.completed', { input: [{ json: render }] });
    expect(done.json.event).toEqual({
      type: 'render.completed',
      data: { url: 'https://f002.backblazeb2.com/out.mp4', mimeType: 'video/mp4', width: 1080, height: 1920, durationSec: 15.2, sizeBytes: 1234567 },
    });
    await expect(runCode(wf, 'Build render.completed', { input: [{ json: { ...render, status: 'failed', error_message: 'Missing element' } }] })).rejects.toThrow('Creatomate render render-1 is failed: Missing element');
    await expect(runCode(wf, 'Build render.completed', { input: [{ json: { ...render, status: 'rendering' } }] })).rejects.toThrow(/is rendering/);
    await expect(runCode(wf, 'Build render.completed', { input: [{ json: { ...render, url: 'http://x/out.mp4' } }] })).rejects.toThrow(/https/);
    const [failed] = await runCode(wf, 'Build render.failed', { input: [{ json: { error: 'Creatomate render render-1 is failed: Missing element' } }] });
    expect(failed.json.event).toEqual({ type: 'render.failed', data: { error: 'Creatomate render render-1 is failed: Missing element' } });
  });

  it('video-render waits for the Creatomate webhook, then trusts only the API result', () => {
    const wf = load('video-render.json');
    const next = (from: string, output = 0) => (wf.connections[from]?.main[output] ?? []).map((e) => e.node);
    expect(next('Send render.started')).toEqual(['Creatomate modifications']);
    expect(next('Creatomate modifications', 1)).toEqual(['Build render.failed']);
    expect(next('Creatomate: create render')).toEqual(['Wait for Creatomate webhook']);
    expect(next('Creatomate: create render', 1)).toEqual(['Build render.failed']);
    expect(next('Wait for Creatomate webhook')).toEqual(['Creatomate: fetch render']);
    expect(next('Creatomate: fetch render')).toEqual(['Build render.completed']);
    expect(next('Creatomate: fetch render', 1)).toEqual(['Build render.failed']);
    const wait = wf.nodes.find((n) => n.name === 'Wait for Creatomate webhook')!;
    expect(wait.parameters).toMatchObject({ resume: 'webhook', httpMethod: 'POST', limitWaitTime: true });
  });

  it('dispatch tick produces a request the CRM dispatch route verifies', async () => {
    const wf = load('dispatch-tick.json');
    const [tick] = await runCode(wf, 'Sign tick', { input: [{ json: {} }], env: { CRM_BASE_URL: 'https://crm.example.com/' } });
    expect(tick.json.url).toBe('https://crm.example.com/api/marketing/webhooks/dispatch');
    expect(verifyWebhook({ rawBody: tick.json.body, secret: IN, timestamp: tick.json.timestamp, signature: tick.json.signature }).ok).toBe(true);
  });
});

describe('sync-metrics workflow → POST /api/marketing/webhooks/metrics (real database)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    // Before any dynamic import: the route's prisma client and secrets are read from env.
    Object.assign(process.env, { DATABASE_URL: db.url, MARKETING_ENABLED: 'true', MARKETING_N8N_INBOUND_SECRET: IN });
  }, 120000);
  afterAll(async () => {
    await db?.stop();
  });

  async function seedPublishedPost(status: 'PUBLISHED' | 'APPROVED' = 'PUBLISHED') {
    const P = db.prisma;
    const campaign = await P.marketingCampaign.create({ data: { name: 'Metrics loop', status: 'PUBLISHED' } });
    const account = await P.socialAccount.create({ data: { platform: 'INSTAGRAM', externalAccountId: 'ig_' + Math.random().toString(36).slice(2) } });
    const post = await P.socialPost.create({ data: { socialAccountId: account.id, campaignId: campaign.id, status, publishedAt: status === 'PUBLISHED' ? new Date() : null } });
    const job = await P.marketingSchedule.create({ data: { jobType: 'SOCIAL_PUBLISH', runAt: new Date(), socialPostId: post.id, campaignId: campaign.id, status: 'COMPLETED' } });
    await P.socialPost.update({ where: { id: post.id }, data: { dispatchJobId: job.id } });
    return { campaign, post, job };
  }

  /** Runs the workflow's own Code nodes: simulated fetch → HMAC signing. */
  async function workflowRequests(postIds: string[]) {
    const wf = load('sync-metrics.json');
    const env = { SIMULATED_POST_IDS: postIds.join(','), CRM_BASE_URL: 'https://crm.example.com' };
    const fetched = await runCode(wf, 'Fetch platform metrics', { input: [{ json: {} }], env });
    return runCode(wf, 'Sign metrics', { input: fetched, env });
  }

  async function deliver(item: { json: any }, override: { body?: string; signature?: string } = {}) {
    const { POST } = await import('../src/app/api/marketing/webhooks/metrics/route');
    const { NextRequest } = await import('next/server');
    const res = await POST(
      new NextRequest('http://localhost/api/marketing/webhooks/metrics', {
        method: 'POST',
        body: override.body ?? item.json.body,
        headers: { 'content-type': 'application/json', 'x-mkt-timestamp': item.json.timestamp, 'x-mkt-signature': override.signature ?? item.json.signature },
      })
    );
    return { status: res.status, body: await res.json() };
  }

  it('accepts a signed payload from the workflow and stores the mapped metrics for the post', async () => {
    const { post, campaign } = await seedPublishedPost();
    const [req] = await workflowRequests([post.id]);
    expect(req.json.url).toBe('https://crm.example.com/api/marketing/webhooks/metrics');
    const sent = JSON.parse(req.json.body);

    const res = await deliver(req);
    expect(res).toMatchObject({ status: 200, body: { ok: true, status: 'PROCESSED', outcome: { applied: true } } });

    const rows = await db.prisma.marketingAnalytics.findMany({ where: { socialPostId: post.id } });
    expect(rows).toHaveLength(1);
    const m = sent.metrics;
    expect(rows[0]).toMatchObject({
      campaignId: campaign.id,
      channel: 'INSTAGRAM',
      impressions: m.impressions,
      reach: m.reach,
      clicks: m.clicks,
      videoViews: m.views,
      engagements: m.likes + m.comments + m.shares + m.saves,
      conversions: 0,
    });
    expect(rows[0].periodStart.toISOString()).toBe(sent.periodStart);
    expect(rows[0].raw).toMatchObject({ source: 'metrics-webhook', breakdown: { likes: m.likes }, platform: { simulated: true } });
    expect(await db.prisma.marketingWebhookEvent.findFirst({ where: { eventId: sent.eventId } })).toMatchObject({ type: 'metrics.snapshot', status: 'PROCESSED' });
  });

  it('dedupes redelivery, and applies a correction for the same period as an update', async () => {
    const { post } = await seedPublishedPost();
    const [req] = await workflowRequests([post.id]);
    await deliver(req);
    expect((await deliver(req)).body).toMatchObject({ duplicate: true });

    // Same period, different numbers → new content hash → new eventId → row updated, not duplicated.
    const corrected = JSON.parse(req.json.body);
    corrected.metrics.clicks += 7;
    corrected.eventId += ':corrected';
    const body = JSON.stringify(corrected);
    const { signWebhook } = await import('../src/marketing/security/signing');
    const signed = signWebhook(body, IN);
    const res = await deliver({ json: { body, ...signed } });
    expect(res.body).toMatchObject({ status: 'PROCESSED', outcome: { applied: true } });
    const rows = await db.prisma.marketingAnalytics.findMany({ where: { socialPostId: post.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].clicks).toBe(corrected.metrics.clicks);
  });

  it('rejects bad signatures, tampered bodies, unknown and unpublished posts without writing', async () => {
    const { post } = await seedPublishedPost('APPROVED');
    const before = await db.prisma.marketingAnalytics.count();
    const [unpublished] = await workflowRequests([post.id]);
    expect(await deliver(unpublished)).toMatchObject({ status: 422 });

    const [unknown] = await workflowRequests(['post_does_not_exist']);
    expect(await deliver(unknown)).toMatchObject({ status: 404 });

    const { post: ok } = await seedPublishedPost();
    const [req] = await workflowRequests([ok.id]);
    expect(await deliver(req, { signature: 'sha256=' + '0'.repeat(64) })).toMatchObject({ status: 401, body: { reason: 'BAD_SIGNATURE' } });
    expect(await deliver(req, { body: req.json.body.replace('"impressions":', '"impressions":1') })).toMatchObject({ status: 401 });
    expect(await db.prisma.marketingAnalytics.count()).toBe(before);
  });
});
