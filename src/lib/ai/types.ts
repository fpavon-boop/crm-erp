/**
 * The response shape for the six "analysis" AI features (customer
 * summary, sales summary, follow-up suggestions, product analysis,
 * inventory warning, invoice/account summary). See docs/AI_FEATURES.md
 * "FACTS vs RECOMMENDATIONS".
 *
 * `facts` is ALWAYS code-computed from the database, never written or
 * altered by the LLM — it is returned verbatim from whatever
 * `src/lib/ai/facts.ts` builder produced, so it can never be hallucinated.
 * `summary` and `recommendations` are the LLM's synthesis of those facts;
 * when the AI call fails or is unconfigured, they degrade to an explicit
 * "unavailable" state (`aiAvailable: false`) rather than fabricating
 * plausible-looking content.
 */
export interface AiFeatureResult {
  facts: string[];
  summary: string;
  recommendations: string[];
  aiAvailable: boolean;
  model: string | null;
  generatedAt: string;
}

/** The response shape for the Email Draft Assistant — a draft is content
 * to be reviewed/edited by a human, never itself a "fact" or
 * "recommendation" list. Always returned into editable UI state; never
 * sent automatically (see docs/AI_FEATURES.md "Human-in-the-loop"). */
export interface AiDraftResult {
  facts: string[];
  subject: string;
  body: string;
  aiAvailable: boolean;
  model: string | null;
  generatedAt: string;
}
