import { z } from 'zod';

/**
 * Template placeholder language: `{{snake_case_name}}` (inner whitespace
 * allowed). No logic, no filters, no nesting — values are substituted as
 * plain text, and any `{{`/`}}` inside a value is neutralised so a value can
 * never inject another placeholder.
 */

export type PlaceholderType = 'text' | 'currency' | 'percent' | 'hashtags' | 'asset';

export interface PlaceholderSpec {
  type: PlaceholderType;
  description: string;
  maxLength?: number;
  /** Only valid on a campaign with an approved discount. */
  requiresDiscount?: boolean;
}

/** Built-in placeholders every template may use. */
export const PLACEHOLDER_CATALOG: Record<string, PlaceholderSpec> = {
  product_name: { type: 'text', description: 'Product display name', maxLength: 80 },
  product_sku: { type: 'text', description: 'Product SKU', maxLength: 40 },
  price: { type: 'currency', description: 'Regular list price' },
  promo_price: { type: 'currency', description: 'Discounted price', requiresDiscount: true },
  discount_pct: { type: 'percent', description: 'Approved discount percentage', requiresDiscount: true },
  discount_badge: { type: 'text', description: 'Short badge, e.g. "15% OFF"', maxLength: 20, requiresDiscount: true },
  cta_text: { type: 'text', description: 'Call to action', maxLength: 40 },
  headline: { type: 'text', description: 'Headline', maxLength: 100 },
  body: { type: 'text', description: 'Body copy', maxLength: 2000 },
  hashtags: { type: 'hashtags', description: 'Space-separated hashtags', maxLength: 300 },
  brand_name: { type: 'text', description: 'Brand name', maxLength: 80 },
  disclaimer: { type: 'text', description: 'Legal disclaimer', maxLength: 200 },
  product_image: { type: 'asset', description: 'MarketingAsset id of the product image' },
  logo: { type: 'asset', description: 'MarketingAsset id of the logo' },
};

export const PLACEHOLDER_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const TOKEN_RE = /\{\{([^{}]*)\}\}/g;

export interface PlaceholderOccurrence {
  name: string;
  index: number;
  raw: string;
}

export interface ParseError {
  code: 'INVALID_NAME' | 'UNBALANCED_BRACES';
  message: string;
  index: number;
}

export interface ParseResult {
  /** Unique names in order of first appearance. */
  placeholders: string[];
  occurrences: PlaceholderOccurrence[];
  errors: ParseError[];
}

export function parsePlaceholders(body: string): ParseResult {
  const occurrences: PlaceholderOccurrence[] = [];
  const errors: ParseError[] = [];
  let stripped = '';
  let last = 0;

  for (const m of body.matchAll(TOKEN_RE)) {
    const index = m.index!;
    const name = m[1].trim();
    stripped += body.slice(last, index) + ' '.repeat(m[0].length);
    last = index + m[0].length;
    // "{{{x}}}" matches as "{{x}}" with stray single braces either side.
    if (body[index - 1] === '{' || body[last] === '}') {
      errors.push({ code: 'UNBALANCED_BRACES', message: `Extra brace around "${m[0]}" at position ${index}`, index });
      continue;
    }
    if (!PLACEHOLDER_NAME_RE.test(name)) {
      errors.push({ code: 'INVALID_NAME', message: `Invalid placeholder name "${m[0]}" (use lowercase snake_case)`, index });
      continue;
    }
    occurrences.push({ name, index, raw: m[0] });
  }
  stripped += body.slice(last);

  // Any brace pair left after removing well-formed tokens is malformed
  // ("{{price}", "{ {x}}", "{{{x}}}", a lone "}}").
  for (const m of stripped.matchAll(/\{\{|\}\}/g)) {
    errors.push({ code: 'UNBALANCED_BRACES', message: `Unbalanced "${m[0]}" at position ${m.index}`, index: m.index! });
  }

  return { placeholders: [...new Set(occurrences.map((o) => o.name))], occurrences, errors };
}

// =============================================================================
// Declared placeholder schema (stored in MarketingTemplate.variables)
// =============================================================================

export const placeholderDeclarationSchema = z
  .object({
    key: z.string().regex(PLACEHOLDER_NAME_RE, 'key must be lowercase snake_case'),
    required: z.boolean().default(true),
    maxLength: z.number().int().min(1).max(5000).optional(),
    description: z.string().trim().max(200).optional(),
    /** True for template-specific keys outside the built-in catalog. */
    custom: z.boolean().default(false),
  })
  .strict();

export type PlaceholderDeclaration = z.output<typeof placeholderDeclarationSchema>;

// =============================================================================
// Rendering
// =============================================================================

export type PlaceholderValue = string | number | string[] | null | undefined;

export interface RenderResult {
  text: string;
  missing: string[];
  errors: string[];
}

function formatValue(name: string, value: PlaceholderValue): string {
  const spec = PLACEHOLDER_CATALOG[name];
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(' ');
  if (typeof value === 'number') {
    if (spec?.type === 'currency') return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (spec?.type === 'percent') return `${value}%`;
    return String(value);
  }
  return value;
}

/** Neutralise braces so a value can't open a new placeholder. */
function sanitize(value: string): string {
  return value.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
}

/** Fills a body template. Required-but-missing values and over-length
 * values are reported in `errors`; the caller decides whether to proceed. */
export function renderTemplate(
  body: string,
  values: Record<string, PlaceholderValue>,
  declarations: PlaceholderDeclaration[] = []
): RenderResult {
  const parsed = parsePlaceholders(body);
  const errors = parsed.errors.map((e) => e.message);
  const declared = new Map(declarations.map((d) => [d.key, d]));
  const missing: string[] = [];
  const rendered = new Map<string, string>();

  for (const name of parsed.placeholders) {
    const decl = declared.get(name);
    const required = decl ? decl.required : true;
    const text = sanitize(formatValue(name, values[name]).trim());
    if (!text && required) missing.push(name);
    const max = decl?.maxLength ?? PLACEHOLDER_CATALOG[name]?.maxLength;
    if (max && text.length > max) errors.push(`${name} is ${text.length} characters; max ${max}`);
    rendered.set(name, text);
  }
  if (missing.length) errors.push(`Missing required value(s): ${missing.join(', ')}`);

  const text = body.replace(TOKEN_RE, (raw, inner: string) => {
    const name = inner.trim();
    return rendered.has(name) ? rendered.get(name)! : raw;
  });
  return { text, missing, errors };
}
