import { afterEach, describe, expect, it, vi } from 'vitest';
import { callMarketingApi, localInputToIso } from '@/marketing/ui/client-api';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('marketing UI client api', () => {
  it('sends JSON and returns data on success', async () => {
    const fn = mockFetch(201, { campaignId: 'c1' });
    const res = await callMarketingApi<{ campaignId: string }>('POST', '/api/marketing/campaigns', { prompt: 'x' });
    expect(res).toEqual({ ok: true, data: { campaignId: 'c1' } });
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"prompt":"x"}');
  });

  it('flattens Zod details into one readable message', async () => {
    mockFetch(400, { error: 'Invalid input', details: { formErrors: ['bad'], fieldErrors: { prompt: ['Required'] } } });
    const res = await callMarketingApi('POST', '/x', {});
    expect(res).toEqual({ ok: false, status: 400, error: 'Invalid input — bad; prompt: Required' });
  });

  it('handles 204 and non-JSON error bodies', async () => {
    mockFetch(204, undefined);
    expect(await callMarketingApi('DELETE', '/x')).toEqual({ ok: true, data: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })));
    expect(await callMarketingApi('GET', '/x')).toEqual({ ok: false, status: 502, error: 'Request failed (502)' });
  });

  it('reports network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await callMarketingApi('GET', '/x')).toMatchObject({ ok: false, status: 0 });
  });

  it('converts datetime-local values', () => {
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('garbage')).toBeNull();
    expect(localInputToIso('2026-10-01T09:30')).toBe(new Date('2026-10-01T09:30').toISOString());
  });
});
