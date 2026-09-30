/**
 * Browser-side caller for the /api/marketing/* routes. Every mutation in the
 * marketing UI goes through here so errors (Zod details, safeguard blocks,
 * 403s from the ADMIN re-check) surface as one readable message.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

function describe(data: unknown, status: number): string {
  const d = (data ?? {}) as { error?: string; details?: unknown };
  const base = d.error || `Request failed (${status})`;
  const details = d.details as { formErrors?: string[]; fieldErrors?: Record<string, string[]> } | undefined;
  const parts: string[] = [];
  if (details?.formErrors?.length) parts.push(...details.formErrors);
  if (details?.fieldErrors) {
    for (const [field, msgs] of Object.entries(details.fieldErrors)) if (msgs?.length) parts.push(`${field}: ${msgs.join(', ')}`);
  }
  const issues = (d.details as { issues?: Array<{ message?: string }> } | undefined)?.issues;
  if (Array.isArray(issues)) parts.push(...issues.map((i) => i.message).filter((m): m is string => !!m));
  return parts.length ? `${base} — ${parts.join('; ')}` : base;
}

export async function callMarketingApi<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: 'Network error — please retry.' };
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) return { ok: false, status: res.status, error: describe(data, res.status) };
  return { ok: true, data: data as T };
}

/** `<input type="datetime-local">` value → ISO string (local time), or null when empty/invalid. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
