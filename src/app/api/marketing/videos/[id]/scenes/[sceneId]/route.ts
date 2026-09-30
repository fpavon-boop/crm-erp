import { marketingRoute } from '@/marketing/http/route';
import { assertSceneInProject, moveScene, removeScene, updateScene } from '@/marketing/videos/video-service';

export const runtime = 'nodejs';
type P = { id: string; sceneId: string };

/** Update scene fields, or move it with { position } alone. */
export const PATCH = marketingRoute<P>('draft', async ({ actor, params, body }) => {
  await assertSceneInProject(params.sceneId, params.id);
  const b = (body ?? {}) as Record<string, unknown>;
  if (Object.keys(b).length === 1 && 'position' in b) {
    await moveScene(params.sceneId, Number(b.position), actor);
    return;
  }
  return updateScene(params.sceneId, b, actor);
});

export const DELETE = marketingRoute<P>('draft', async ({ actor, params }) => {
  await assertSceneInProject(params.sceneId, params.id);
  await removeScene(params.sceneId, actor);
});
