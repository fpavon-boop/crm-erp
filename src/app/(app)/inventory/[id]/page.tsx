import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDateTime } from '@/lib/format';
import AdjustStockForm from './AdjustStockForm';
import { Pencil } from 'lucide-react';

export default async function ProductDetailPage({ params }: { params: { id: string } }) {
  await requireModule('inventory');

  const [product, warehouses] = await Promise.all([
    prisma.product.findUnique({
      where: { id: params.id },
      include: {
        variants: {
          include: {
            stockLevels: { include: { warehouse: true } },
            movements: { orderBy: { createdAt: 'desc' }, take: 25, include: { warehouse: true } },
          },
        },
      },
    }),
    prisma.warehouse.findMany({ orderBy: { name: 'asc' } }),
  ]);
  if (!product) notFound();

  const totalStock = product.variants.reduce((s, v) => s + v.stockLevels.reduce((ss, l) => ss + l.quantity, 0), 0);
  const low = product.trackInventory && totalStock <= product.reorderPoint;

  return (
    <div>
      <PageHeader
        title={product.name}
        subtitle={`SKU ${product.sku}`}
        actions={
          <Link href={`/inventory/${product.id}/edit`} className="btn-secondary"><Pencil size={16} /> Edit</Link>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="card p-5">
          <p className="text-xs text-slate-500 mb-1">Price</p>
          <p className="text-2xl font-bold">{money(product.price)}</p>
        </div>
        <div className="card p-5">
          <p className="text-xs text-slate-500 mb-1">Total stock</p>
          <p className="text-2xl font-bold">{product.trackInventory ? totalStock : 'Not tracked'}</p>
          {low && <Badge label="LOW_STOCK" />}
        </div>
        <div className="card p-5">
          <p className="text-xs text-slate-500 mb-1">Reorder point</p>
          <p className="text-2xl font-bold">{product.reorderPoint}</p>
        </div>
      </div>

      <div className="card p-5 mb-6">
        <h2 className="font-semibold text-slate-800 mb-3">Stock by warehouse</h2>
        <table className="table-base">
          <thead><tr><th>Variant</th><th>Warehouse</th><th>Quantity</th></tr></thead>
          <tbody>
            {product.variants.flatMap((v) =>
              v.stockLevels.map((l) => (
                <tr key={l.id}>
                  <td>{v.name} <span className="text-xs text-slate-400">({v.sku})</span></td>
                  <td>{l.warehouse.name}</td>
                  <td className={l.quantity <= product.reorderPoint ? 'text-red-600 font-semibold' : ''}>{l.quantity}</td>
                </tr>
              ))
            )}
            {product.variants.every((v) => v.stockLevels.length === 0) && (
              <tr><td colSpan={3} className="text-center text-slate-500 py-6">No stock recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {warehouses.length > 0 && (
        <div className="card p-5 mb-6">
          <h2 className="font-semibold text-slate-800 mb-3">Adjust stock</h2>
          <AdjustStockForm
            variants={product.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku }))}
            warehouses={warehouses}
          />
        </div>
      )}

      <div className="card p-5">
        <h2 className="font-semibold text-slate-800 mb-3">Movement history</h2>
        <table className="table-base">
          <thead><tr><th>Date</th><th>Variant</th><th>Warehouse</th><th>Type</th><th>Qty</th><th>Reason</th></tr></thead>
          <tbody>
            {product.variants.flatMap((v) => v.movements.map((m) => ({ ...m, variantName: v.name }))).sort((a, b) => +b.createdAt - +a.createdAt).slice(0, 30).map((m) => (
              <tr key={m.id}>
                <td>{formatDateTime(m.createdAt)}</td>
                <td>{m.variantName}</td>
                <td>{m.warehouse.name}</td>
                <td><Badge label={m.type} /></td>
                <td>{m.quantity}</td>
                <td className="text-slate-500">{m.reason || '—'}</td>
              </tr>
            ))}
            {product.variants.every((v) => v.movements.length === 0) && (
              <tr><td colSpan={6} className="text-center text-slate-500 py-6">No stock movements yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
