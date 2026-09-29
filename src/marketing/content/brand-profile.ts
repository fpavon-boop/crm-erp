import { z } from 'zod';
import { Prisma, type MarketingLanguage } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * MarketingBrandProfile management: validation, persistence, and the
 * normalized BrandContext every prompt builder and validator consumes.
 *
 * Every profile MUST carry both an EN and an ES definition (voice, tone,
 * banned phrases, optional tagline/guidelines/disclaimer) and every glossary
 * concept MUST have both an EN and an ES term — a one-sided entry is a
 * validation error, never silently accepted.
 *
 * Writes touch only MarketingBrandProfile / MarketingBrandLocale /
 * MarketingBrandTerm. Callers (API routes) must gate writes with
 * requireMarketingAction('manage_brand') — ADMIN only.
 */

export const LANGUAGES = ['EN', 'ES'] as const satisfies readonly MarketingLanguage[];

const phrase = z.string().trim().min(1).max(120);
const PALETTE_ROLES = ['primary', 'secondary', 'accent', 'background', 'text'] as const;

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLocaleLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

const phraseList = (max: number) => z.array(phrase).max(max).default([]).transform(dedupeCaseInsensitive);

const localeSchema = z.object({
  voice: z.string().trim().min(1).max(500),
  tone: z.string().trim().min(1).max(500),
  tagline: z.string().trim().max(200).optional(),
  guidelines: z.string().trim().max(5000).optional(),
  bannedPhrases: phraseList(200),
  requiredDisclaimer: z.string().trim().max(500).optional(),
});

const termSideSchema = z.object({
  term: phrase,
  discouraged: phraseList(20),
});

const termSchema = z
  .object({
    conceptKey: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'conceptKey must be a lowercase slug'),
    EN: termSideSchema,
    ES: termSideSchema,
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((t, ctx) => {
    for (const lang of LANGUAGES) {
      const approved = t[lang].term.toLocaleLowerCase();
      if (t[lang].discouraged.some((d) => d.toLocaleLowerCase() === approved)) {
        ctx.addIssue({ code: 'custom', path: [lang, 'discouraged'], message: 'A term cannot discourage itself' });
      }
    }
  });

const paletteColorSchema = z.object({
  name: z.string().trim().min(1).max(40),
  hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'hex must be #RRGGBB')
    .transform((h) => h.toUpperCase()),
  role: z.enum(PALETTE_ROLES),
});

export const brandProfileInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    isDefault: z.boolean().default(false),
    primaryLanguage: z.enum(LANGUAGES).default('EN'),
    voice: z.string().trim().max(500).optional(),
    tone: z.string().trim().max(500).optional(),
    targetAudience: z.string().trim().max(500).optional(),
    guidelines: z.string().trim().max(5000).optional(),
    bannedPhrases: phraseList(200),
    defaultHashtags: z
      .array(z.string().trim().regex(/^#[\p{L}\p{N}_]{1,60}$/u, 'hashtags must look like #word'))
      .max(30)
      .default([])
      .transform(dedupeCaseInsensitive),
    colorPalette: z.array(paletteColorSchema).max(12).default([]),
    logoUrl: z.string().url().startsWith('https://').optional(),
    /** Physical postal address for marketing email footers (CAN-SPAM). */
    postalAddress: z.string().trim().min(10).max(300).optional(),
    locales: z.object({ EN: localeSchema, ES: localeSchema }),
    terms: z.array(termSchema).max(500).default([]),
  })
  .superRefine((p, ctx) => {
    for (const role of ['primary', 'secondary'] as const) {
      if (p.colorPalette.filter((c) => c.role === role).length > 1) {
        ctx.addIssue({ code: 'custom', path: ['colorPalette'], message: `Only one ${role} color is allowed` });
      }
    }

    const keys = new Set<string>();
    p.terms.forEach((t, i) => {
      if (keys.has(t.conceptKey)) {
        ctx.addIssue({ code: 'custom', path: ['terms', i, 'conceptKey'], message: `Duplicate conceptKey "${t.conceptKey}"` });
      }
      keys.add(t.conceptKey);
    });

    // An approved term that is also banned would make every compliant draft
    // fail validation — reject the contradiction at save time.
    for (const lang of LANGUAGES) {
      const banned = new Set([...p.bannedPhrases, ...p.locales[lang].bannedPhrases].map((b) => b.toLocaleLowerCase()));
      p.terms.forEach((t, i) => {
        if (banned.has(t[lang].term.toLocaleLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            path: ['terms', i, lang, 'term'],
            message: `Approved term "${t[lang].term}" is also banned`,
          });
        }
      });
    }
  });

export type BrandProfileInput = z.input<typeof brandProfileInputSchema>;
type ParsedBrandProfile = z.output<typeof brandProfileInputSchema>;

// =============================================================================
// Normalized context
// =============================================================================

export interface PaletteColor {
  name: string;
  hex: string;
  role: (typeof PALETTE_ROLES)[number];
}

export interface BrandLocaleDefinition {
  voice: string;
  tone: string;
  tagline: string | null;
  guidelines: string | null;
  bannedPhrases: string[];
  requiredDisclaimer: string | null;
}

export interface BrandTermDefinition {
  conceptKey: string;
  term: string;
  discouraged: string[];
}

export interface BrandContext {
  id: string;
  name: string;
  isDefault: boolean;
  active: boolean;
  primaryLanguage: MarketingLanguage;
  voice: string | null;
  tone: string | null;
  targetAudience: string | null;
  guidelines: string | null;
  /** Applies to every language. */
  bannedPhrases: string[];
  defaultHashtags: string[];
  colorPalette: PaletteColor[];
  logoUrl: string | null;
  postalAddress: string | null;
  locales: Record<MarketingLanguage, BrandLocaleDefinition>;
  terms: Record<MarketingLanguage, BrandTermDefinition[]>;
}

export class BrandProfileIncompleteError extends Error {
  constructor(id: string, missing: MarketingLanguage) {
    super(`Brand profile ${id} has no ${missing} definition`);
    this.name = 'BrandProfileIncompleteError';
  }
}

export class BrandProfileNotFoundError extends Error {
  constructor(id: string) {
    super(`Brand profile ${id} not found`);
    this.name = 'BrandProfileNotFoundError';
  }
}

const include = { locales: true, terms: true } satisfies Prisma.MarketingBrandProfileInclude;
type ProfileRow = Prisma.MarketingBrandProfileGetPayload<{ include: typeof include }>;

function parsePalette(value: Prisma.JsonValue | null): PaletteColor[] {
  const parsed = z.array(paletteColorSchema).safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/** Pure: DB row → BrandContext. Throws if either language is missing, so a
 * half-configured profile can never reach a prompt. */
export function toBrandContext(row: ProfileRow): BrandContext {
  const locales = {} as Record<MarketingLanguage, BrandLocaleDefinition>;
  for (const lang of LANGUAGES) {
    const l = row.locales.find((x) => x.language === lang);
    if (!l) throw new BrandProfileIncompleteError(row.id, lang);
    locales[lang] = {
      voice: l.voice,
      tone: l.tone,
      tagline: l.tagline,
      guidelines: l.guidelines,
      bannedPhrases: l.bannedPhrases,
      requiredDisclaimer: l.requiredDisclaimer,
    };
  }
  const terms = { EN: [], ES: [] } as Record<MarketingLanguage, BrandTermDefinition[]>;
  for (const t of [...row.terms].sort((a, b) => a.conceptKey.localeCompare(b.conceptKey))) {
    terms[t.language].push({ conceptKey: t.conceptKey, term: t.term, discouraged: t.discouraged });
  }
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    active: row.active,
    primaryLanguage: row.primaryLanguage,
    voice: row.voice,
    tone: row.tone,
    targetAudience: row.targetAudience,
    guidelines: row.guidelines,
    bannedPhrases: row.bannedPhrases,
    defaultHashtags: row.defaultHashtags,
    colorPalette: parsePalette(row.colorPalette),
    logoUrl: row.logoUrl,
    postalAddress: row.postalAddress,
    locales,
    terms,
  };
}

/** Pure: validated input → the column/nested-write payload shared by create
 * and update. Exported for tests. */
export function toProfileWriteData(p: ParsedBrandProfile) {
  const color = (role: PaletteColor['role']) => p.colorPalette.find((c) => c.role === role)?.hex ?? null;
  return {
    scalars: {
      name: p.name,
      isDefault: p.isDefault,
      primaryLanguage: p.primaryLanguage,
      voice: p.voice ?? null,
      tone: p.tone ?? null,
      targetAudience: p.targetAudience ?? null,
      guidelines: p.guidelines ?? null,
      bannedPhrases: p.bannedPhrases,
      defaultHashtags: p.defaultHashtags,
      colorPalette: p.colorPalette as unknown as Prisma.InputJsonValue,
      primaryColor: color('primary'),
      secondaryColor: color('secondary'),
      logoUrl: p.logoUrl ?? null,
      postalAddress: p.postalAddress ?? null,
    },
    locales: LANGUAGES.map((language) => ({
      language,
      voice: p.locales[language].voice,
      tone: p.locales[language].tone,
      tagline: p.locales[language].tagline ?? null,
      guidelines: p.locales[language].guidelines ?? null,
      bannedPhrases: p.locales[language].bannedPhrases,
      requiredDisclaimer: p.locales[language].requiredDisclaimer ?? null,
    })),
    terms: p.terms.flatMap((t) =>
      LANGUAGES.map((language) => ({
        conceptKey: t.conceptKey,
        language,
        term: t[language].term,
        discouraged: t[language].discouraged,
        notes: t.notes ?? null,
      }))
    ),
  };
}

type Db = Pick<typeof prisma, 'marketingBrandProfile' | '$transaction'>;

// =============================================================================
// Service
// =============================================================================

/** Throws a ZodError on invalid input. */
export async function createBrandProfile(input: unknown, actorUserId: string | null, db: Db = prisma): Promise<BrandContext> {
  const parsed = brandProfileInputSchema.parse(input);
  const data = toProfileWriteData(parsed);
  const row = await db.$transaction(async (tx) => {
    if (parsed.isDefault) {
      await tx.marketingBrandProfile.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    return tx.marketingBrandProfile.create({
      data: {
        ...data.scalars,
        createdById: actorUserId,
        locales: { create: data.locales },
        terms: { create: data.terms },
      },
      include,
    });
  });
  return toBrandContext(row);
}

/** Full replacement of a profile's definition (locales and glossary are
 * rewritten atomically). */
export async function updateBrandProfile(id: string, input: unknown, db: Db = prisma): Promise<BrandContext> {
  const parsed = brandProfileInputSchema.parse(input);
  const data = toProfileWriteData(parsed);
  const row = await db.$transaction(async (tx) => {
    const existing = await tx.marketingBrandProfile.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new BrandProfileNotFoundError(id);
    if (parsed.isDefault) {
      await tx.marketingBrandProfile.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
    }
    return tx.marketingBrandProfile.update({
      where: { id },
      data: {
        ...data.scalars,
        locales: { deleteMany: {}, create: data.locales },
        terms: { deleteMany: {}, create: data.terms },
      },
      include,
    });
  });
  return toBrandContext(row);
}

/** Soft delete: profiles referenced by past campaigns are kept for history. */
export async function archiveBrandProfile(id: string, db: Db = prisma): Promise<void> {
  await db.marketingBrandProfile.update({ where: { id }, data: { active: false, isDefault: false } });
}

export async function getBrandProfile(id: string, db: Db = prisma): Promise<BrandContext | null> {
  const row = await db.marketingBrandProfile.findUnique({ where: { id }, include });
  return row ? toBrandContext(row) : null;
}

export async function getDefaultBrandProfile(db: Db = prisma): Promise<BrandContext | null> {
  const row = await db.marketingBrandProfile.findFirst({ where: { isDefault: true, active: true }, include });
  return row ? toBrandContext(row) : null;
}

export async function listBrandProfiles(
  options: { includeInactive?: boolean } = {},
  db: Db = prisma
): Promise<BrandContext[]> {
  const rows = await db.marketingBrandProfile.findMany({
    where: options.includeInactive ? {} : { active: true },
    include,
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });
  return rows.map(toBrandContext);
}
