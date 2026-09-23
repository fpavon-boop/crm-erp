export { default } from 'next-auth/middleware';

export const config = {
  matcher: [
    /*
     * Protect everything except: api/auth, api/health, api/wordpress webhook,
     * api/whatsapp webhook, api/stripe webhook, login page, and static assets.
     */
    '/((?!api/auth|api/health|api/wordpress/leads/webhook|api/whatsapp/webhook|api/stripe/webhook|login|_next/static|_next/image|favicon.ico).*)',
  ],
};
