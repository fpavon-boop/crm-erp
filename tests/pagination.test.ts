import { describe, it, expect } from 'vitest';
import { parsePage, pageWindow, totalPages, DEFAULT_PAGE_SIZE } from '../src/lib/pagination';

/**
 * SYSTEM_AUDIT.md F4 (pagination on large list pages): pure unit tests for
 * the page-math primitives shared by the Companies/Contacts/Inventory
 * list pages and src/components/Pagination.tsx — no database needed.
 */
describe('parsePage', () => {
  it('defaults to 1 when the value is undefined', () => {
    expect(parsePage(undefined)).toBe(1);
  });

  it('parses a valid positive integer string', () => {
    expect(parsePage('3')).toBe(3);
  });

  it('defaults to 1 for zero, negative, fractional, or non-numeric input — never a negative page', () => {
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-5')).toBe(1);
    expect(parsePage('2.5')).toBe(1);
    expect(parsePage('not-a-number')).toBe(1);
    expect(parsePage('')).toBe(1);
  });
});

describe('pageWindow', () => {
  it('page 1 skips nothing', () => {
    expect(pageWindow(1, 25)).toEqual({ skip: 0, take: 25 });
  });

  it('page 3 skips two full pages', () => {
    expect(pageWindow(3, 25)).toEqual({ skip: 50, take: 25 });
  });

  it('defaults to DEFAULT_PAGE_SIZE when no page size is given', () => {
    expect(pageWindow(2)).toEqual({ skip: DEFAULT_PAGE_SIZE, take: DEFAULT_PAGE_SIZE });
  });
});

describe('totalPages', () => {
  it('is at least 1 even when there are zero rows — an empty list is still "page 1 of 1"', () => {
    expect(totalPages(0, 25)).toBe(1);
  });

  it('rounds up a partial final page', () => {
    expect(totalPages(51, 25)).toBe(3);
  });

  it('an exact multiple does not add a spurious extra page', () => {
    expect(totalPages(50, 25)).toBe(2);
  });
});
