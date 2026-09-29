import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { signToken, verifyToken } from '@/marketing/security/tokens';
import { unsubscribeUrl, verifyUnsubscribeToken, UNSUBSCRIBE_TOKEN_MAX_AGE_MS } from '@/marketing/audiences/unsubscribe';
import { emailFooter } from '@/marketing/audiences/messaging';
import { isOptOutMessage } from '@/marketing/audiences/consent';
import { config } from '@/middleware';

/** Email compliance: signed one-click unsubscribe, CAN-SPAM footer, and the
 * middleware exemption for public marketing endpoints. The DB-backed flow
 * (route → CRM timeline → consent) is in tests/marketing-db.test.ts. */

const ENV = ['MARKETING_UNSUBSCRIBE_SECRET', 'MARKETING_PUBLIC_BASE_URL'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MARKETING_UNSUBSCRIBE_SECRET = 'u'.repeat(40);
  process.env.MARKETING_PUBLIC_BASE_URL = 'https://crm.example.com/';
});
afterEach(() => {
  for (const k of ENV) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});

describe('signed tokens', () => {
  it('round-trip and reject tampering, wrong secret, and junk', () => {
    const t = signToken({ a: 1 }, 's'.repeat(32));
    expect(verifyToken(t, 's'.repeat(32))).toEqual({ a: 1 });
    expect(verifyToken(t, 'x'.repeat(32))).toBeNull();
    expect(verifyToken(t.replace(/^./, (c) => (c === 'e' ? 'f' : 'e')), 's'.repeat(32))).toBeNull();
    for (const junk of ['', 'abc', 'a.b.c', 'x'.repeat(3000)]) expect(verifyToken(junk, 's'.repeat(32))).toBeNull();
  });
});

describe('unsubscribe links', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const tokenOf = (url: string) => decodeURIComponent(new URL(url).searchParams.get('t')!);

  it('builds an https link on the public route and verifies it', () => {
    const url = unsubscribeUrl({ contactId: 'c1', channel: 'EMAIL', campaignId: 'cmp1' }, now)!;
    expect(url).toMatch(/^https:\/\/crm\.example\.com\/api\/marketing\/public\/unsubscribe\?t=/);
    expect(verifyUnsubscribeToken(tokenOf(url), now)).toMatchObject({ contactId: 'c1', channel: 'EMAIL', campaignId: 'cmp1' });
  });

  it('stays valid for a year (CAN-SPAM needs ≥30 days), then expires', () => {
    const t = tokenOf(unsubscribeUrl({ contactId: 'c1', channel: 'EMAIL', campaignId: null }, now)!);
    expect(verifyUnsubscribeToken(t, new Date(now.getTime() + 31 * 86_400_000))).not.toBeNull();
    expect(verifyUnsubscribeToken(t, new Date(now.getTime() + UNSUBSCRIBE_TOKEN_MAX_AGE_MS + 1000))).toBeNull();
  });

  it('is not produced when secret or https base URL is missing (email is then refused)', () => {
    process.env.MARKETING_UNSUBSCRIBE_SECRET = 'short';
    expect(unsubscribeUrl({ contactId: 'c1', channel: 'EMAIL', campaignId: null })).toBeNull();
    process.env.MARKETING_UNSUBSCRIBE_SECRET = 'u'.repeat(40);
    process.env.MARKETING_PUBLIC_BASE_URL = 'http://crm.example.com';
    expect(unsubscribeUrl({ contactId: 'c1', channel: 'EMAIL', campaignId: null })).toBeNull();
  });

  it('tokens signed with another secret are rejected', () => {
    const forged = signToken({ v: 1, contactId: 'c1', channel: 'EMAIL', campaignId: null, iat: now.getTime() }, 'z'.repeat(40));
    expect(verifyUnsubscribeToken(forged, now)).toBeNull();
  });
});

describe('email footer', () => {
  it('carries brand, postal address, one-click link and reply option (EN/ES)', () => {
    const en = emailFooter('en', 'CT Brick Oven Supply', '123 Main St, Hartford, CT 06103', 'https://x/u?t=1');
    expect(en.split('\n')).toEqual([
      'CT Brick Oven Supply · 123 Main St, Hartford, CT 06103',
      'You are receiving this because you opted in on our website.',
      'Unsubscribe: https://x/u?t=1',
      'Or reply STOP.',
    ]);
    expect(emailFooter('es', 'B', 'Addr 12345 X', 'https://x')).toContain('Darse de baja: https://x');
  });

  it('the timeline entry written by the unsubscribe route counts as an opt-out', () => {
    expect(isOptOutMessage({ subject: 'Marketing unsubscribe', body: 'UNSUBSCRIBE — contact used the one-click marketing unsubscribe link' })).toBe(true);
  });
});

describe('middleware exemption', () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  it('exempts only the public marketing prefixes; everything else stays behind login', () => {
    for (const p of ['/api/marketing/webhooks/n8n', '/api/marketing/webhooks/dispatch', '/api/marketing/public/unsubscribe', '/api/marketing/public/media/a1']) {
      expect(matcher.test(p), p).toBe(false); // not matched = no session required
    }
    for (const p of ['/api/marketing/campaigns', '/api/marketing/webhooksX', '/api/marketing/publicity', '/api/invoices', '/dashboard']) {
      expect(matcher.test(p), p).toBe(true);
    }
  });

  it('is a single-line change to the existing matcher', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/middleware.ts'), 'utf8');
    expect(src.match(/api\/marketing\//g)).toHaveLength(2);
  });
});
