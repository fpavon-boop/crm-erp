import { describe, it, expect } from 'vitest';
import { toCsv } from '../src/lib/csv';

/**
 * Phase 8 (SYSTEM_AUDIT.md E1): CSV formula-injection neutralization. A
 * cell whose text begins with `=`, `+`, `-`, `@`, tab, or carriage return
 * is interpreted as a formula by Excel/Sheets/Numbers when the exported
 * file is opened — a company name, note, or any other free-text field a
 * user typed must never reach the export unescaped.
 */
describe('toCsv formula-injection neutralization', () => {
  it('prefixes a cell starting with "=" so it is never read as a formula', () => {
    const csv = toCsv([{ name: '=cmd|"/c calc"!A0' }]);
    expect(csv).toContain(`'=cmd|"/c calc"!A0`.replace(/"/g, '""'));
    expect(csv).not.toMatch(/\n=cmd/); // never appears as a raw, unprefixed formula
  });

  it.each(['=SUM(A1:A9)', '+1+1', '-1+1', '@SUM(1,2)', '\tmalicious', '\rmalicious'])(
    'neutralizes a cell starting with %j',
    (value) => {
      const csv = toCsv([{ note: value }]);
      const lines = csv.split('\n');
      const dataLine = lines[1];
      // The raw trigger character must never be the first character of the
      // cell's actual content in the output.
      expect(dataLine.replace(/^"|"$/g, '')[0]).toBe("'");
    }
  );

  it('does not alter a normal value that happens to contain one of the trigger characters mid-string', () => {
    const csv = toCsv([{ name: 'Acme + Co' }]);
    expect(csv).toContain('Acme + Co');
    expect(csv).not.toContain("'Acme + Co");
  });

  it('still quotes a value containing a comma, after neutralization', () => {
    const csv = toCsv([{ note: '=A1,B1' }]);
    const lines = csv.split('\n');
    expect(lines[1]).toBe(`"'=A1,B1"`);
  });

  it('leaves null/undefined as an empty cell, not a literal "null"/"undefined" string', () => {
    const csv = toCsv([{ a: null, b: undefined }], ['a', 'b']);
    const lines = csv.split('\n');
    expect(lines[1]).toBe(',');
  });

  it('round-trips a normal row unaffected by the injection fix', () => {
    const csv = toCsv([{ number: 'INV-2026-0001', total: 149.99 }]);
    expect(csv).toContain('INV-2026-0001,149.99');
  });
});
