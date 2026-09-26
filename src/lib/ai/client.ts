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

  // Read as text first rather than res.json().catch(() => ({})) — the
  // latter silently swallows a non-JSON body (an HTML error page from an
  // intermediate proxy, a truncated response) into an empty object,
  // which then produces the same generic "unexpected shape" error as a
  // genuine API response with no text block, making the two cases
  // impossible to tell apart from the stored error alone.
  const rawBody = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(rawBody);
  } catch {
    json = null;
  }

  if (!res.ok) {
    const detail = json ? JSON.stringify(json) : rawBody;
    throw new AiRequestError(`Anthropic API error (${res.status}): ${detail.slice(0, 500)}`);
  }

  // The Messages API response is { content: [{type, text?}, ...] } — a
  // text block is not always content[0] (e.g. a "thinking" or other
  // non-text block can precede it), so find the first block that
  // actually is one rather than assuming position 0.
  const content = (json as { content?: unknown })?.content;
  const textBlock = Array.isArray(content)
    ? content.find((block): block is { type: 'text'; text: string } => {
        const b = block as { type?: unknown; text?: unknown };
        return b?.type === 'text' && typeof b.text === 'string';
      })
    : undefined;

  if (!textBlock) {
    const detail = json ? JSON.stringify(json) : rawBody;
    throw new AiRequestError(`Anthropic API returned an unexpected response shape: ${detail.slice(0, 500)}`);
  }
  return textBlock.text;
}
