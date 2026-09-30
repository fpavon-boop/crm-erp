import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { verifyWebhook } from '@/marketing/security/signing';
import { signedJobRequest } from '@/marketing/scheduling/outbound';

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

  it('video-render normalizes provider output into render.completed and rejects non-https output', async () => {
    const wf = load('video-render.json');
    const [done] = await runCode(wf, 'Build render.completed', { input: [{ json: { url: 'https://cdn.example.com/out.mp4', width: 1080, height: 1920, duration: 15.2, size: 1234 } }] });
    expect(done.json.event).toEqual({ type: 'render.completed', data: { url: 'https://cdn.example.com/out.mp4', mimeType: 'video/mp4', width: 1080, height: 1920, durationSec: 15.2, sizeBytes: 1234 } });
    await expect(runCode(wf, 'Build render.completed', { input: [{ json: { url: 'http://x/out.mp4', width: 1, height: 1, durationSec: 1 } }] })).rejects.toThrow(/https/);
    const renderPkg = { schema: 'marketing.video.render/v1', jobId: 'vr-1' };
    const { json, raw } = crmRequest(renderPkg);
    expect((await runCode(wf, 'Verify CRM signature', { input: [{ json }], binary: raw }))[0].json.ok).toBe(true);
  });

  it('dispatch tick produces a request the CRM dispatch route verifies', async () => {
    const wf = load('dispatch-tick.json');
    const [tick] = await runCode(wf, 'Sign tick', { input: [{ json: {} }], env: { CRM_BASE_URL: 'https://crm.example.com/' } });
    expect(tick.json.url).toBe('https://crm.example.com/api/marketing/webhooks/dispatch');
    expect(verifyWebhook({ rawBody: tick.json.body, secret: IN, timestamp: tick.json.timestamp, signature: tick.json.signature }).ok).toBe(true);
  });
});
