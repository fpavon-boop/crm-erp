import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestDb } from './test-db';
import { startTestDb } from './test-db';

/**
 * Phase 14 (AI-Assisted Features, docs/AI_FEATURES.md): the centralized
 * service layer (src/lib/ai/service.ts) — audit log creation on both
 * success and failure, and graceful degradation (never a fabricated
 * summary) when the AI call fails or is unconfigured. Uses the same
 * `generate` dependency-injection seam sendCommunication() uses for its
 * emailSender (src/lib/communications/send.ts) so no real network call or
 * API key is needed.
 */
describe('AI service layer (runAiSummaryFeature / runAiDraftFeature)', () => {
  let db: TestDb;
  let service: typeof import('../src/lib/ai/service');

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    delete process.env.ANTHROPIC_API_KEY; // ensure the "not configured" path is exercised deliberately, not by accident
    service = await import('../src/lib/ai/service');
  }, 60000);

  afterAll(async () => {
    await db.stop();
  });

  function id() {
    return Math.random().toString(36).slice(2);
  }

  async function makeUser() {
    return db.prisma.user.create({ data: { name: 'Agent', email: `agent-${id()}@example.com`, passwordHash: 'x', role: 'ADMIN' } });
  }

  describe('runAiSummaryFeature', () => {
    it('on success: returns the facts verbatim, the parsed summary/recommendations, and writes a SUCCESS AiGenerationLog row', async () => {
      const user = await makeUser();
      const facts = ['Fact one.', 'Fact two.'];
      const result = await service.runAiSummaryFeature({
        feature: 'CUSTOMER_SUMMARY',
        entityType: 'Company',
        entityId: 'company-123',
        requestedById: user.id,
        facts,
        featureLabel: 'Customer Summary',
        instructions: 'Summarize.',
        generate: async () => JSON.stringify({ summary: 'All good.', recommendations: ['Reach out next week.'] }),
      });

      expect(result.facts).toEqual(facts);
      expect(result.aiAvailable).toBe(true);
      expect(result.summary).toBe('All good.');
      expect(result.recommendations).toEqual(['Reach out next week.']);

      const log = await db.prisma.aiGenerationLog.findFirstOrThrow({ where: { entityId: 'company-123' } });
      expect(log.feature).toBe('CUSTOMER_SUMMARY');
      expect(log.status).toBe('SUCCESS');
      expect(log.requestedById).toBe(user.id);
      expect(log.entityType).toBe('Company');
      expect(log.errorMessage).toBeNull();
    });

    it('on failure: never fabricates a summary — returns aiAvailable:false with the facts still intact, and writes a FAILED AiGenerationLog row with the error message', async () => {
      const user = await makeUser();
      const facts = ['Only fact.'];
      const result = await service.runAiSummaryFeature({
        feature: 'SALES_SUMMARY',
        entityId: 'entity-failure-case',
        requestedById: user.id,
        facts,
        featureLabel: 'Sales Summary',
        instructions: 'Summarize.',
        generate: async () => {
          throw new Error('simulated API outage');
        },
      });

      expect(result.aiAvailable).toBe(false);
      expect(result.facts).toEqual(facts);
      expect(result.recommendations).toEqual([]);
      expect(result.summary).toContain('simulated API outage');

      const log = await db.prisma.aiGenerationLog.findFirstOrThrow({ where: { entityId: 'entity-failure-case' } });
      expect(log.status).toBe('FAILED');
      expect(log.errorMessage).toContain('simulated API outage');
    });

    it('with no API key configured and no injected generate(): degrades to aiAvailable:false rather than throwing out of the route', async () => {
      const user = await makeUser();
      const result = await service.runAiSummaryFeature({
        feature: 'PRODUCT_ANALYSIS',
        entityId: 'entity-unconfigured',
        requestedById: user.id,
        facts: ['A fact.'],
        featureLabel: 'Product Sales Analysis',
        instructions: 'Summarize.',
      });
      expect(result.aiAvailable).toBe(false);
      expect(result.facts).toEqual(['A fact.']);

      const log = await db.prisma.aiGenerationLog.findFirstOrThrow({ where: { entityId: 'entity-unconfigured' } });
      expect(log.status).toBe('FAILED');
      expect(log.errorMessage).toContain('ANTHROPIC_API_KEY');
    });

    it('a malformed (non-JSON) AI response still succeeds — no recommendations fabricated, summary falls back to the raw text', async () => {
      const user = await makeUser();
      const result = await service.runAiSummaryFeature({
        feature: 'FOLLOWUP_SUGGESTIONS',
        entityId: 'entity-malformed',
        requestedById: user.id,
        facts: ['A fact.'],
        featureLabel: 'Follow-Up Suggestions',
        instructions: 'Summarize.',
        generate: async () => 'this is not json',
      });
      expect(result.aiAvailable).toBe(true); // the call itself succeeded; only its content was malformed
      expect(result.summary).toBe('this is not json');
      expect(result.recommendations).toEqual([]);
    });
  });

  describe('runAiDraftFeature', () => {
    it('on success: returns the parsed subject/body and writes a SUCCESS AiGenerationLog row for EMAIL_DRAFT', async () => {
      const user = await makeUser();
      const result = await service.runAiDraftFeature({
        feature: 'EMAIL_DRAFT',
        entityId: 'company-draft-1',
        requestedById: user.id,
        facts: ['No prior contact found.'],
        intentLabel: 'a follow-up message',
        instructions: 'Keep it short.',
        generate: async () => JSON.stringify({ subject: 'Checking in', body: 'Hello, just checking in.' }),
      });
      expect(result.aiAvailable).toBe(true);
      expect(result.subject).toBe('Checking in');
      expect(result.body).toBe('Hello, just checking in.');

      const log = await db.prisma.aiGenerationLog.findFirstOrThrow({ where: { entityId: 'company-draft-1' } });
      expect(log.feature).toBe('EMAIL_DRAFT');
      expect(log.status).toBe('SUCCESS');
    });

    it('on failure: returns an empty subject and a clear unavailable message in body, never a fabricated draft', async () => {
      const user = await makeUser();
      const result = await service.runAiDraftFeature({
        feature: 'EMAIL_DRAFT',
        entityId: 'company-draft-2',
        requestedById: user.id,
        facts: ['No prior contact found.'],
        intentLabel: 'a follow-up message',
        instructions: 'Keep it short.',
        generate: async () => {
          throw new Error('simulated failure');
        },
      });
      expect(result.aiAvailable).toBe(false);
      expect(result.subject).toBe('');
      expect(result.body).toContain('simulated failure');
    });
  });
});
