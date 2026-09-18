import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import WarehouseForm from './WarehouseForm';

export default async function WarehousesPage() {
  await requireModule('inventory');
  const warehouses = await prisma.warehouse.findMany({ orderBy: { name: 'asc' } });

  return (
    <div>
      <PageHeader title="Warehouses" subtitle={`${warehouses.length} warehouses`} />
      <div className="card p-5 mb-6">
        <WarehouseForm />
      </div>
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Name</th><th>Address</th><th>Default</th></tr></thead>
          <tbody>
            {warehouses.map((w) => (
              <tr key={w.id}>
                <td className="font-medium">{w.name}</td>
                <td>{w.address || '—'}</td>
                <td>{w.isDefault && <Badge label="active" />}</td>
              </tr>
            ))}
            {warehouses.length === 0 && <tr><td colSpan={3} className="text-center text-slate-500 py-8">No warehouses yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
