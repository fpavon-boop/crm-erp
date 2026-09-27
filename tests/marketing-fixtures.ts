import {
  brandProfileInputSchema,
  toBrandContext,
  toProfileWriteData,
  type BrandContext,
  type BrandProfileInput,
} from '../src/marketing/content/brand-profile';

/** Shared EN/ES brand fixture for marketing unit tests (no DB). */
export const brandInput: BrandProfileInput = {
  name: 'CT Brick Oven Supply',
  isDefault: true,
  primaryLanguage: 'EN',
  bannedPhrases: ['cheap', 'knock-off'],
  defaultHashtags: ['#BrickOven'],
  colorPalette: [{ name: 'Ember', hex: '#B5452A', role: 'primary' }],
  locales: {
    EN: { voice: 'Expert craftsman', tone: 'Warm, confident', bannedPhrases: ['hot deal'], requiredDisclaimer: 'Prices subject to change.' },
    ES: { voice: 'Artesano experto', tone: 'Cálido y seguro', bannedPhrases: ['ganga'], requiredDisclaimer: 'Precios sujetos a cambios.' },
  },
  terms: [
    {
      conceptKey: 'brick-oven',
      EN: { term: 'brick oven', discouraged: ['stone stove'] },
      ES: { term: 'horno de ladrillo', discouraged: ['horno de piedra'] },
    },
  ],
};

export function makeBrand(input: BrandProfileInput = brandInput): BrandContext {
  const data = toProfileWriteData(brandProfileInputSchema.parse(input));
  const now = new Date();
  return toBrandContext({
    id: 'bp1',
    ...data.scalars,
    colorPalette: data.scalars.colorPalette as never,
    active: true,
    createdById: null,
    createdAt: now,
    updatedAt: now,
    locales: data.locales.map((l, n) => ({ id: `l${n}`, brandProfileId: 'bp1', createdAt: now, updatedAt: now, ...l })),
    terms: data.terms.map((t, n) => ({ id: `t${n}`, brandProfileId: 'bp1', createdAt: now, ...t })),
  });
}

// ---------------------------------------------------------------------------
// Scripted LLM adapter: reply is chosen per request (string, Error, or fn).
// ---------------------------------------------------------------------------
import { BaseProviderAdapter, type TextRequest, type TextResponse } from '../src/marketing/ai/provider';

export class ScriptedAdapter extends BaseProviderAdapter {
  readonly name = 'mock';
  readonly model: string;
  readonly requests: TextRequest[] = [];
  constructor(
    private reply: (req: TextRequest, n: number) => string | Error,
    model = 'mock-1'
  ) {
    super();
    this.model = model;
  }
  isConfigured() {
    return true;
  }
  async generateText(req: TextRequest): Promise<TextResponse> {
    this.requests.push(req);
    const r = this.reply(req, this.requests.length);
    if (r instanceof Error) throw r;
    return { text: r, provider: this.name, model: this.model, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, requestId: null };
  }
}

// ---------------------------------------------------------------------------
// Minimal in-memory Prisma model (create/find/update/count with the filter
// operators the marketing services use: equality, null, in, has, not).
// ---------------------------------------------------------------------------
type FakeRow = Record<string, any>;

export function fakeMatches(row: FakeRow, where: FakeRow = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('in' in cond) return cond.in.includes(v);
      if ('has' in cond) return Array.isArray(v) && v.includes(cond.has);
      if ('not' in cond) return v !== cond.not;
    }
    return (v ?? null) === cond;
  });
}

export function fakeModel(prefix: string, defaults: FakeRow = {}) {
  const rows = new Map<string, FakeRow>();
  let seq = 0;
  const pick = (r: FakeRow | undefined) => (r ? { ...r } : null);
  return {
    rows,
    create: async ({ data }: FakeRow) => {
      const row = { id: `${prefix}_${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...defaults, ...data };
      rows.set(row.id, row);
      return { ...row };
    },
    findUnique: async ({ where }: FakeRow) => pick(rows.get(where.id)),
    findFirst: async ({ where }: FakeRow) => pick([...rows.values()].find((r) => fakeMatches(r, where))),
    findMany: async ({ where, skip = 0, take }: FakeRow) =>
      [...rows.values()].filter((r) => fakeMatches(r, where)).slice(skip, take ? skip + take : undefined).map((r) => ({ ...r })),
    count: async ({ where }: FakeRow) => [...rows.values()].filter((r) => fakeMatches(r, where)).length,
    update: async ({ where, data }: FakeRow) => {
      const row = rows.get(where.id);
      if (!row) throw new Error(`${prefix} ${where.id} not found`);
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
  };
}
