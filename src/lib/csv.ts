/** Minimal, dependency-free CSV serializer (Excel-compatible, UTF-8 BOM). */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '';
  const cols = columns ?? Object.keys(rows[0]);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str =
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const header = cols.join(',');
  const body = rows.map((row) => cols.map((col) => escape(row[col])).join(',')).join('\n');
  return `﻿${header}\n${body}`;
}

export function csvResponse(filename: string, rows: Record<string, unknown>[], columns?: string[]) {
  const csv = toCsv(rows, columns);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
