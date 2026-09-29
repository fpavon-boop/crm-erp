import { NextRequest, NextResponse } from 'next/server';
import { recordUnsubscribe, verifyUnsubscribeToken } from '@/marketing/audiences/unsubscribe';

export const runtime = 'nodejs';

/**
 * Public one-click unsubscribe (no login; authenticated by the signed token).
 * GET renders a single-button confirmation page and changes nothing (mail
 * scanners prefetch links); POST records the opt-out on the contact's CRM
 * timeline. See src/marketing/audiences/unsubscribe.ts.
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}button{font-size:1rem;padding:.75rem 1.5rem;border:0;border-radius:.5rem;background:#b5452a;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
  return new NextResponse(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' },
  });
}

const INVALID = page(
  'Link not valid',
  '<h1>This unsubscribe link is not valid or has expired.</h1><p>Reply STOP to any of our emails and we will remove you.</p><p lang="es">Responda BAJA a cualquiera de nuestros correos y le daremos de baja.</p>',
  400
);

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('t') ?? '';
  if (!verifyUnsubscribeToken(token)) return INVALID.clone();
  return page(
    'Unsubscribe',
    `<h1>Unsubscribe from marketing messages?</h1><p lang="es">¿Darse de baja de nuestros mensajes de marketing?</p>
<form method="post"><input type="hidden" name="t" value="${escapeHtml(token)}"><button type="submit">Unsubscribe / Darme de baja</button></form>`
  );
}

export async function POST(req: NextRequest) {
  let token = req.nextUrl.searchParams.get('t') ?? '';
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null);
    const t = form?.get('t');
    if (typeof t === 'string' && t) token = t;
  }
  const result = await recordUnsubscribe(token);
  if (!result.ok) return INVALID.clone();
  return page(
    'Unsubscribed',
    '<h1>You have been unsubscribed.</h1><p>You will not receive further marketing messages from us.</p><p lang="es">Se ha dado de baja. No recibirá más mensajes de marketing.</p>'
  );
}
