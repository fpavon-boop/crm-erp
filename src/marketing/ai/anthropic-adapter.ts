import { BaseProviderAdapter, ProviderError, type TextRequest, type TextResponse } from './provider';

/**
 * Anthropic Messages API adapter for the marketing pipeline.
 *
 * Raw `fetch`, matching the project's existing no-SDK convention
 * (src/lib/ai/client.ts, which this does not touch), but with what the
 * marketing pipeline needs that the core client doesn't expose: an
 * AbortSignal for timeouts, typed retryable/non-retryable errors, token
 * usage, request-id, and refusal handling.
 *
 * Uses the same ANTHROPIC_API_KEY as the core AI features. Model defaults to
 * claude-opus-5 (override with MARKETING_AI_MODEL). On claude-opus-5 /
 * claude-fable-5-1 the server-side refusal fallback is enabled by default
 * (`fallbacks: "default"`); set MARKETING_AI_SERVER_FALLBACKS=false to
 * disable. The model that actually served the reply is reported in
 * TextResponse.model.
 */

export const DEFAULT_MARKETING_MODEL = 'claude-opus-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);
const DEFAULT_MAX_TOKENS = 16_000;

export interface AnthropicAdapterOptions {
  model?: string;
  /** Defaults to process.env.ANTHROPIC_API_KEY, read at call time. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  url?: string;
  defaultEffort?: 'low' | 'medium' | 'high';
  serverFallbacks?: boolean;
}

interface MessagesResponse {
  model?: string;
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function classifyStatus(status: number): { kind: ProviderError['kind']; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: 'AUTH', retryable: false };
  if (status === 408) return { kind: 'TIMEOUT', retryable: true };
  if (status === 429) return { kind: 'RATE_LIMITED', retryable: true };
  if (status === 529) return { kind: 'OVERLOADED', retryable: true };
  if (status === 409 || status >= 500) return { kind: 'SERVER', retryable: true };
  return { kind: 'CLIENT', retryable: false };
}

export class AnthropicAdapter extends BaseProviderAdapter {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly opts: AnthropicAdapterOptions;

  constructor(opts: AnthropicAdapterOptions = {}) {
    super();
    this.opts = opts;
    this.model = opts.model || process.env.MARKETING_AI_MODEL || DEFAULT_MARKETING_MODEL;
  }

  private apiKey(): string | undefined {
    return this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  private useServerFallbacks(): boolean {
    const enabled = this.opts.serverFallbacks ?? process.env.MARKETING_AI_SERVER_FALLBACKS !== 'false';
    return enabled && SERVER_FALLBACK_MODELS.has(this.model);
  }

  async generateText(req: TextRequest): Promise<TextResponse> {
    const apiKey = this.apiKey();
    if (!apiKey) throw new ProviderError('NOT_CONFIGURED', 'ANTHROPIC_API_KEY is not configured');

    const headers: Record<string, string> = {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    };
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    };
    const effort = req.effort ?? this.opts.defaultEffort ?? 'medium';
    // Haiku 4.5 rejects `effort`; every other current model accepts it.
    if (!this.model.startsWith('claude-haiku')) body.output_config = { effort };
    if (this.useServerFallbacks()) {
      headers['anthropic-beta'] = SERVER_FALLBACK_BETA;
      body.fallbacks = 'default';
    }

    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(this.opts.url ?? API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new ProviderError('TIMEOUT', 'Anthropic request aborted', { retryable: true });
      }
      throw new ProviderError('NETWORK', `Anthropic network error: ${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
      });
    }

    const requestId = res.headers.get('request-id');
    const raw = await res.text();
    let json: MessagesResponse | null = null;
    try {
      json = JSON.parse(raw) as MessagesResponse;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const { kind, retryable } = classifyStatus(res.status);
      const detail = json?.error ? `${json.error.type}: ${json.error.message}` : raw.slice(0, 200);
      throw new ProviderError(kind, `Anthropic API ${res.status} (${detail})`.slice(0, 500), {
        retryable,
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        requestId,
      });
    }
    if (!json) {
      throw new ProviderError('BAD_RESPONSE', `Anthropic returned non-JSON body: ${raw.slice(0, 200)}`, { requestId });
    }

    // Check stop_reason before reading content.
    if (json.stop_reason === 'refusal') {
      const category = json.stop_details?.category ?? 'unspecified';
      throw new ProviderError('REFUSAL', `Model declined the request (category: ${category})`, { requestId });
    }

    // Thinking / fallback blocks may precede the text; take text blocks only.
    const text = (json.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (!text) {
      throw new ProviderError('BAD_RESPONSE', `Anthropic reply had no text block (stop_reason: ${json.stop_reason})`, { requestId });
    }

    return {
      text,
      provider: this.name,
      model: json.model ?? this.model,
      stopReason: json.stop_reason ?? null,
      usage:
        json.usage && typeof json.usage.input_tokens === 'number'
          ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens ?? 0 }
          : null,
      requestId,
    };
  }
}
