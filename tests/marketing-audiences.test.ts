import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decideConsent, isOptOutMessage, type ConsentLead, type TimelineInbound } from '@/marketing/audiences/consent';
import { audienceCriteriaSchema, compileContactWhere } from '@/marketing/audiences/rules';

/**
 * Consent is derived from the CRM (latest WordPressLead + CommunicationLog
 * opt-outs), never stored by marketing. Pure-logic tests; the end-to-end CRM
 * path is covered in tests/marketing-db.test.ts.
 */

const now = new Date('2026-09-28T12:00:00Z');
const h = (n: number) => new Date(now.getTime() - n * 3600_000);
const contact = { id: 'c1', email: 'a@example.com', phone: null, mobile: '+18605550100' };
const lead = (consentGiven: boolean, at: Date): ConsentLead => ({ contactId: 'c1', consentGiven, submittedAt: at });
const msg = (type: string, body: string, at: Date): TimelineInbound => ({ contactId: 'c1', type, subject: null, body, occurredAt: at });

describe('consent from the CRM', () => {
  it('requires a consenting latest lead (fail closed)', () => {
    expect(decideConsent(contact, 'EMAIL', [], [], now)).toEqual({ eligible: false, reason: 'NO_CONSENT_RECORD' });
    expect(decideConsent(contact, 'EMAIL', [lead(false, h(5))], [], now)).toEqual({ eligible: false, reason: 'CONSENT_NOT_GIVEN' });
    expect(decideConsent(contact, 'EMAIL', [lead(true, h(50)), lead(false, h(5))], [], now)).toMatchObject({ reason: 'CONSENT_NOT_GIVEN' });
    expect(decideConsent(contact, 'EMAIL', [lead(false, h(50)), lead(true, h(5))], [], now)).toEqual({ eligible: true, address: 'a@example.com', consentAt: h(5) });
  });

  it('honors opt-outs on the timeline after consent, on any channel, in EN or ES', () => {
    for (const body of ['STOP', 'please unsubscribe me', 'Baja', 'quiero darme de baja', 'opt-out']) {
      expect(decideConsent(contact, 'EMAIL', [lead(true, h(50))], [msg('WHATSAPP', body, h(10))], now), body).toMatchObject({ reason: 'OPTED_OUT' });
    }
    // An opt-out BEFORE a newer consent no longer applies.
    expect(decideConsent(contact, 'EMAIL', [lead(true, h(5))], [msg('EMAIL', 'STOP', h(10))], now).eligible).toBe(true);
    expect(isOptOutMessage({ subject: null, body: 'Can I stop by the showroom?' })).toBe(true); // conservative: excluded
    expect(isOptOutMessage({ subject: null, body: 'Is the oven in stock?' })).toBe(false);
  });

  it('WhatsApp needs an address and an inbound message within 24h', () => {
    const ok = [lead(true, h(50))];
    expect(decideConsent(contact, 'WHATSAPP', ok, [msg('WHATSAPP', 'Hi', h(3))], now)).toEqual({ eligible: true, address: '+18605550100', consentAt: h(50) });
    expect(decideConsent(contact, 'WHATSAPP', ok, [msg('WHATSAPP', 'Hi', h(30))], now)).toMatchObject({ reason: 'OUTSIDE_WHATSAPP_WINDOW' });
    expect(decideConsent(contact, 'WHATSAPP', ok, [msg('EMAIL', 'Hi', h(1))], now)).toMatchObject({ reason: 'OUTSIDE_WHATSAPP_WINDOW' });
    expect(decideConsent({ ...contact, mobile: null }, 'WHATSAPP', ok, [msg('WHATSAPP', 'Hi', h(1))], now)).toMatchObject({ reason: 'NO_ADDRESS' });
  });
});

describe('audience rules', () => {
  it('are strict definitions only', () => {
    expect(audienceCriteriaSchema.safeParse({ companyTypes: ['CUSTOMER'], purchasedWithinDays: 90 }).success).toBe(true);
    expect(audienceCriteriaSchema.safeParse({ memberIds: ['c1'] }).success).toBe(false); // no stored member lists
    expect(audienceCriteriaSchema.safeParse({ purchasedWithinDays: 30, notPurchasedWithinDays: 90 }).success).toBe(false);
  });

  it('compile to a CRM contact filter requiring an active record and a channel address', () => {
    const where = compileContactWhere({ companyTypes: ['CUSTOMER'] }, 'EMAIL', now);
    const json = JSON.stringify(where);
    expect(json).toContain('"active":true');
    expect(json).toContain('"email"');
    expect(json).toContain('"type":{"in":["CUSTOMER"]}');
  });
});

describe('isolation', () => {
  it('audiences write only marketing tables and send only via the core communications service', () => {
    const dir = path.resolve(__dirname, '../src/marketing/audiences');
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const writes = [...src.matchAll(/\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => m[1]);
      expect(writes.every((w) => w === 'marketingAudience' || w === 'campaignApproval'), `${file}: ${writes}`).toBe(true);
      expect(src, file).not.toMatch(/sendSystemEmail|sendText|sendTemplate|nodemailer|graph\.facebook/);
    }
    expect(fs.readFileSync(path.join(dir, 'messaging.ts'), 'utf8')).toMatch(/from '@\/lib\/communications\/send'/);
  });
});
