import { marketingRoute } from '@/marketing/http/route';
import { updateSocialAccount } from '@/marketing/publishing/social-accounts';

export const runtime = 'nodejs';

/** ADMIN only: handle / display name / credential ref / status (no deletes — posts reference accounts). */
export const PATCH = marketingRoute<{ id: string }>('manage_accounts', ({ actor, params, body }) => updateSocialAccount(params.id, body, actor));
