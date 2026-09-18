import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { searchKnowledgeBase } from '@/lib/wordpress/client';

/** Drafts a starting-point reply from the synced WordPress knowledge base.
 * This is a suggestion only — the user must review, edit, and explicitly
 * send it via POST /reply. Nothing is sent automatically. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireApiModule('inbox');
  if (session instanceof NextResponse) return session;

  const message = await prisma.emailMessage.findUnique({ where: { id: params.id } });
  if (!message) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const query = `${message.subject || ''} ${message.bodyText || ''}`.slice(0, 500);
  const articles = await searchKnowledgeBase(query, 3);

  const contextLines = articles.map((a) => `- ${a.title}: ${a.excerpt || a.content?.slice(0, 200) || ''} (${a.url})`);

  const draft = [
    'Hello,',
    '',
    'Thank you for reaching out.',
    '',
    ...(contextLines.length
      ? ['Based on our website, here is some information that may help:', ...contextLines, '']
      : []),
    '[Please edit this draft with a specific answer before sending.]',
    '',
    'Best regards,',
  ].join('\n');

  return NextResponse.json({ draft, sources: articles.map((a) => ({ title: a.title, url: a.url })) });
}
