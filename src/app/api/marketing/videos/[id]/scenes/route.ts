import { z } from 'zod';
import { marketingRoute, parseWith } from '@/marketing/http/route';
import { addScene, reorderScenes } from '@/marketing/videos/video-service';

export const runtime = 'nodejs';
type P = { id: string };

const addSchema = z.object({ scene: z.record(z.unknown()), position: z.number().int().min(1).optional() }).strict();
const reorderSchema = z.object({ sceneIds: z.array(z.string().trim().min(1)).min(1).max(30) }).strict();

/** Add a scene ({ scene, position? }); later scenes shift to keep 1..n. */
export const POST = marketingRoute<P>(
  'draft',
  ({ actor, params, body }) => {
    const b = parseWith(addSchema, body);
    return addScene(params.id, b.scene, actor, { position: b.position });
  },
  { status: 201 }
);

/** Full reorder ({ sceneIds } — an exact permutation of the project's scenes). */
export const PUT = marketingRoute<P>('draft', async ({ actor, params, body }) => {
  await reorderScenes(params.id, parseWith(reorderSchema, body).sceneIds, actor);
});
