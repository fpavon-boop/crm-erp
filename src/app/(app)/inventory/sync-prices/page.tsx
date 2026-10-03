import { redirect } from 'next/navigation';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import SyncPricesClient from './SyncPricesClient';

export default async function SyncPricesPage() {
  const session = await requireModule('inventory');
  if (session.user.role !== 'ADMIN') redirect('/inventory?denied=1');

  return (
    <div>
      <PageHeader
        title="Sync prices from Excel"
        subtitle="Upload the price list, review exactly what would change, then apply it."
        actions={
          <a href="/api/inventory/export?format=csv" className="btn-secondary">
            Download current catalog (CSV)
          </a>
        }
      />
      <SyncPricesClient />
    </div>
  );
}
