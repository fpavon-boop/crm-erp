import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import ReceiveGoodsForm from './ReceiveGoodsForm';
import PurchaseOrderActions from './PurchaseOrderActions';

const RECEIVABLE_STATUSES = new Set(['SENT', 'PARTIALLY_RECEIVED']);

export default async function PurchaseOrderDetailPage({ params }: { params: { id: string } }) {
  await requireModule('purchasing');
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: params.id },
    include: {
      supplier: true,
      items: { include: { product: { select: { sku: true } } } },
      goodsReceipts: { include: { items: true }, orderBy: { receivedAt: 'desc' } },
      supplierInvoices: true,
    },
  });
  if (!order) notFound();

  const canReceive = RECEIVABLE_STATUSES.has(order.status);

  return (
    <div>
      <PageHeader title={order.number} subtitle={order.supplier?.name} />

      <div className="card p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <p><Badge label={order.status} /> <span className="text-sm text-slate-500 ml-2">Expected {formatDate(order.expectedDate)}</span></p>
          <PurchaseOrderActions purchaseOrderId={order.id} status={order.status} />
        </div>
        <table className="table-base">
          <thead><tr><th>SKU</th><th>Description</th><th className="text-right">Ordered</th><th className="text-right">Received</th><th className="text-right">Outstanding</th><th className="text-right">Unit cost</th></tr></thead>
          <tbody>
            {order.items.map((i) => (
              <tr key={i.id}>
                <td className="text-slate-500">{i.product?.sku || '—'}</td>
                <td>{i.description}</td>
                <td className="text-right">{i.quantity.toString()}</td>
                <td className="text-right">{i.quantityReceived.toString()}</td>
                <td className="text-right">{(Number(i.quantity) - Number(i.quantityReceived)).toString()}</td>
                <td className="text-right">{money(i.unitCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-right font-semibold mt-3">Total: {money(order.total)}</p>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="font-semibold text-slate-800 mb-3">Receive goods</h2>
        {canReceive ? (
          <ReceiveGoodsForm
            purchaseOrderId={order.id}
            items={order.items.map((i) => ({
              id: i.id,
              description: i.description,
              quantity: Number(i.quantity),
              quantityReceived: Number(i.quantityReceived),
              productId: i.productId,
              productVariantId: i.productVariantId,
            }))}
          />
        ) : order.status === 'DRAFT' ? (
          <p className="text-sm text-slate-400">This order must be approved &amp; sent before goods can be received.</p>
        ) : order.status === 'CANCELLED' ? (
          <p className="text-sm text-slate-400">This order was cancelled — goods can no longer be received against it.</p>
        ) : (
          <p className="text-sm text-slate-400">This order has been fully received.</p>
        )}
      </div>

      <div className="card p-6 mb-6">
        <h2 className="font-semibold text-slate-800 mb-3">Goods receipt history</h2>
        <ul className="text-sm space-y-2">
          {order.goodsReceipts.map((r) => (
            <li key={r.id} className="border-b border-slate-100 pb-2">
              {formatDate(r.receivedAt)} — {r.items.length} line(s) received
            </li>
          ))}
          {order.goodsReceipts.length === 0 && <p className="text-slate-400">No receipts yet.</p>}
        </ul>
      </div>

      <div className="card p-6">
        <h2 className="font-semibold text-slate-800 mb-3">Supplier invoices</h2>
        <ul className="text-sm space-y-2">
          {order.supplierInvoices.map((inv) => (
            <li key={inv.id} className="border-b border-slate-100 pb-2 flex items-center justify-between">
              <span>{inv.number} — {formatDate(inv.issueDate)}</span>
              <span className="flex items-center gap-2"><Badge label={inv.status} /> {money(inv.amount)}</span>
            </li>
          ))}
          {order.supplierInvoices.length === 0 && <p className="text-slate-400">No supplier invoices linked to this order yet.</p>}
        </ul>
      </div>
    </div>
  );
}
