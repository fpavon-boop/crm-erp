/**
 * Prompt construction and response parsing for every AI feature — the
 * "centralized prompt builder" (docs/AI_FEATURES.md). Every feature shares
 * the same system prompt (the safety/grounding contract) and differs only
 * in which FACTS and instructions get injected.
 */

/**
 * The non-negotiable safety contract sent with every single AI call in
 * this app. Encodes, in order: assistive-only / human-in-the-loop,
 * grounding (never invent beyond FACTS), the explicit "no prior contact"
 * guardrail, the FACTS/RECOMMENDATIONS separation, and a privacy rule
 * against echoing secrets. See docs/AI_FEATURES.md "System prompt".
 */
export const AI_SYSTEM_PROMPT = `You are an assistant embedded in a CRM/ERP system, helping staff by summarizing verified business data and suggesting next actions.

Follow these rules strictly, with no exceptions:
1. You are assistive only. You never execute actions yourself. You cannot send emails or messages, issue refunds, modify inventory, delete or create records, or perform any financial transaction — you only describe what has already happened and suggest what a human could do next.
2. Ground every statement strictly in the FACTS provided in the user message. Never invent, assume, guess, or infer any fact that is not explicitly stated there. If the facts don't mention something (a contact, a payment, an order), do not imply it happened or exists.
3. If the FACTS state "No prior contact found" (or similarly that something has no record), your output must not claim, imply, or assume any such contact or record exists.
4. Respond with ONLY a single JSON object, no other text before or after it, no markdown code fences.
5. Never include credentials, API keys, tokens, or any information not present in the FACTS in your response.`;

function factsBlock(facts: string[]): string {
  if (facts.length === 0) return 'FACTS:\n(none available)';
  return `FACTS:\n${facts.map((f) => `- ${f}`).join('\n')}`;
}

/**
 * Builds the user prompt for the six "analysis" features. Instructs the
 * model to return {"summary": string, "recommendations": string[]} —
 * summary is a plain-English synthesis of FACTS only; recommendations are
 * explicitly-labeled, human-actionable suggestions consistent with FACTS,
 * phrased as suggestions ("Consider...") rather than statements of fact.
 */
export function buildSummaryPrompt(featureLabel: string, facts: string[], instructions: string): string {
  return `${factsBlock(facts)}

TASK: ${featureLabel}
${instructions}

Respond with exactly this JSON shape:
{"summary": "<a concise plain-English synthesis of the FACTS above, no new information>", "recommendations": ["<a suggested next action, phrased as a suggestion, consistent with the FACTS>", "..."]}

If there is nothing meaningful to recommend given the FACTS, return an empty recommendations array. Do not pad it with generic advice not grounded in the FACTS.`;
}

export interface ParsedSummaryResponse {
  summary: string;
  recommendations: string[];
}

/** Parses the model's JSON response, tolerating a stray markdown code
 * fence. Never throws — a malformed response degrades to treating the raw
 * text as the summary with no recommendations, which still preserves the
 * FACTS/RECOMMENDATIONS separation (recommendations stays empty rather
 * than guessing) instead of crashing the whole request. */
export function parseSummaryResponse(raw: string): ParsedSummaryResponse {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    const summary = typeof parsed?.summary === 'string' ? parsed.summary : cleaned.slice(0, 2000);
    const recommendations = Array.isArray(parsed?.recommendations)
      ? parsed.recommendations.filter((r: unknown): r is string => typeof r === 'string')
      : [];
    return { summary, recommendations };
  } catch {
    return { summary: cleaned.slice(0, 2000), recommendations: [] };
  }
}

/**
 * Builds the user prompt for the Email Draft Assistant. Returns a
 * subject/body pair for a human to review and edit before sending — never
 * a recommendation list, since the whole point is editable draft content.
 */
export function buildDraftPrompt(intentLabel: string, facts: string[], instructions: string): string {
  return `${factsBlock(facts)}

TASK: Draft an email — ${intentLabel}.
${instructions}

Respond with exactly this JSON shape:
{"subject": "<a short, specific email subject line>", "body": "<the email body, plain text, professional and concise, grounded only in the FACTS above>"}

The body must not state or imply anything beyond the FACTS above — if a FACT is "No prior contact found", do not reference any prior conversation. This is a DRAFT for a human to review and edit before anyone sends it.`;
}

export interface ParsedDraftResponse {
  subject: string;
  body: string;
}

export function parseDraftResponse(raw: string): ParsedDraftResponse {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    const subject = typeof parsed?.subject === 'string' ? parsed.subject : '';
    const body = typeof parsed?.body === 'string' ? parsed.body : cleaned.slice(0, 4000);
    return { subject, body };
  } catch {
    return { subject: '', body: cleaned.slice(0, 4000) };
  }
}
