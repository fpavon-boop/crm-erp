import { prisma } from '@/lib/prisma';

interface WpPost {
  id: number;
  slug: string;
  link: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  content: { rendered: string };
  modified: string;
}

function authHeader(): Record<string, string> {
  const user = process.env.WORDPRESS_USERNAME;
  const pass = process.env.WORDPRESS_APP_PASSWORD;
  if (!user || !pass) return {};
  const token = Buffer.from(`${user}:${pass}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchAll(baseUrl: string, endpoint: string): Promise<WpPost[]> {
  const results: WpPost[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${baseUrl}/wp-json/wp/v2/${endpoint}?per_page=100&page=${page}`, {
      headers: authHeader(),
    });
    if (res.status === 400 || res.status === 404) break; // no more pages / endpoint absent
    if (!res.ok) throw new Error(`WordPress API error ${res.status} on ${endpoint}`);
    const batch = (await res.json()) as WpPost[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    results.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return results;
}

/**
 * Pulls pages, posts, and (if registered as custom post types) services/FAQs
 * from WordPress and upserts them into the local KnowledgeBaseArticle table.
 * Public content only — never crawls draft/private posts since the REST API
 * only exposes published content without authentication, and we don't
 * request private statuses even when authenticated.
 */
export async function syncWordPressSite(siteId: string): Promise<{ synced: number }> {
  const site = await prisma.wordPressSite.findUniqueOrThrow({ where: { id: siteId } });
  let synced = 0;

  const endpoints: Array<{ endpoint: string; type: 'PAGE' | 'POST' | 'FAQ' | 'SERVICE' }> = [
    { endpoint: 'pages', type: 'PAGE' },
    { endpoint: 'posts', type: 'POST' },
    { endpoint: 'faq', type: 'FAQ' }, // present only if a FAQ plugin/CPT registers it
    { endpoint: 'service', type: 'SERVICE' }, // present only if a Services CPT is registered
  ];

  for (const { endpoint, type } of endpoints) {
    let items: WpPost[] = [];
    try {
      items = await fetchAll(site.baseUrl, endpoint);
    } catch {
      continue; // endpoint not available on this site; skip silently
    }

    for (const item of items) {
      await prisma.knowledgeBaseArticle.upsert({
        where: {
          wordpressSiteId_wpId_type: { wordpressSiteId: site.id, wpId: item.id, type },
        },
        create: {
          wordpressSiteId: site.id,
          wpId: item.id,
          type,
          title: stripHtml(item.title?.rendered || ''),
          slug: item.slug,
          url: item.link,
          excerpt: stripHtml(item.excerpt?.rendered || ''),
          content: stripHtml(item.content?.rendered || ''),
          wpModifiedAt: item.modified ? new Date(item.modified) : null,
        },
        update: {
          title: stripHtml(item.title?.rendered || ''),
          url: item.link,
          excerpt: stripHtml(item.excerpt?.rendered || ''),
          content: stripHtml(item.content?.rendered || ''),
          wpModifiedAt: item.modified ? new Date(item.modified) : null,
          syncedAt: new Date(),
        },
      });
      synced += 1;
    }
  }

  await prisma.wordPressSite.update({
    where: { id: site.id },
    data: { lastSyncedAt: new Date() },
  });

  return { synced };
}

/**
 * Searches the synced knowledge base for terms relevant to a draft reply.
 * Used to assist staff drafting email/WhatsApp replies — results are
 * suggestions only; a human must review and approve before sending.
 */
export async function searchKnowledgeBase(query: string, limit = 5) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .slice(0, 6);

  if (terms.length === 0) return [];

  return prisma.knowledgeBaseArticle.findMany({
    where: {
      OR: terms.flatMap((term) => [
        { title: { contains: term, mode: 'insensitive' as const } },
        { content: { contains: term, mode: 'insensitive' as const } },
      ]),
    },
    take: limit,
    orderBy: { syncedAt: 'desc' },
  });
}
