import { marketingRoute } from '@/marketing/http/route';
import { createSocialAccount, listSocialAccounts } from '@/marketing/publishing/social-accounts';

export const runtime = 'nodejs';

export const GET = marketingRoute('view', ({ actor, query }) => listSocialAccounts({ platform: query.platform, status: query.status }, actor));

/** ADMIN only. Stores the n8n credential NAME, never a token. */
export const POST = marketingRoute('manage_accounts', ({ actor, body }) => createSocialAccount(body, actor), { status: 201 });
