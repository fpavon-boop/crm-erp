export function money(value: number | string | { toNumber?: () => number } | null | undefined): string {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? parseFloat(value)
        : value && typeof value.toNumber === 'function'
          ? value.toNumber()
          : 0;
  return (n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseFloat(value) || 0;
  if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
}
