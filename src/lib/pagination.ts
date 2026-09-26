/**
 * Shared pagination primitives for large list pages (SYSTEM_AUDIT.md F4)
 * — Companies, Contacts, and Inventory previously loaded and rendered
 * every matching row on every request. Pure, DB-agnostic math so it's
 * directly unit-testable without a database.
 */
export const DEFAULT_PAGE_SIZE = 25;

/** Parses a `?page=` search param into a valid 1-based page number,
 * defaulting to 1 for anything missing, non-numeric, zero, negative, or
 * fractional — never lets a malformed query string produce a negative
 * `skip` value. */
export function parsePage(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export interface PageWindow {
  skip: number;
  take: number;
}

/** The Prisma `skip`/`take` pair for a given 1-based page. */
export function pageWindow(page: number, pageSize: number = DEFAULT_PAGE_SIZE): PageWindow {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export function totalPages(total: number, pageSize: number = DEFAULT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
