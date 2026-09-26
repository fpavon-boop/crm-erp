import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import Pagination from '@/components/Pagination';
import { parsePage, pageWindow } from '@/lib/pagination';
import { money } from '@/lib/format';
import { Plus, Download, Warehouse } from 'lucide-react';

export default async function InventoryPage({ searchParams }: { searchParams: { q?: string; page?: string } }) {
  await requireModule('inventory');
  const q = searchParams.q?.trim();
  const page = parsePage(searchParams.page);

  const where = q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { sku: { contains: q, mode: 'insensitive' as const } }] } : undefined;

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: { variants: { include: { stockLevels: true } } },
      orderBy: { name: 'asc' },
      ...pageWindow(page),
    }),
    prisma.product.count({ where }),
  ]);

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle={`${total} products`}
        actions={
          <>
            <Link href="/inventory/warehouses" className="btn-secondary"><Warehouse size={16} /> Warehouses</Link>
            <a href={`/api/products?format=csv${q ? `&q=${q}` : ''}`} className="btn-secondary"><Download size={16} /> Export CSV</a>
            <Link href="/inventory/new" className="btn-primary"><Plus size={16} /> New Product</Link>
          </>
        }
      />

      <form className="card p-4 mb-4 flex gap-3" method="get">
        <input name="q" defaultValue={q} placeholder="Search by name or SKU..." className="input max-w-xs" />
        <button type="submit" className="btn-secondary">Filter</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th></tr></thead>
          <tbody>
            {products.map((p) => {
              const stock = p.variants.reduce((s, v) => s + v.stockLevels.reduce((ss, l) => ss + l.quantity, 0), 0);
              const low = p.trackInventory && stock <= p.reorderPoint;
              return (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="font-mono text-xs">{p.sku}</td>
                  <td><Link href={`/inventory/${p.id}`} className="font-medium text-brand-700 hover:underline">{p.name}</Link></td>
                  <td>{p.category || '—'}</td>
                  <td>{money(p.price)}</td>
                  <td>{p.trackInventory ? stock : '—'}</td>
                  <td>{low ? <Badge label="LOW_STOCK" /> : <Badge label={p.active ? 'active' : 'inactive'} />}</td>
                </tr>
              );
            })}
            {products.length === 0 && <tr><td colSpan={6} className="text-center text-slate-500 py-8">No products found.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={total} basePath="/inventory" searchParams={{ q }} />
    </div>
  );
}
