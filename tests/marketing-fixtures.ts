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
