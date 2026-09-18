import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import WordPressSettingsClient from './WordPressSettingsClient';

export default async function WordPressSettingsPage() {
  await requireModule('wordpress');
  const sites = await prisma.wordPressSite.findMany({ orderBy: { name: 'asc' } });

  return (
    <div>
      <PageHeader title="WordPress Settings" />
      <WordPressSettingsClient
        initial={sites.map((s) => ({
          id: s.id,
          name: s.name,
          baseUrl: s.baseUrl,
          lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.toISOString() : null,
          syncEnabled: s.syncEnabled,
        }))}
      />
    </div>
  );
}
