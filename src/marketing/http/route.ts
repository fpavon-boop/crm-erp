import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { Prisma } from '@prisma/client';
import { requireMarketingAction, type MarketingAuthContext } from '@/marketing/security/guard';
import type { MarketingAction } from '@/marketing/security/rbac';
import { MarketingError } from '@/marketing/errors';
import { CampaignError } from '@/marketing/campaigns/errors';
import { MarketingAiError } from '@/marketing/ai/pipeline';

/**
 * One wrapper for every logged-in /api/marketing/* route:
 *
 *   1. requireMarketingAction(action): MARKETING_ENABLED kill switch (503),
 *      NextAuth session (401), role policy (403), and — for ADMIN-only
 *      actions — a fresh DB check that the user is still an active ADMIN.
 *   2. Body: JSON only, ≤ 256 KB, parse errors → 400. Query → plain object.
 *   3. Handler runs with the verified actor; services validate with Zod.
 *   4. Errors → status: Zod 400 · MarketingError/CampaignError their own
 *      status · Prisma not-found 404 / unique 409 · AI provider 502 ·
 *      anything else 500 with a generic message (details only in logs).
 */

export const MAX_BODY_BYTES = 256 * 1024;

export interface RouteContext<P extends Record<string, string>> {
  actor: MarketingAuthContext;
  body: unknown;
  query: Record<string, string>;
  params: P;
  req: Request;
}

type ActionFor<P extends Record<string, string>> = MarketingAction | ((body: unknown, params: P) => MarketingAction);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readBody(req: Request): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return {};
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
  if (!text.trim()) return {};
  const type = req.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError) return NextResponse.json({ error: 'Invalid input', code: 'INVALID_INPUT', details: err.flatten() }, { status: 400 });
  if (err instanceof MarketingError || err instanceof CampaignError) {
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status: err.httpStatus });
  }
  if (err instanceof MarketingAiError) {
    return NextResponse.json({ error: 'AI generation failed', code: `AI_${err.kind}`, logId: err.logId }, { status: 502 });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
    if (err.code === 'P2002') return NextResponse.json({ error: 'Already exists', code: 'CONFLICT' }, { status: 409 });
  }
  console.error('[marketing-api] unhandled error:', err);
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}

export function marketingRoute<P extends Record<string, string> = Record<string, never>>(
  action: ActionFor<P>,
  handler: (ctx: RouteContext<P>) => Promise<unknown>,
  options: { status?: number } = {}
) {
  return async (req: Request, context?: { params?: P }): Promise<NextResponse> => {
    try {
      const params = (context?.params ?? {}) as P;
      // Body first: the action can depend on it (e.g. the transition target).
      const body = await readBody(req);
      const resolved = typeof action === 'function' ? action(body, params) : action;
      const actor = await requireMarketingAction(resolved);
      if (actor instanceof NextResponse) return actor;
      const query = Object.fromEntries(new URL(req.url).searchParams.entries());
      const result = await handler({ actor, body, query, params, req });
      if (result instanceof NextResponse) return result;
      if (result === undefined) return new NextResponse(null, { status: 204 });
      return NextResponse.json(result, { status: options.status ?? 200 });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Parses query/body pieces the route itself owns (services validate the rest). */
export function parseWith<T>(schema: ZodType<T, any, unknown>, value: unknown): T {
  return schema.parse(value);
}

/** Maps a requested target status to the RBAC action the guard must check.
 * The services then enforce the full state machine. */
export function actionForTarget(body: unknown): MarketingAction {
  const to = (body as { to?: unknown } | null)?.to;
  switch (to) {
    case 'APPROVED':
      return 'approve';
    case 'REJECTED':
      return 'reject';
    case 'SCHEDULED':
      return 'schedule';
    case 'PUBLISHED':
      return 'publish';
    case 'REVIEW':
    case 'HUMAN_REVIEW':
      return 'submit_for_review';
    default:
      return 'draft';
  }
}

/** Query-string number (NaN on garbage, so the service's Zod schema rejects it with a 400). */
export function qInt(value: string | undefined): number | undefined {
  return value == null || value === '' ? undefined : Number(value);
}
