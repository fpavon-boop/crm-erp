import { describe, it, expect } from 'vitest';
import {
  AI_SYSTEM_PROMPT,
  buildSummaryPrompt,
  parseSummaryResponse,
  buildDraftPrompt,
  parseDraftResponse,
} from '../src/lib/ai/prompts';

/**
 * Phase 14 (AI-Assisted Features, docs/AI_FEATURES.md): pure unit tests
 * for prompt construction and response parsing — no database, no network
 * call. These are the tests that most directly exercise the "grounding &
 * anti-hallucination" and "FACTS vs RECOMMENDATIONS" requirements at the
 * prompt-construction layer; src/lib/ai/facts.ts's own tests cover the
 * "no prior contact found" guardrail at the data layer.
 */
describe('AI_SYSTEM_PROMPT', () => {
  it('states the assistive-only / human-in-the-loop rule', () => {
    expect(AI_SYSTEM_PROMPT).toMatch(/assistive only/i);
    expect(AI_SYSTEM_PROMPT).toMatch(/never execute actions/i);
  });

  it('forbids financial transactions, deletions, inventory changes, and sending messages', () => {
    expect(AI_SYSTEM_PROMPT).toMatch(/refunds/i);
    expect(AI_SYSTEM_PROMPT).toMatch(/modify inventory/i);
    expect(AI_SYSTEM_PROMPT).toMatch(/delete or create records/i);
    expect(AI_SYSTEM_PROMPT).toMatch(/send emails or messages/i);
  });

  it('requires grounding strictly in the provided FACTS and forbids inventing information', () => {
    expect(AI_SYSTEM_PROMPT).toMatch(/FACTS/);
    expect(AI_SYSTEM_PROMPT).toMatch(/never invent, assume, guess, or infer/i);
  });

  it('carries the explicit "no prior contact" guardrail instruction', () => {
    expect(AI_SYSTEM_PROMPT).toMatch(/no prior contact found/i);
  });

  it('forbids leaking credentials or secrets', () => {
    expect(AI_SYSTEM_PROMPT).toMatch(/credentials|api keys|tokens/i);
  });
});

describe('buildSummaryPrompt', () => {
  it('includes every fact and the feature label/instructions verbatim', () => {
    const prompt = buildSummaryPrompt('Customer Summary', ['Fact one.', 'Fact two.'], 'Do the thing.');
    expect(prompt).toContain('Fact one.');
    expect(prompt).toContain('Fact two.');
    expect(prompt).toContain('Customer Summary');
    expect(prompt).toContain('Do the thing.');
  });

  it('asks for the exact {"summary", "recommendations"} JSON shape', () => {
    const prompt = buildSummaryPrompt('X', ['f'], 'i');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"recommendations"');
  });

  it('renders "(none available)" rather than an empty facts block when there are no facts', () => {
    const prompt = buildSummaryPrompt('X', [], 'i');
    expect(prompt).toContain('(none available)');
  });
});

describe('parseSummaryResponse', () => {
  it('parses a clean JSON response', () => {
    const result = parseSummaryResponse('{"summary": "All good.", "recommendations": ["Follow up next week."]}');
    expect(result.summary).toBe('All good.');
    expect(result.recommendations).toEqual(['Follow up next week.']);
  });

  it('strips a markdown code fence around the JSON', () => {
    const result = parseSummaryResponse('```json\n{"summary": "S", "recommendations": []}\n```');
    expect(result.summary).toBe('S');
    expect(result.recommendations).toEqual([]);
  });

  it('degrades to raw text as the summary with empty recommendations on malformed JSON, rather than throwing', () => {
    expect(() => parseSummaryResponse('not json at all')).not.toThrow();
    const result = parseSummaryResponse('not json at all');
    expect(result.summary).toBe('not json at all');
    expect(result.recommendations).toEqual([]);
  });

  it('filters out non-string entries in a malformed recommendations array instead of crashing', () => {
    const result = parseSummaryResponse('{"summary": "S", "recommendations": ["ok", 42, null, "also ok"]}');
    expect(result.recommendations).toEqual(['ok', 'also ok']);
  });

  it('falls back to the raw text when "summary" is missing from otherwise-valid JSON', () => {
    const result = parseSummaryResponse('{"recommendations": ["x"]}');
    expect(result.summary).toContain('recommendations');
    expect(result.recommendations).toEqual(['x']);
  });
});

describe('buildDraftPrompt', () => {
  it('includes the intent label, facts, and instructions', () => {
    const prompt = buildDraftPrompt('a follow-up message', ['Fact A.'], 'Keep it short.');
    expect(prompt).toContain('a follow-up message');
    expect(prompt).toContain('Fact A.');
    expect(prompt).toContain('Keep it short.');
  });

  it('asks for the exact {"subject", "body"} JSON shape', () => {
    const prompt = buildDraftPrompt('x', ['f'], 'i');
    expect(prompt).toContain('"subject"');
    expect(prompt).toContain('"body"');
  });

  it('instructs the model not to imply contact beyond the FACTS', () => {
    const prompt = buildDraftPrompt('x', ['No prior contact found.'], 'i');
    expect(prompt).toMatch(/must not state or imply anything beyond the FACTS/i);
  });
});

describe('parseDraftResponse', () => {
  it('parses a clean JSON response', () => {
    const result = parseDraftResponse('{"subject": "Hi there", "body": "Body text."}');
    expect(result.subject).toBe('Hi there');
    expect(result.body).toBe('Body text.');
  });

  it('degrades to an empty subject and raw text as the body on malformed JSON, rather than throwing', () => {
    expect(() => parseDraftResponse('garbage')).not.toThrow();
    const result = parseDraftResponse('garbage');
    expect(result.subject).toBe('');
    expect(result.body).toBe('garbage');
  });
});
