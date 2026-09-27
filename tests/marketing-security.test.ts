import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('next-auth', async () => {
  const actual = await vi.importActual<typeof import('next-auth')>('next-auth');
  return { ...actual, getServerSession: vi.fn() };
});
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: vi.fn() } } }));

import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  encryptVaultSecret,
  decryptVaultSecret,
  needsRotation,
  rotateSecret,
  isVaultConfigured,
  VaultDecryptError,
  VaultNotConfiguredError,
} from '@/marketing/security/vault';
import { signWebhook, verifyWebhook } from '@/marketing/security/signing';
import { canPerform, authorizeTransition, MARKETING_ACTIONS, ADMIN_ONLY_ACTIONS } from '@/marketing/security/rbac';
import { requireMarketingAction, requireMarketingTransition } from '@/marketing/security/guard';
import { Redactor, redactText } from '@/marketing/security/redaction';

/**
 * Phase 3 (Marketing security): pure unit tests — no database. The guard
 * tests mock the session and the single read-only User lookup.
 */

const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('base64');
const ENV_KEYS = [
  'MARKETING_VAULT_KEY',
  'MARKETING_VAULT_KEY_ID',
  'MARKETING_VAULT_PREVIOUS_KEYS',
  'MARKETING_ENABLED',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.MARKETING_VAULT_KEY = KEY_A;
  process.env.MARKETING_VAULT_KEY_ID = 'k1';
  delete process.env.MARKETING_VAULT_PREVIOUS_KEYS;
  process.env.MARKETING_ENABLED = 'true';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.mocked(getServerSession).mockReset();
  vi.mocked(prisma.user.findUnique).mockReset();
});

describe('vault', () => {
  it('round-trips and never emits plaintext', () => {
    const payload = encryptVaultSecret('super-secret-token', 'n8n:outbound');
    expect(payload.startsWith('mv1.k1.')).toBe(true);
    expect(payload).not.toContain('super-secret-token');
    expect(decryptVaultSecret(payload, 'n8n:outbound')).toBe('super-secret-token');
  });

  it('uses a fresh IV per encryption', () => {
    expect(encryptVaultSecret('x', 'c')).not.toBe(encryptVaultSecret('x', 'c'));
  });

  it('rejects a payload used under a different context (AAD binding)', () => {
    const payload = encryptVaultSecret('token', 'social-account:1');
    expect(() => decryptVaultSecret(payload, 'social-account:2')).toThrow(VaultDecryptError);
  });

  it('rejects tampered ciphertext', () => {
    const parts = encryptVaultSecret('token', 'c').split('.');
    const data = Buffer.from(parts[4], 'base64url');
    data[0] ^= 0xff;
    parts[4] = data.toString('base64url');
    expect(() => decryptVaultSecret(parts.join('.'), 'c')).toThrow(VaultDecryptError);
  });

  it('fails closed without a key, with a weak key, and requires a context', () => {
    delete process.env.MARKETING_VAULT_KEY;
    expect(isVaultConfigured()).toBe(false);
    expect(() => encryptVaultSecret('x', 'c')).toThrow(VaultNotConfiguredError);
    process.env.MARKETING_VAULT_KEY = 'correct horse battery staple';
    expect(() => encryptVaultSecret('x', 'c')).toThrow(VaultNotConfiguredError);
    process.env.MARKETING_VAULT_KEY = KEY_A;
    expect(() => encryptVaultSecret('x', '')).toThrow();
  });

  it('supports key rotation via previous keys', () => {
    const old = encryptVaultSecret('rotate-me', 'c');
    process.env.MARKETING_VAULT_KEY = KEY_B;
    process.env.MARKETING_VAULT_KEY_ID = 'k2';
    expect(() => decryptVaultSecret(old, 'c')).toThrow(VaultDecryptError);

    process.env.MARKETING_VAULT_PREVIOUS_KEYS = `k1:${KEY_A}`;
    expect(decryptVaultSecret(old, 'c')).toBe('rotate-me');
    expect(needsRotation(old)).toBe(true);
    const rotated = rotateSecret(old, 'c');
    expect(rotated.startsWith('mv1.k2.')).toBe(true);
    expect(needsRotation(rotated)).toBe(false);
    expect(decryptVaultSecret(rotated, 'c')).toBe('rotate-me');
  });
});

describe('webhook signing', () => {
  const secret = 'x'.repeat(40);
  const body = JSON.stringify({ jobId: 'j1' });

  it('verifies a valid signature', () => {
    const now = Date.now();
    const { timestamp, signature } = signWebhook(body, secret, now);
    expect(verifyWebhook({ rawBody: body, secret, timestamp, signature, nowMs: now })).toEqual({ ok: true });
  });

  it('rejects modified body, wrong secret, stale timestamp, missing headers', () => {
    const now = Date.now();
    const { timestamp, signature } = signWebhook(body, secret, now);
    expect(verifyWebhook({ rawBody: body + ' ', secret, timestamp, signature, nowMs: now }).ok).toBe(false);
    expect(verifyWebhook({ rawBody: body, secret: 'y'.repeat(40), timestamp, signature, nowMs: now }).ok).toBe(false);
    expect(verifyWebhook({ rawBody: body, secret, timestamp, signature, nowMs: now + 301_000 })).toEqual({
      ok: false,
      reason: 'STALE',
    });
    expect(verifyWebhook({ rawBody: body, secret, timestamp: null, signature, nowMs: now }).ok).toBe(false);
  });

  it('refuses short signing secrets', () => {
    expect(() => signWebhook(body, 'short')).toThrow();
  });
});

describe('RBAC policy', () => {
  it('ADMIN can do everything; other roles only view/draft/submit', () => {
    for (const action of MARKETING_ACTIONS) {
      expect(canPerform('ADMIN', action)).toBe(true);
      for (const role of ['SALES', 'OPERATIONS', 'ACCOUNTING']) {
        expect(canPerform(role, action)).toBe(!ADMIN_ONLY_ACTIONS.has(action));
      }
    }
  });

  it('unknown or missing roles get nothing', () => {
    expect(canPerform('SUPERUSER', 'view')).toBe(false);
    expect(canPerform(undefined, 'view')).toBe(false);
  });

  it('non-admins cannot approve, schedule, or publish', () => {
    expect(authorizeTransition('SALES', 'HUMAN_REVIEW', 'APPROVED')).toMatchObject({ ok: false, reason: 'FORBIDDEN' });
    expect(authorizeTransition('SALES', 'APPROVED', 'SCHEDULED')).toMatchObject({ ok: false, reason: 'FORBIDDEN' });
    expect(authorizeTransition('SALES', 'APPROVED', 'PUBLISHED')).toMatchObject({ ok: false, reason: 'FORBIDDEN' });
    expect(authorizeTransition('SALES', 'DRAFT', 'HUMAN_REVIEW')).toMatchObject({ ok: true });
  });

  it('AI output can never skip human review, even for ADMIN', () => {
    for (const to of ['APPROVED', 'SCHEDULED', 'PUBLISHED'] as const) {
      expect(authorizeTransition('ADMIN', 'AI_GENERATED', to)).toMatchObject({ ok: false, reason: 'INVALID_TRANSITION' });
    }
    expect(authorizeTransition('ADMIN', 'DRAFT', 'AI_GENERATED')).toMatchObject({ ok: false });
    expect(authorizeTransition('ADMIN', 'PUBLISHED', 'DRAFT')).toMatchObject({ ok: false });
  });
});

describe('requireMarketingAction guard', () => {
  const session = (role: string) => ({ user: { id: 'u1', role }, expires: '' });

  it('returns 503 when the module is disabled', async () => {
    process.env.MARKETING_ENABLED = 'false';
    const res = await requireMarketingAction('view');
    expect(res).toBeInstanceOf(NextResponse);
    expect((res as NextResponse).status).toBe(503);
  });

  it('returns 401 without a session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    expect(((await requireMarketingAction('view')) as NextResponse).status).toBe(401);
  });

  it('lets a SALES user draft without a DB lookup, but not publish', async () => {
    vi.mocked(getServerSession).mockResolvedValue(session('SALES'));
    expect(await requireMarketingAction('draft')).toEqual({ userId: 'u1', role: 'SALES' });
    expect(((await requireMarketingAction('publish')) as NextResponse).status).toBe(403);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('re-checks ADMIN role and active flag in the DB for admin-only actions', async () => {
    vi.mocked(getServerSession).mockResolvedValue(session('ADMIN'));

    vi.mocked(prisma.user.findUnique).mockResolvedValue({ role: 'ADMIN', active: true } as never);
    expect(await requireMarketingAction('approve')).toEqual({ userId: 'u1', role: 'ADMIN' });

    vi.mocked(prisma.user.findUnique).mockResolvedValue({ role: 'SALES', active: true } as never);
    expect(((await requireMarketingAction('approve')) as NextResponse).status).toBe(403);

    vi.mocked(prisma.user.findUnique).mockResolvedValue({ role: 'ADMIN', active: false } as never);
    expect(((await requireMarketingAction('publish')) as NextResponse).status).toBe(403);
  });

  it('transition guard: 409 for impossible edges, 403 for forbidden ones', async () => {
    vi.mocked(getServerSession).mockResolvedValue(session('SALES'));
    expect(((await requireMarketingTransition('AI_GENERATED', 'PUBLISHED')) as NextResponse).status).toBe(409);
    expect(((await requireMarketingTransition('HUMAN_REVIEW', 'APPROVED')) as NextResponse).status).toBe(403);
    expect(await requireMarketingTransition('DRAFT', 'HUMAN_REVIEW')).toMatchObject({ action: 'submit_for_review' });
  });
});

describe('redaction', () => {
  it('redacts emails, phones, cards, SSNs, IBANs, IPs, and secrets', () => {
    const input = [
      'Email jane.doe@example.com or call +1 (555) 123-4567 / 15551234567.',
      'Card 4111 1111 1111 1111, SSN 123-45-6789, IBAN GB82 WEST 1234 5698 7654 32.',
      'Server 192.168.1.20, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz, Bearer abcdefghijklmnopqrstuvwxyz123456',
    ].join('\n');
    const out = redactText(input);
    for (const leaked of [
      'jane.doe@example.com',
      '555',
      '4111',
      '123-45-6789',
      'GB82',
      '192.168.1.20',
      'sk-ant',
      'abcdefghijklmnopqrstuvwxyz123456',
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('[EMAIL_1]');
    expect(out).toContain('[CARD_1]');
  });

  it('leaves business data intact: prices, SKUs, dates, quantities, non-Luhn numbers', () => {
    const input = 'SKU OVEN-48-PRO costs $2,499.00, 12 in stock, promo 2026-10-01 to 2026-10-15, order 10482.';
    expect(redactText(input)).toBe(input);
  });

  it('uses stable placeholders and restores locally', () => {
    const r = new Redactor({ knownValues: [{ value: 'Maria Lopez', label: 'customer_name' }] });
    const out = r.redact('Hi Maria Lopez (maria@x.io). maria@x.io again, MARIA LOPEZ.');
    expect(out).toBe('Hi [CUSTOMER_NAME_1] ([EMAIL_1]). [EMAIL_1] again, [CUSTOMER_NAME_1].');
    expect(r.restore('Dear [CUSTOMER_NAME_1], thanks!')).toBe('Dear Maria Lopez, thanks!');
    expect(r.summary()).toEqual({ CUSTOMER_NAME: 1, EMAIL: 1 });
  });

  it('drops credential-looking keys when redacting objects', () => {
    const r = new Redactor();
    const out = r.redactValue({
      product: { name: 'Pizza Oven', price: 1999 },
      contact: { email: 'a@b.co', apiKey: 'anything', nested: [{ accessToken: 'x' }] },
      password: 'hunter2',
    });
    expect(out).toEqual({
      product: { name: 'Pizza Oven', price: 1999 },
      contact: { email: '[EMAIL_1]', apiKey: '[REDACTED]', nested: [{ accessToken: '[REDACTED]' }] },
      password: '[REDACTED]',
    });
  });
});

describe('isolation', () => {
  it('src/marketing/security performs no writes to any table', () => {
    const dir = path.resolve(__dirname, '../src/marketing/security');
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(src, file).not.toMatch(/prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
      expect(src, file).not.toMatch(/\$executeRaw|\$queryRaw/);
    }
  });
});
