import { marketingRoute } from '@/marketing/http/route';
import { generateContentPreview } from '@/marketing/content/generate';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** AI generation preview for one template ({ template, input, campaignId? }); schema-validated output + compliance; not persisted. */
export const POST = marketingRoute('draft', ({ actor, body }) => generateContentPreview(body, actor));
