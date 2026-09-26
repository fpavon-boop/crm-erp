/**
 * The one place this app calls out to an LLM. A thin `fetch` wrapper
 * around Anthropic's Messages API (no SDK dependency — same "raw fetch to
 * the provider's REST API" convention already used for WhatsApp's Graph
 * API client, src/lib/whatsapp/client.ts).
 *
 * Never throws a fabricated success — if the API key is missing or the
 * request fails, the caller (src/lib/ai/service.ts) is told so explicitly
 * and decides how to degrade, rather than this module inventing a
 * plausible-looking response.
 */

export class AiNotConfiguredError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not configured — AI features are unavailable until it is set.');
    this.name = 'AiNotConfiguredError';
  }
}

export class AiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiRequestError';
  }
}

export interface AiCompletionRequest {
  /** The shared safety/grounding system prompt — see src/lib/ai/prompts.ts. */
  system: string;
  /** The feature-specific user prompt (facts + instructions). */
  prompt: string;
  maxTokens?: number;
}

/** The default model, overridable via env without a code change (model
 * names/availability shift over time — see docs/AI_FEATURES.md). */
export function aiModelName(): string {
  return process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
}

/** Whether an API key is configured at all — lets a route/UI show "AI
 * features are not configured" instead of attempting a call that will
 * only fail. */
export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function generateCompletion(req: AiCompletionRequest): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AiNotConfiguredError();

  const model = aiModelName();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AiRequestError(`Anthropic API error (${res.status}): ${JSON.stringify(json).slice(0, 500)}`);
  }

  const text = json?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new AiRequestError('Anthropic API returned an unexpected response shape.');
  }
  return text;
}
