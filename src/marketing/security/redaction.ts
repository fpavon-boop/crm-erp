/**
 * PII / secret redaction for anything leaving the CRM toward an AI provider
 * (Anthropic) or an orchestration layer (n8n).
 *
 * Two mechanisms, applied together:
 * 1. Known values — the caller passes the exact PII it already knows is in
 *    context (a contact's name, company name, address). These are replaced
 *    first, most reliably.
 * 2. Pattern detection — secrets/tokens, emails, IBANs, card numbers (Luhn
 *    checked), US SSNs, phone numbers, IPv4 addresses. Biased toward
 *    over-redaction: a lost phone-shaped number in a prompt is cheaper than
 *    a leaked one.
 *
 * Placeholders are stable within one Redactor instance ("[EMAIL_1]" is the
 * same address everywhere it appears), so the model can still reason about
 * "the same person". restore() maps placeholders back locally — e.g. to put
 * the real customer name into an AI-drafted email — and the mapping itself
 * never leaves the process.
 *
 * Object redaction additionally drops the value of any key that looks like a
 * credential (password, token, secret, apiKey, authorization, …) outright.
 */

export type PiiKind = 'SECRET' | 'EMAIL' | 'IBAN' | 'CARD' | 'SSN' | 'PHONE' | 'IP';

export interface KnownValue {
  value: string;
  /** Placeholder label, e.g. "CUSTOMER_NAME" → [CUSTOMER_NAME_1]. */
  label: string;
}

export interface RedactorOptions {
  knownValues?: KnownValue[];
  /** Pattern kinds to leave untouched (e.g. keep nothing by default). */
  allow?: PiiKind[];
}

const MIN_KNOWN_VALUE_LENGTH = 3;

const SENSITIVE_KEY_RE =
  /pass(word)?|secret|token|api[_-]?key|authori[sz]ation|cookie|credential|private[_-]?key|signature|session/i;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const c of chunk) remainder = (remainder * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

function digitCount(s: string): number {
  return s.replace(/\D/g, '').length;
}

interface Detector {
  kind: PiiKind;
  re: RegExp;
  accept?: (match: string) => boolean;
}

// Order matters: secrets before anything that could match part of them,
// cards before phones (both are digit runs).
const DETECTORS: Detector[] = [
  {
    kind: 'SECRET',
    re: /\b(?:sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{16,}|EAA[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|mv1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
  },
  { kind: 'SECRET', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  { kind: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, accept: ibanValid },
  {
    kind: 'CARD',
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (m) => {
      const d = m.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhnValid(d);
    },
  },
  { kind: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    kind: 'PHONE',
    re: /(?<![\w\]])\+?\d[\d\s().-]{7,}\d(?![\w[])/g,
    accept: (m) => {
      const n = digitCount(m);
      return n >= 10 && n <= 15;
    },
  },
  {
    kind: 'IP',
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Redactor {
  private readonly knownValues: KnownValue[];
  private readonly allow: ReadonlySet<PiiKind>;
  private readonly byOriginal = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  constructor(options: RedactorOptions = {}) {
    // Longest first so "Acme Corp Ltd" wins over "Acme".
    this.knownValues = (options.knownValues ?? [])
      .filter((k) => k.value && k.value.trim().length >= MIN_KNOWN_VALUE_LENGTH)
      .map((k) => ({ value: k.value.trim(), label: k.label.toUpperCase().replace(/[^A-Z0-9]+/g, '_') }))
      .sort((a, b) => b.value.length - a.value.length);
    this.allow = new Set(options.allow ?? []);
  }

  private placeholderFor(label: string, original: string): string {
    const key = `${label}\u0000${original.toLowerCase()}`;
    const existing = this.byOriginal.get(key);
    if (existing) return existing;
    const n = (this.counters.get(label) ?? 0) + 1;
    this.counters.set(label, n);
    const placeholder = `[${label}_${n}]`;
    this.byOriginal.set(key, placeholder);
    this.byPlaceholder.set(placeholder, original);
    return placeholder;
  }

  redact(text: string): string {
    let out = text;
    for (const kv of this.knownValues) {
      const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(kv.value)}(?![A-Za-z0-9])`, 'gi');
      out = out.replace(re, (m) => this.placeholderFor(kv.label, m));
    }
    for (const d of DETECTORS) {
      if (this.allow.has(d.kind)) continue;
      out = out.replace(d.re, (m) => (d.accept && !d.accept(m) ? m : this.placeholderFor(d.kind, m)));
    }
    return out;
  }

  /** Deep-redacts a JSON-like value. Credential-looking keys are replaced
   * wholesale with "[REDACTED]"; other strings go through redact(). */
  redactValue<T>(value: T): T {
    return this.walk(value, 0) as T;
  }

  private walk(value: unknown, depth: number): unknown {
    if (depth > 32) return '[REDACTED]';
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v, depth + 1));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : this.walk(v, depth + 1);
      }
      return out;
    }
    return value;
  }

  /** Puts original values back into text produced from redacted input.
   * Local use only — never send restored text back to the provider. */
  restore(text: string): string {
    return text.replace(/\[[A-Z0-9_]+_\d+\]/g, (p) => this.byPlaceholder.get(p) ?? p);
  }

  /** Counts per placeholder label — safe to log (contains no values). */
  summary(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}

/** One-shot convenience for a single string. */
export function redactText(text: string, options?: RedactorOptions): string {
  return new Redactor(options).redact(text);
}
