/**
 * Pure scene-sequence math. Scene order is always 1..n with no gaps or
 * duplicates; every mutation is planned here as a full list of
 * {id, order} assignments so persistence can apply it atomically.
 *
 * Durations are handled in integer centiseconds so 0.1 + 0.2 style float
 * drift can never make a 30.00s video read as 30.000000004s.
 */

export interface SequencedScene {
  id: string;
  order: number;
}

export class SequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceError';
  }
}

export function toCentiseconds(seconds: number): number {
  return Math.round(seconds * 100);
}

export function fromCentiseconds(cs: number): number {
  return cs / 100;
}

export function sortByOrder<T extends SequencedScene>(scenes: T[]): T[] {
  return [...scenes].sort((a, b) => a.order - b.order);
}

/** True when orders are exactly 1..n (in any array order). */
export function isContiguous(orders: number[]): boolean {
  const sorted = [...orders].sort((a, b) => a - b);
  return sorted.every((o, i) => o === i + 1);
}

function assign(ids: string[]): SequencedScene[] {
  return ids.map((id, i) => ({ id, order: i + 1 }));
}

/** Where a new scene lands and how existing scenes shift. `position` is
 * 1-based; default (or n+1) appends. */
export function planInsert(current: SequencedScene[], position?: number): { position: number; assignments: SequencedScene[] } {
  const ids = sortByOrder(current).map((s) => s.id);
  const pos = position ?? ids.length + 1;
  if (!Number.isInteger(pos) || pos < 1 || pos > ids.length + 1) {
    throw new SequenceError(`Position must be between 1 and ${ids.length + 1}`);
  }
  const assignments = assign(ids).map((a) => (a.order >= pos ? { ...a, order: a.order + 1 } : a));
  return { position: pos, assignments };
}

/** Full reorder: `orderedIds` must be an exact permutation of the current scenes. */
export function planReorder(current: SequencedScene[], orderedIds: string[]): SequencedScene[] {
  const existing = new Set(current.map((s) => s.id));
  const given = new Set(orderedIds);
  if (given.size !== orderedIds.length) throw new SequenceError('Scene ids must not repeat');
  if (given.size !== existing.size || orderedIds.some((id) => !existing.has(id))) {
    throw new SequenceError('Reorder must list every scene of the project exactly once');
  }
  return assign(orderedIds);
}

export function planMove(current: SequencedScene[], sceneId: string, toPosition: number): SequencedScene[] {
  const ids = sortByOrder(current).map((s) => s.id);
  const from = ids.indexOf(sceneId);
  if (from === -1) throw new SequenceError(`Scene ${sceneId} is not in this project`);
  if (!Number.isInteger(toPosition) || toPosition < 1 || toPosition > ids.length) {
    throw new SequenceError(`Position must be between 1 and ${ids.length}`);
  }
  ids.splice(from, 1);
  ids.splice(toPosition - 1, 0, sceneId);
  return assign(ids);
}

export function planRemove(current: SequencedScene[], sceneId: string): SequencedScene[] {
  const ids = sortByOrder(current).map((s) => s.id);
  if (!ids.includes(sceneId)) throw new SequenceError(`Scene ${sceneId} is not in this project`);
  return assign(ids.filter((id) => id !== sceneId));
}

/** Only the assignments whose order actually changes. */
export function changedAssignments(current: SequencedScene[], next: SequencedScene[]): SequencedScene[] {
  const before = new Map(current.map((s) => [s.id, s.order]));
  return next.filter((n) => before.get(n.id) !== n.order);
}

export interface TimelineEntry {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export function buildTimeline(scenes: Array<SequencedScene & { durationSec: number }>): { entries: TimelineEntry[]; totalMs: number } {
  let cursorCs = 0;
  const entries = sortByOrder(scenes).map((s, i) => {
    const cs = toCentiseconds(s.durationSec);
    const entry = { id: s.id, index: i + 1, startMs: cursorCs * 10, endMs: (cursorCs + cs) * 10, durationMs: cs * 10 };
    cursorCs += cs;
    return entry;
  });
  return { entries, totalMs: cursorCs * 10 };
}
