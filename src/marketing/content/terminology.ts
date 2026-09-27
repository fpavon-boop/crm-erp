import type { MarketingChannel, MarketingLanguage, MarketingSafeguardVerdict } from '@prisma/client';
import type { BrandContext } from './brand-profile';

/**
 * Terminology & compliance validator for draft marketing copy (EN/ES).
 *
 * Matching is case- AND accent-insensitive ("numero uno" catches "número
 * uno") and whole-phrase only (banning "free" does not flag "freedom").
 *
 * BLOCK — copy must not be approved as-is:
 *   BANNED_PHRASE, COMPLIANCE_CLAIM, DISCOUNT_WITHOUT_APPROVAL,
 *   DISCOUNT_EXCEEDS_APPROVED, UNRESOLVED_PLACEHOLDER, LENGTH_EXCEEDED,
 *   EMPTY_COPY
 * WARN — reviewer should look:
 *   DISCOURAGED_TERM (with the approved term as `suggestion`),
 *   MISSING_DISCLAIMER
 */

export type TermIssueCode =
  | 'EMPTY_COPY'
  | 'BANNED_PHRASE'
  | 'COMPLIANCE_CLAIM'
  | 'DISCOUNT_WITHOUT_APPROVAL'
  | 'DISCOUNT_EXCEEDS_APPROVED'
  | 'UNRESOLVED_PLACEHOLDER'
  | 'LENGTH_EXCEEDED'
  | 'DISCOURAGED_TERM'
  | 'MISSING_DISCLAIMER';

export interface TermIssue {
  code: TermIssueCode;
  severity: 'WARN' | 'BLOCK';
  message: string;
  /** The text as it appears in the copy. */
  match?: string;
  index?: number;
  suggestion?: string;
}

export interface TermValidation {
  verdict: MarketingSafeguardVerdict;
  issues: TermIssue[];
  /** Every discount percentage the copy mentions, in order. */
  discountsMentioned: number[];
}

/** Platform caption/body limits (characters). Channels without a hard limit
 * are omitted. */
export const CHANNEL_CHAR_LIMITS: Partial<Record<MarketingChannel, number>> = {
  INSTAGRAM: 2200,
  TIKTOK: 2200,
  FACEBOOK: 5000,
  WHATSAPP: 1024,
};

/** Built-in claims no brand profile can whitelist: guarantees, unqualified
 * superlatives, and "no risk" language that create advertising-law exposure. */
export const COMPLIANCE_CLAIMS: Record<MarketingLanguage, string[]> = {
  EN: [
    'guaranteed',
    'guarantee',
    'risk-free',
    'risk free',
    'no risk',
    '100% safe',
    'best in the world',
    'world’s best',
    "world's best",
    'number one',
    '#1',
    'lowest price',
    'lowest prices',
    'cheapest',
  ],
  ES: [
    'garantizado',
    'garantizada',
    'garantía total',
    'sin riesgo',
    'libre de riesgo',
    '100% seguro',
    '100% segura',
    'el mejor del mundo',
    'la mejor del mundo',
    'número uno',
    '#1',
    'precio más bajo',
    'precios más bajos',
    'el más barato',
    'la más barata',
  ],
};

const PLACEHOLDER_RE = /\[[A-Z0-9_]+_\d+\]|\{\{[^}]*\}\}|\bTODO\b|\bTBD\b|\bXXX+\b|lorem ipsum/gi;

// Run against folded (lowercase, accent-free) text, so ES patterns are
// written without accents. Both languages' patterns always run: mixed-language
// copy must not slip a discount past the check.
const DISCOUNT_RES: RegExp[] = [
  /(\d{1,3}(?:[.,]\d+)?)\s?%\s?(?:off|discount|savings?)\b/g,
  /\b(?:save|saving|ahorra|ahorre|ahorro de|hasta un|up to)\s+(\d{1,3}(?:[.,]\d+)?)\s?%/g,
  /(\d{1,3}(?:[.,]\d+)?)\s?%\s?(?:de\s+)?(?:descuento|dto\.?|rebaja)/g,
  /(\d{1,3}(?:[.,]\d+)?)\s?(?:percent|por\s?ciento)\s+(?:off|de\s+descuento)/g,
];

// ---------------------------------------------------------------------------
// Folding: lowercase + strip diacritics, preserving string length 1:1 so
// indices in folded text map straight back to the original.
// ---------------------------------------------------------------------------

export function fold(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const f = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    out += f.length === 1 ? f : c;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findPhrase(foldedText: string, phrase: string): number[] {
  const p = fold(phrase.normalize('NFC').trim());
  if (!p) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(p)}(?![\\p{L}\\p{N}])`, 'gu');
  const hits: number[] = [];
  for (const m of foldedText.matchAll(re)) hits.push(m.index!);
  return hits;
}

function verdictOf(issues: TermIssue[]): MarketingSafeguardVerdict {
  if (issues.some((i) => i.severity === 'BLOCK')) return 'BLOCK';
  return issues.length ? 'WARN' : 'PASS';
}

export function extractDiscounts(text: string): number[] {
  const folded = fold(text.normalize('NFC'));
  const found: Array<{ index: number; value: number }> = [];
  const seen = new Set<number>();
  for (const re of DISCOUNT_RES) {
    for (const m of folded.matchAll(re)) {
      const at = m.index! + m[0].indexOf(m[1]);
      if (seen.has(at)) continue;
      seen.add(at);
      found.push({ index: at, value: Number(m[1].replace(',', '.')) });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.value);
}

export interface ValidateCopyOptions {
  brand: BrandContext;
  language: MarketingLanguage;
  channel?: MarketingChannel;
  /** The campaign's safeguard-approved discount. `undefined`/`null` means no
   * discount is approved, so any discount claim in the copy is a BLOCK. */
  approvedDiscountPct?: number | null;
}

export function validateCopy(rawText: string, options: ValidateCopyOptions): TermValidation {
  const { brand, language, channel, approvedDiscountPct } = options;
  const text = rawText.normalize('NFC');
  const folded = fold(text);
  const issues: TermIssue[] = [];
  const snippet = (index: number, phrase: string) => text.slice(index, index + fold(phrase.normalize('NFC').trim()).length);

  if (!text.trim()) {
    return {
      verdict: 'BLOCK',
      issues: [{ code: 'EMPTY_COPY', severity: 'BLOCK', message: 'Copy is empty.' }],
      discountsMentioned: [],
    };
  }

  const locale = brand.locales[language];
  const banned = new Set([...brand.bannedPhrases, ...locale.bannedPhrases]);
  for (const phrase of banned) {
    for (const index of findPhrase(folded, phrase)) {
      issues.push({
        code: 'BANNED_PHRASE',
        severity: 'BLOCK',
        message: `Banned brand phrase "${phrase}".`,
        match: snippet(index, phrase),
        index,
      });
    }
  }

  for (const claim of COMPLIANCE_CLAIMS[language]) {
    for (const index of findPhrase(folded, claim)) {
      issues.push({
        code: 'COMPLIANCE_CLAIM',
        severity: 'BLOCK',
        message: `Unsubstantiated claim "${claim}" (guarantee/superlative/no-risk language).`,
        match: snippet(index, claim),
        index,
      });
    }
  }

  const discounts = extractDiscounts(text);
  for (const pct of discounts) {
    if (approvedDiscountPct == null) {
      issues.push({
        code: 'DISCOUNT_WITHOUT_APPROVAL',
        severity: 'BLOCK',
        message: `Copy mentions ${pct}% off but the campaign has no approved discount.`,
      });
    } else if (pct > approvedDiscountPct + 1e-9) {
      issues.push({
        code: 'DISCOUNT_EXCEEDS_APPROVED',
        severity: 'BLOCK',
        message: `Copy mentions ${pct}% off; the approved discount is ${approvedDiscountPct}%.`,
      });
    }
  }

  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    issues.push({
      code: 'UNRESOLVED_PLACEHOLDER',
      severity: 'BLOCK',
      message: `Unresolved placeholder "${m[0]}".`,
      match: m[0],
      index: m.index,
    });
  }

  const limit = channel ? CHANNEL_CHAR_LIMITS[channel] : undefined;
  if (limit && text.length > limit) {
    issues.push({
      code: 'LENGTH_EXCEEDED',
      severity: 'BLOCK',
      message: `${text.length} characters exceeds the ${channel} limit of ${limit}.`,
    });
  }

  for (const t of brand.terms[language]) {
    for (const variant of t.discouraged) {
      for (const index of findPhrase(folded, variant)) {
        issues.push({
          code: 'DISCOURAGED_TERM',
          severity: 'WARN',
          message: `Use the approved term "${t.term}" instead of "${variant}".`,
          match: snippet(index, variant),
          index,
          suggestion: t.term,
        });
      }
    }
  }

  if (locale.requiredDisclaimer && !folded.includes(fold(locale.requiredDisclaimer.normalize('NFC').trim()))) {
    issues.push({
      code: 'MISSING_DISCLAIMER',
      severity: 'WARN',
      message: `Required disclaimer is missing: "${locale.requiredDisclaimer}".`,
    });
  }

  issues.sort((a, b) => (a.severity === b.severity ? (a.index ?? 0) - (b.index ?? 0) : a.severity === 'BLOCK' ? -1 : 1));
  return { verdict: verdictOf(issues), issues, discountsMentioned: discounts };
}
