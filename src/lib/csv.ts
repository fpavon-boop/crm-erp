// A cell whose text starts with one of these (OWASP's CSV-injection list)
// is interpreted as a formula by Excel/Sheets/Numbers when the exported
// file is opened, not rendered as plain text — e.g. a company name of
// "=cmd|'/c calc'!A0" or a note starting with "@SUM(...)" typed into a
// free-text field elsewhere in the app.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Minimal, dependency-free CSV serializer (Excel-compatible, UTF-8 BOM). */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '';
  const cols = columns ?? Object.keys(rows[0]);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let str =
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    // Neutralize formula injection by forcing the cell to plain text — a
    // leading apostrophe is the standard Excel-safe prefix (it's shown as
    // "force text", not rendered in the cell itself).
    if (FORMULA_TRIGGER.test(str)) {
      str = `'${str}`;
    }
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
