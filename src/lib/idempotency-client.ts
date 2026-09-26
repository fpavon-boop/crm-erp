/** Client-side idempotency-key generator, shared by every form that needs
 * to guarantee a network retry/double-submit can't repeat its own action
 * (Phase 13, docs/AUTOMATION_SYSTEM.md). Deliberately has no server-side
 * imports so it's safe in any 'use client' component. */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}
