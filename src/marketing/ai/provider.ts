import type { ZodType } from 'zod';

/**
 * Provider-neutral LLM interface for the marketing module, plus the
 * resilience layer (retry with backoff, per-attempt timeout, per-provider
 * circuit breaker, ordered fallback) every marketing AI call goes through.
 *
 * Contract: generateJSON() never returns data that failed schema validation.
 * A malformed or schema-violating reply is re-asked (with the validation
 * error as feedback) up to `validationRetries` times, then the next provider
 * is tried, then the call fails. Callers only ever see validated `data`.
 *
 * Independent of src/lib/ai/client.ts (core AI features), which is unchanged.
 */

// =============================================================================
// Types & errors
// =============================================================================

export type Effort = 'low' | 'medium' | 'high';

export interface TextRequest {
  system: string;
  prompt: string;
  /** Output ceiling, including any model thinking. */
  maxTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TextResponse {
  text: string;
  provider: string;
  /** The model that actually served the request (may differ from the
   * requested one if a server-side fallback ran). */
  model: string;
  stopReason: string | null;
  usage: TokenUsage | null;
  requestId: string | null;
}

export interface JsonResponse<T> extends Omit<TextResponse, 'text'> {
  data: T;
}

export interface AIProviderAdapter {
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  generateText(req: TextRequest): Promise<TextResponse>;
  generateJSON<T>(req: TextRequest, schema: ZodType<T, any, unknown>): Promise<JsonResponse<T>>;
}

export type ProviderErrorKind =
  | 'NOT_CONFIGURED'
  | 'AUTH'
  | 'CLIENT'
  | 'RATE_LIMITED'
  | 'OVERLOADED'
  | 'SERVER'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'REFUSAL'
  | 'BAD_RESPONSE'
  | 'CANCELLED'
  | 'CIRCUIT_OPEN';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string | null;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts: { retryable?: boolean; status?: number; retryAfterMs?: number; requestId?: string | null } = {}
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.requestId = opts.requestId;
  }
}

/** The reply was not JSON, was truncated, or did not match the schema. */
export class OutputValidationError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'OutputValidationError';
    this.issues = issues;
  }
}

export interface AttemptRecord {
  provider: string;
  model: string;
  outcome: 'SUCCESS' | 'VALIDATION' | ProviderErrorKind | 'SKIPPED_NOT_CONFIGURED';
  durationMs: number;
  message?: string;
}

export class AllProvidersFailedError extends Error {
  readonly attempts: AttemptRecord[];
  readonly lastError: unknown;
  constructor(attempts: AttemptRecord[], lastError: unknown) {
    const last = lastError instanceof Error ? lastError.message : String(lastError);
    super(`All AI providers failed after ${attempts.length} attempt(s): ${last}`);
    this.name = 'AllProvidersFailedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

// =============================================================================
// JSON extraction & validation
// =============================================================================

/** Pulls the outermost JSON object/array out of a reply, tolerating ```json
 * fences or a sentence before/after. */
export function extractJson(text: string): unknown {
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  const starts = [firstObj, firstArr].filter((i) => i >= 0);
  if (!starts.length) throw new OutputValidationError('Reply contains no JSON');
  const start = Math.min(...starts);
  const end = text.lastIndexOf(text[start] === '{' ? '}' : ']');
  if (end <= start) throw new OutputValidationError('Reply contains no complete JSON value');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new OutputValidationError('Reply is not valid JSON');
  }
}

export function validateJson<T>(text: string, schema: ZodType<T, any, unknown>): T {
  const parsed = schema.safeParse(extractJson(text));
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new OutputValidationError('Reply does not match the required JSON schema', issues);
  }
  return parsed.data;
}

const JSON_ONLY_RULE = '\n\nRespond with a single JSON value only — no prose, no markdown, no code fences.';

/** Adapters implement generateText(); JSON handling is shared. */
export abstract class BaseProviderAdapter implements AIProviderAdapter {
  abstract readonly name: string;
  abstract readonly model: string;
  abstract isConfigured(): boolean;
  abstract generateText(req: TextRequest): Promise<TextResponse>;

  async generateJSON<T>(req: TextRequest, schema: ZodType<T, any, unknown>): Promise<JsonResponse<T>> {
    const res = await this.generateText({ ...req, system: req.system + JSON_ONLY_RULE });
    if (res.stopReason === 'max_tokens') {
      throw new OutputValidationError('Reply was truncated at max_tokens');
    }
    const { text, ...rest } = res;
    return { ...rest, data: validateJson(text, schema) };
  }
}

// =============================================================================
// Circuit breaker
// =============================================================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive infrastructure failures before opening. */
  failureThreshold?: number;
  /** How long to stay open before allowing one trial request. */
  cooldownMs?: number;
  now?: () => number;
}

/** In-process breaker (per app instance). Counts only infrastructure
 * failures — a bad prompt or schema-invalid reply says nothing about the
 * provider's health. */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.cooldownMs) this.state = 'HALF_OPEN';
    return this.state;
  }

  /** Reserves the single half-open trial slot when applicable. */
  tryAcquire(): boolean {
    const s = this.getState();
    if (s === 'CLOSED') return true;
    if (s === 'HALF_OPEN' && !this.trialInFlight) {
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.trialInFlight = false;
  }

  recordFailure(): void {
    this.trialInFlight = false;
    if (this.state === 'HALF_OPEN') {
      this.open();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) this.open();
  }

  /** Releases a half-open slot without judging health (e.g. validation error). */
  release(): void {
    this.trialInFlight = false;
  }

  private open() {
    this.state = 'OPEN';
    this.openedAt = this.now();
    this.failures = 0;
  }
}

const BREAKER_KINDS = new Set<ProviderErrorKind>(['RATE_LIMITED', 'OVERLOADED', 'SERVER', 'TIMEOUT', 'NETWORK']);

// =============================================================================
// Resilient provider
// =============================================================================

export interface ResilienceOptions {
  /** Attempts per provider for retryable errors (includes the first). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Cap on a server-provided retry-after. */
  maxRetryAfterMs?: number;
  /** Hard per-attempt timeout. */
  timeoutMs?: number;
  /** Re-asks per provider after a schema-invalid reply. */
  validationRetries?: number;
  breaker?: CircuitBreakerOptions;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface ResilientJsonResult<T> extends JsonResponse<T> {
  attempts: AttemptRecord[];
  fallbackUsed: boolean;
}

export class ResilientAIProvider {
  private readonly providers: AIProviderAdapter[];
  private readonly breakers: CircuitBreaker[];
  private readonly o: Required<Omit<ResilienceOptions, 'breaker'>>;

  constructor(providers: AIProviderAdapter[], options: ResilienceOptions = {}) {
    if (!providers.length) throw new Error('ResilientAIProvider needs at least one provider');
    this.providers = providers;
    this.breakers = providers.map(() => new CircuitBreaker({ now: options.now, ...options.breaker }));
    this.o = {
      maxAttempts: options.maxAttempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 8_000,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 30_000,
      timeoutMs: options.timeoutMs ?? 90_000,
      validationRetries: options.validationRetries ?? 1,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
    };
  }

  circuitState(index = 0): CircuitState {
    return this.breakers[index].getState();
  }

  async generateJSON<T>(req: TextRequest, schema: ZodType<T, any, unknown>): Promise<ResilientJsonResult<T>> {
    const attempts: AttemptRecord[] = [];
    let lastError: unknown = null;

    for (let p = 0; p < this.providers.length; p++) {
      const provider = this.providers[p];
      const breaker = this.breakers[p];
      const base = { provider: provider.name, model: provider.model };

      if (!provider.isConfigured()) {
        attempts.push({ ...base, outcome: 'SKIPPED_NOT_CONFIGURED', durationMs: 0 });
        lastError = new ProviderError('NOT_CONFIGURED', `${provider.name}/${provider.model} is not configured`);
        continue;
      }

      let request = req;
      let validationFailures = 0;

      for (let attempt = 1; attempt <= this.o.maxAttempts; attempt++) {
        if (!breaker.tryAcquire()) {
          attempts.push({ ...base, outcome: 'CIRCUIT_OPEN', durationMs: 0 });
          lastError = new ProviderError('CIRCUIT_OPEN', `Circuit open for ${provider.name}/${provider.model}`);
          break;
        }

        const started = this.o.now();
        try {
          const res = await this.withTimeout(provider, request, schema);
          breaker.recordSuccess();
          attempts.push({ ...base, outcome: 'SUCCESS', durationMs: this.o.now() - started });
          return { ...res, attempts, fallbackUsed: p > 0 };
        } catch (err) {
          const durationMs = this.o.now() - started;
          lastError = err;

          if (err instanceof OutputValidationError) {
            breaker.release();
            attempts.push({ ...base, outcome: 'VALIDATION', durationMs, message: err.issues.join('; ') || err.message });
            validationFailures += 1;
            if (validationFailures > this.o.validationRetries) break;
            request = withValidationFeedback(req, err);
            continue;
          }

          const pe =
            err instanceof ProviderError ? err : new ProviderError('BAD_RESPONSE', err instanceof Error ? err.message : String(err));
          attempts.push({ ...base, outcome: pe.kind, durationMs, message: pe.message });

          if (pe.kind === 'CANCELLED') throw new AllProvidersFailedError(attempts, pe);
          if (BREAKER_KINDS.has(pe.kind)) breaker.recordFailure();
          else breaker.release();

          if (!pe.retryable || attempt === this.o.maxAttempts) break;
          await this.o.sleep(this.backoff(attempt, pe.retryAfterMs));
        }
      }
    }
    throw new AllProvidersFailedError(attempts, lastError);
  }

  private backoff(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs != null) return Math.min(retryAfterMs, this.o.maxRetryAfterMs);
    const exp = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exp * (0.5 + this.o.random() * 0.5));
  }

  /** Enforces the timeout even if an adapter ignores its AbortSignal. */
  private async withTimeout<T>(provider: AIProviderAdapter, req: TextRequest, schema: ZodType<T, any, unknown>) {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onCallerAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError('TIMEOUT', `Timed out after ${this.o.timeoutMs}ms`, { retryable: true }));
      }, this.o.timeoutMs);
    });
    try {
      return await Promise.race([provider.generateJSON({ ...req, signal: controller.signal }, schema), timeout]);
    } catch (err) {
      if (req.signal?.aborted) throw new ProviderError('CANCELLED', 'Request cancelled by caller');
      throw err;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

function withValidationFeedback(req: TextRequest, err: OutputValidationError): TextRequest {
  const detail = err.issues.length ? err.issues.map((i) => `- ${i}`).join('\n') : `- ${err.message}`;
  return {
    ...req,
    prompt: `${req.prompt}\n\nYour previous reply was rejected:\n${detail}\nReturn corrected JSON that matches the output shape exactly.`,
  };
}
