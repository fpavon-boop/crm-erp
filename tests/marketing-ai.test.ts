import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { z, ZodError } from 'zod';
import {
  BaseProviderAdapter,
  CircuitBreaker,
  ResilientAIProvider,
  ProviderError,
  OutputValidationError,
  AllProvidersFailedError,
  extractJson,
  type TextRequest,
  type TextResponse,
} from '@/marketing/ai/provider';
import { AnthropicAdapter } from '@/marketing/ai/anthropic-adapter';
import {
  campaignObjectivesTemplate,
  headlinesTemplate,
  bilingualCopyTemplate,
  storyboardTemplate,
  ctasTemplate,
} from '@/marketing/ai/prompt-templates';
import { runMarketingPrompt, MarketingAiError } from '@/marketing/ai/pipeline';
import type { MarketingAiAuditEntry, MarketingAiAuditSink } from '@/marketing/ai/audit';
import { Redactor } from '@/marketing/security/redaction';
import { makeBrand } from './marketing-fixtures';

/**
 * Marketing Phase 6: provider abstraction, Anthropic adapter, resilience
 * (retry / timeout / circuit breaker / fallback), strict template schemas,
 * and marketing-only audit logging. All LLM traffic is mocked.
 */

const brand = makeBrand();

type Scripted = string | Error | ((req: TextRequest) => Promise<string> | string);

class MockAdapter extends BaseProviderAdapter {
  readonly name: string;
  readonly model: string;
  readonly requests: TextRequest[] = [];
  configured = true;
  constructor(
    private script: Scripted[],
    opts: { name?: string; model?: string } = {}
  ) {
    super();
    this.name = opts.name ?? 'mock';
    this.model = opts.model ?? 'mock-1';
  }
  isConfigured() {
    return this.configured;
  }
  async generateText(req: TextRequest): Promise<TextResponse> {
    this.requests.push(req);
    const next = this.script.shift();
    if (next === undefined) throw new Error('MockAdapter script exhausted');
    if (next instanceof Error) throw next;
    const text = typeof next === 'function' ? await next(req) : next;
    return { text, provider: this.name, model: this.model, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20 }, requestId: 'req_1' };
  }
}

const noSleep = { sleep: async () => undefined, random: () => 0 };
const schema = z.object({ ok: z.literal(true) }).strict();
const req: TextRequest = { system: 'sys', prompt: 'p' };
const rateLimited = () => new ProviderError('RATE_LIMITED', '429', { retryable: true });
const serverErr = () => new ProviderError('SERVER', '500', { retryable: true });

// =============================================================================
describe('structured response parsing', () => {
  it('extracts JSON from fences and prose', () => {
    expect(extractJson('Sure!\n```json\n{"a":[1,{"b":2}]}\n```\nDone.')).toEqual({ a: [1, { b: 2 }] });
    expect(extractJson('[1,2]')).toEqual([1, 2]);
  });

  it('rejects non-JSON', () => {
    expect(() => extractJson('no json here')).toThrow(OutputValidationError);
    expect(() => extractJson('{"a":')).toThrow(OutputValidationError);
  });

  it('adapter generateJSON returns validated data only and rejects truncation', async () => {
    const a = new MockAdapter(['{"ok":true}', '{"ok":false}']);
    expect((await a.generateJSON(req, schema)).data).toEqual({ ok: true });
    await expect(a.generateJSON(req, schema)).rejects.toMatchObject({ name: 'OutputValidationError', issues: ['ok: Invalid literal value, expected true'] });

    class Truncating extends MockAdapter {
      async generateText(r: TextRequest) {
        return { ...(await super.generateText(r)), stopReason: 'max_tokens' };
      }
    }
    await expect(new Truncating(['{"ok":true}']).generateJSON(req, schema)).rejects.toThrow(/truncated/);
  });
});

// =============================================================================
describe('AnthropicAdapter (mocked fetch)', () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, model: process.env.MARKETING_AI_MODEL, fb: process.env.MARKETING_AI_SERVER_FALLBACKS };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-0123456789';
    delete process.env.MARKETING_AI_MODEL;
    delete process.env.MARKETING_AI_SERVER_FALLBACKS;
  });
  afterEach(() => {
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.key], ['MARKETING_AI_MODEL', saved.model], ['MARKETING_AI_SERVER_FALLBACKS', saved.fb]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const ok = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'request-id': 'req_abc', ...headers } });

  it('sends a correct Messages API request and reads text blocks after thinking/fallback blocks', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }],
        usage: { input_tokens: 123, output_tokens: 45 },
      })
    );
    const a = new AnthropicAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await a.generateJSON({ system: 'S', prompt: 'P', effort: 'low' }, schema);

    expect(res).toMatchObject({ data: { ok: true }, model: 'claude-opus-5', usage: { inputTokens: 123, outputTokens: 45 }, requestId: 'req_abc' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test-key-0123456789');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 16000,
      messages: [{ role: 'user', content: 'P' }],
      output_config: { effort: 'low' },
      fallbacks: 'default',
    });
    expect(body.system).toMatch(/^S\n\nRespond with a single JSON value only/);
    expect(body.temperature).toBeUndefined();
  });

  it('omits server fallbacks for other models or when disabled; omits effort for Haiku', async () => {
    const fetchImpl = vi.fn(async () => ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] }));
    await new AnthropicAdapter({ model: 'claude-haiku-4-5', fetchImpl: fetchImpl as never }).generateText(req);
    process.env.MARKETING_AI_SERVER_FALLBACKS = 'false';
    await new AnthropicAdapter({ fetchImpl: fetchImpl as never }).generateText(req);
    for (const call of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) {
      const body = JSON.parse(call[1].body as string);
      expect(body.fallbacks).toBeUndefined();
      expect((call[1].headers as Record<string, string>)['anthropic-beta']).toBeUndefined();
    }
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).output_config).toBeUndefined();
  });

  it('maps HTTP statuses to retryable / non-retryable errors and honours retry-after', async () => {
    const cases: Array<[number, string, boolean]> = [
      [429, 'RATE_LIMITED', true],
      [529, 'OVERLOADED', true],
      [500, 'SERVER', true],
      [503, 'SERVER', true],
      [408, 'TIMEOUT', true],
      [400, 'CLIENT', false],
      [401, 'AUTH', false],
      [404, 'CLIENT', false],
    ];
    for (const [status, kind, retryable] of cases) {
      const fetchImpl = async () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: 'nope' } }), {
          status,
          headers: { 'retry-after': '7', 'request-id': 'req_err' },
        });
      const err = await new AnthropicAdapter({ fetchImpl: fetchImpl as never }).generateText(req).catch((e) => e);
      expect(err, String(status)).toMatchObject({ kind, retryable, status, requestId: 'req_err' });
      if (status === 429) expect(err.retryAfterMs).toBe(7000);
      expect(err.message).not.toContain('sk-ant-test-key');
    }
  });

  it('treats refusal as a non-retryable error, checked before content', async () => {
    const fetchImpl = async () => ok({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [{ type: 'text', text: '{"ok":true}' }] });
    await expect(new AnthropicAdapter({ fetchImpl: fetchImpl as never }).generateText(req)).rejects.toMatchObject({
      kind: 'REFUSAL',
      retryable: false,
    });
  });

  it('missing key → NOT_CONFIGURED without any network call; network error → retryable NETWORK', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchImpl = vi.fn();
    const a = new AnthropicAdapter({ fetchImpl: fetchImpl as never });
    expect(a.isConfigured()).toBe(false);
    await expect(a.generateText(req)).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();

    process.env.ANTHROPIC_API_KEY = 'k';
    const failing = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(new AnthropicAdapter({ fetchImpl: failing as never }).generateText(req)).rejects.toMatchObject({ kind: 'NETWORK', retryable: true });
  });
});

// =============================================================================
describe('ResilientAIProvider', () => {
  it('retries retryable errors with backoff, then succeeds', async () => {
    const sleeps: number[] = [];
    const a = new MockAdapter([rateLimited(), serverErr(), '{"ok":true}']);
    const p = new ResilientAIProvider([a], { ...noSleep, sleep: async (ms) => void sleeps.push(ms), baseDelayMs: 100 });
    const res = await p.generateJSON(req, schema);
    expect(res.data).toEqual({ ok: true });
    expect(res.attempts.map((x) => x.outcome)).toEqual(['RATE_LIMITED', 'SERVER', 'SUCCESS']);
    expect(sleeps).toEqual([50, 100]); // 100*2^0*0.5, 100*2^1*0.5 with random()=0
    expect(res.fallbackUsed).toBe(false);
  });

  it('uses retry-after when provided', async () => {
    const sleeps: number[] = [];
    const a = new MockAdapter([new ProviderError('RATE_LIMITED', '429', { retryable: true, retryAfterMs: 4000 }), '{"ok":true}']);
    await new ResilientAIProvider([a], { ...noSleep, sleep: async (ms) => void sleeps.push(ms) }).generateJSON(req, schema);
    expect(sleeps).toEqual([4000]);
  });

  it('non-retryable errors skip straight to the fallback provider', async () => {
    const primary = new MockAdapter([new ProviderError('CLIENT', '400')], { name: 'a', model: 'm1' });
    const fallback = new MockAdapter(['{"ok":true}'], { name: 'a', model: 'm2' });
    const res = await new ResilientAIProvider([primary, fallback], noSleep).generateJSON(req, schema);
    expect(primary.requests).toHaveLength(1);
    expect(res).toMatchObject({ model: 'm2', fallbackUsed: true });
  });

  it('falls back after exhausting retries, and skips unconfigured providers', async () => {
    const off = new MockAdapter([], { model: 'off' });
    off.configured = false;
    const primary = new MockAdapter([serverErr(), serverErr(), serverErr()], { model: 'm1' });
    const fallback = new MockAdapter(['{"ok":true}'], { model: 'm2' });
    const res = await new ResilientAIProvider([off, primary, fallback], noSleep).generateJSON(req, schema);
    expect(res.attempts.map((x) => `${x.model}:${x.outcome}`)).toEqual([
      'off:SKIPPED_NOT_CONFIGURED',
      'm1:SERVER',
      'm1:SERVER',
      'm1:SERVER',
      'm2:SUCCESS',
    ]);
  });

  it('re-asks once with validation feedback, then gives up on that provider', async () => {
    const a = new MockAdapter(['{"ok":false}', '{"ok":true}']);
    const res = await new ResilientAIProvider([a], noSleep).generateJSON(req, schema);
    expect(res.data).toEqual({ ok: true });
    expect(a.requests[1].prompt).toContain('Your previous reply was rejected');
    expect(a.requests[1].prompt).toContain('ok: Invalid literal value');

    const bad = new MockAdapter(['nope', '{"ok":"yes"}', '{"ok":true}']);
    const err = await new ResilientAIProvider([bad], noSleep).generateJSON(req, schema).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect(err.lastError).toBeInstanceOf(OutputValidationError);
    expect(bad.requests).toHaveLength(2);
  });

  it('never returns schema-invalid data, even if every provider replies', async () => {
    const a = new MockAdapter(['{"ok":1}', '{"ok":2}']);
    const b = new MockAdapter(['{"ok":3}', '{"ok":4}']);
    await expect(new ResilientAIProvider([a, b], noSleep).generateJSON(req, schema)).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it('enforces a per-attempt timeout even if the adapter ignores the signal', async () => {
    const hang = () => new Promise<string>(() => undefined);
    const a = new MockAdapter([hang, '{"ok":true}']);
    const res = await new ResilientAIProvider([a], { ...noSleep, timeoutMs: 20 }).generateJSON(req, schema);
    expect(res.attempts.map((x) => x.outcome)).toEqual(['TIMEOUT', 'SUCCESS']);
    expect(a.requests[0].signal?.aborted).toBe(true);
  });

  it('stops immediately when the caller cancels', async () => {
    const controller = new AbortController();
    const a = new MockAdapter([
      () => {
        controller.abort();
        throw new ProviderError('TIMEOUT', 'aborted', { retryable: true });
      },
      '{"ok":true}',
    ]);
    const err = await new ResilientAIProvider([a], noSleep).generateJSON({ ...req, signal: controller.signal }, schema).catch((e) => e);
    expect(err.lastError).toMatchObject({ kind: 'CANCELLED' });
    expect(a.requests).toHaveLength(1);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, half-opens after cooldown with one trial, closes on success', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => t });
    for (let i = 0; i < 3; i++) {
      expect(b.tryAcquire()).toBe(true);
      b.recordFailure();
    }
    expect(b.getState()).toBe('OPEN');
    expect(b.tryAcquire()).toBe(false);
    t = 1000;
    expect(b.tryAcquire()).toBe(true); // the one half-open trial
    expect(b.tryAcquire()).toBe(false);
    b.recordSuccess();
    expect(b.getState()).toBe('CLOSED');
  });

  it('a failed half-open trial re-opens immediately', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => t });
    b.recordFailure();
    t = 1000;
    expect(b.tryAcquire()).toBe(true);
    b.recordFailure();
    expect(b.getState()).toBe('OPEN');
  });

  it('in the provider: an open circuit skips the primary; validation errors do not trip it', async () => {
    const primary = new MockAdapter([serverErr(), serverErr(), '{"ok":1}', '{"ok":2}'], { model: 'm1' });
    const fallback = new MockAdapter(['{"ok":true}', '{"ok":true}', '{"ok":true}'], { model: 'm2' });
    const p = new ResilientAIProvider([primary, fallback], { ...noSleep, maxAttempts: 2, breaker: { failureThreshold: 2, cooldownMs: 60_000 } });

    await p.generateJSON(req, schema); // m1 fails twice → OPEN, m2 serves
    expect(p.circuitState(0)).toBe('OPEN');
    const second = await p.generateJSON(req, schema);
    expect(second.attempts[0]).toMatchObject({ model: 'm1', outcome: 'CIRCUIT_OPEN' });
    expect(primary.requests).toHaveLength(2);

    const p2 = new ResilientAIProvider([new MockAdapter(['{"ok":1}', '{"ok":2}']), new MockAdapter(['{"ok":true}'])], {
      ...noSleep,
      breaker: { failureThreshold: 1 },
    });
    await p2.generateJSON(req, schema);
    expect(p2.circuitState(0)).toBe('CLOSED');
  });
});

// =============================================================================
describe('prompt template schemas', () => {
  it('campaign objectives: strict shape, enum metric, bounded count', () => {
    const good = { objectives: [{ title: 'Grow', description: 'd', kpi: { metric: 'leads', target: 50, unit: 'leads' }, timeframeDays: 30 }] };
    expect(campaignObjectivesTemplate.outputSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      { objectives: [] },
      { objectives: [{ ...good.objectives[0], kpi: { metric: 'vibes', target: 1, unit: '' } }] },
      { objectives: [{ ...good.objectives[0], kpi: { ...good.objectives[0].kpi, target: -5 } }] },
      { ...good, extra: 1 },
    ]) {
      expect(campaignObjectivesTemplate.outputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('headlines: EN/ES counts must match and length is capped', () => {
    const h = (language: 'EN' | 'ES', text = 'Fire up fall') => ({ language, text, angle: 'seasonal' });
    expect(headlinesTemplate.outputSchema.safeParse({ headlines: [h('EN'), h('ES')] }).success).toBe(true);
    expect(headlinesTemplate.outputSchema.safeParse({ headlines: [h('EN'), h('EN')] }).success).toBe(false);
    expect(headlinesTemplate.outputSchema.safeParse({ headlines: [h('EN', 'x'.repeat(101)), h('ES')] }).success).toBe(false);
  });

  it('storyboard: scenes numbered 1..n and durations sum to the total', () => {
    const scene = (order: number, durationSec = 5) => ({
      order,
      durationSec,
      visual: 'Oven door opens',
      onScreenText: { en: 'Hot', es: 'Caliente' },
      voiceover: null,
      productSku: null,
    });
    const ok = { title: 't', aspectRatio: '9:16', totalDurationSec: 15, scenes: [scene(1), scene(2), scene(3)] };
    expect(storyboardTemplate.outputSchema.safeParse(ok).success).toBe(true);
    expect(storyboardTemplate.outputSchema.safeParse({ ...ok, scenes: [scene(1), scene(3), scene(2)] }).success).toBe(false);
    expect(storyboardTemplate.outputSchema.safeParse({ ...ok, totalDurationSec: 30 }).success).toBe(false);
    expect(storyboardTemplate.outputSchema.safeParse({ ...ok, scenes: [{ ...scene(1), onScreenText: { en: 'x' } }, scene(2), scene(3)] }).success).toBe(false);
  });

  it('ctas: 40-char limit per language and known intents', () => {
    expect(ctasTemplate.outputSchema.safeParse({ ctas: [{ intent: 'buy', en: 'Shop', es: 'Compra' }, { intent: 'book', en: 'Book', es: 'Reserva' }] }).success).toBe(true);
    expect(ctasTemplate.outputSchema.safeParse({ ctas: [{ intent: 'buy', en: 'x'.repeat(41), es: 'y' }, { intent: 'buy', en: 'a', es: 'b' }] }).success).toBe(false);
    expect(ctasTemplate.outputSchema.safeParse({ ctas: [{ intent: 'spam', en: 'a', es: 'b' }, { intent: 'buy', en: 'a', es: 'b' }] }).success).toBe(false);
  });

  it('every template builds a prompt with brand context, the output shape, and redacted brief', () => {
    const facts = [{ name: 'Tuscan Oven', sku: 'TUS-48', listPrice: 2499, highlights: ['Owner email bob@example.com'] }];
    const inputs = {
      campaign_objectives: { campaignName: 'Fall', businessGoal: 'Sell ovens', channels: ['INSTAGRAM'], durationDays: 30, productFacts: facts },
      headlines: { objective: 'Fall promo', channel: 'INSTAGRAM', productFacts: facts },
      bilingual_copy: { objective: 'Fall promo', channel: 'INSTAGRAM', contentType: 'CAPTION', productFacts: facts },
      video_storyboard: { objective: 'Fall promo', channel: 'TIKTOK', targetDurationSec: 20, productFacts: facts },
      ctas: { objective: 'Fall promo', channel: 'EMAIL', productFacts: facts },
    };
    const templates = [campaignObjectivesTemplate, headlinesTemplate, bilingualCopyTemplate, storyboardTemplate, ctasTemplate];
    for (const t of templates) {
      const parsed = t.inputSchema.parse(inputs[t.key as keyof typeof inputs]);
      const r = t.build(parsed as never, brand, new Redactor());
      expect(r.prompt, t.key).toContain('Artesano experto');
      expect(r.prompt, t.key).toMatch(/<output_shape>|output_shape/);
      expect(r.prompt, t.key).not.toContain('bob@example.com');
      expect(r.prompt, t.key).toContain('TUS-48');
    }
  });
});

// =============================================================================
describe('runMarketingPrompt pipeline + marketing audit log', () => {
  function sink() {
    const entries: MarketingAiAuditEntry[] = [];
    const s: MarketingAiAuditSink = { record: async (e) => (entries.push(e), `log_${entries.length}`) };
    return { s, entries };
  }

  const copyInput = {
    objective: 'Fall promo. Ask for maria@example.com',
    channel: 'INSTAGRAM',
    contentType: 'CAPTION',
    approvedDiscountPct: 15,
    productFacts: [{ name: 'Tuscan Oven', sku: 'TUS-48', listPrice: 2499 }],
  };
  const goodCopy = {
    en: { headline: 'Fall pizza season', body: 'Our brick oven, now 15% off. Prices subject to change.', cta: 'Shop now', hashtags: ['#BrickOven'] },
    es: { headline: 'Temporada de pizza', body: 'Horno de ladrillo con 15% de descuento. Precios sujetos a cambios.', cta: 'Compra ya', hashtags: ['#Horno'] },
  };

  it('returns validated data + compliance review + meta, and logs SUCCESS with no prompt/PII', async () => {
    const { s, entries } = sink();
    const adapter = new MockAdapter([JSON.stringify(goodCopy)]);
    const res = await runMarketingPrompt(bilingualCopyTemplate, copyInput, {
      brand,
      requestedById: 'u1',
      campaignId: 'c1',
      provider: new ResilientAIProvider([adapter], noSleep),
      audit: s,
    });
    expect(res.status).toBe('AI_GENERATED');
    expect(res.data.es.cta).toBe('Compra ya');
    expect(res.compliance).toEqual({ verdict: 'PASS', findings: [] });
    expect(res.meta).toMatchObject({ templateKey: 'bilingual_copy', templateVersion: 1, provider: 'mock', attempts: [{ outcome: 'SUCCESS' }], logId: 'log_1' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'SUCCESS',
      templateKey: 'bilingual_copy',
      campaignId: 'c1',
      requestedById: 'u1',
      inputTokens: 10,
      outputTokens: 20,
      complianceVerdict: 'PASS',
      redactions: { EMAIL: 1 },
    });
    expect(entries[0].promptHash).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain('maria@example.com');
    expect(serialized).not.toContain('Fall pizza season');
    // and the provider never saw the email either
    expect(adapter.requests[0].prompt).not.toContain('maria@example.com');
  });

  it('surfaces compliance findings without altering the output', async () => {
    const risky = { ...goodCopy, en: { ...goodCopy.en, body: 'Guaranteed best oven, 30% off. Prices subject to change.' } };
    const res = await runMarketingPrompt(bilingualCopyTemplate, copyInput, {
      brand,
      provider: new ResilientAIProvider([new MockAdapter([JSON.stringify(risky)])], noSleep),
      audit: sink().s,
    });
    expect(res.data.en.body).toBe(risky.en.body);
    expect(res.compliance!.verdict).toBe('BLOCK');
    const codes = res.compliance!.findings.flatMap((f) => f.issues.map((i) => i.code));
    expect(codes).toEqual(expect.arrayContaining(['COMPLIANCE_CLAIM', 'DISCOUNT_EXCEEDS_APPROVED', 'DISCOUNT_MISMATCH']));
  });

  it('logs VALIDATION_FAILED and throws when output never validates', async () => {
    const { s, entries } = sink();
    const err = await runMarketingPrompt(bilingualCopyTemplate, copyInput, {
      brand,
      provider: new ResilientAIProvider([new MockAdapter(['{"en":{}}', 'not json'])], noSleep),
      audit: s,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MarketingAiError);
    expect(err).toMatchObject({ kind: 'VALIDATION', logId: 'log_1' });
    expect(entries[0]).toMatchObject({ status: 'VALIDATION_FAILED', attempts: 2, errorKind: 'VALIDATION' });
  });

  it('logs FAILED with the provider error kind', async () => {
    const { s, entries } = sink();
    await expect(
      runMarketingPrompt(ctasTemplate, { objective: 'x', channel: 'EMAIL' }, {
        brand,
        provider: new ResilientAIProvider([new MockAdapter([new ProviderError('AUTH', '401 invalid x-api-key')])], noSleep),
        audit: s,
      })
    ).rejects.toMatchObject({ kind: 'AUTH' });
    expect(entries[0]).toMatchObject({ status: 'FAILED', errorKind: 'AUTH', attempts: 1 });
  });

  it('invalid input fails fast: no model call, no log', async () => {
    const { s, entries } = sink();
    const adapter = new MockAdapter([]);
    await expect(
      runMarketingPrompt(storyboardTemplate, { objective: 'x', channel: 'EMAIL', targetDurationSec: 2 }, {
        brand,
        provider: new ResilientAIProvider([adapter], noSleep),
        audit: s,
      })
    ).rejects.toBeInstanceOf(ZodError);
    expect(adapter.requests).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it('a failing audit sink never breaks the call', async () => {
    const res = await runMarketingPrompt(ctasTemplate, { objective: 'x', channel: 'EMAIL' }, {
      brand,
      provider: new ResilientAIProvider(
        [new MockAdapter([JSON.stringify({ ctas: [{ intent: 'buy', en: 'Shop', es: 'Compra' }, { intent: 'contact', en: 'Call us', es: 'Llámanos' }] })])],
        noSleep
      ),
      audit: { record: async () => null },
    });
    expect(res.meta.logId).toBeNull();
  });
});

// =============================================================================
describe('isolation', () => {
  it('marketing AI code never writes core tables or touches the core AI client', () => {
    const dir = path.resolve(__dirname, '../src/marketing/ai');
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const writes = [...src.matchAll(/prisma\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => m[1]);
      expect(writes.every((model) => model.startsWith('marketing')), `${file}: ${writes}`).toBe(true);
      expect(src, file).not.toMatch(/aiGenerationLog|auditLog|logAiGeneration|logAudit/);
      expect(src, file).not.toMatch(/from '@\/lib\/ai\/(client|service|audit)'/);
    }
  });
});
