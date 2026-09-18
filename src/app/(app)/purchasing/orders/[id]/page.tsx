import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Badge from '@/components/Badge';
import { money, formatDate } from '@/lib/format';
import ReceiveGoodsForm from './ReceiveGoodsForm';

export default async function PurchaseOrderDetailPage({ params }: { params: { id: string } }) {
  await requireModule('purchasing');
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: params.id },
    include: { supplier: true, items: true, goodsReceipts: { include: { items: true }, orderBy: { receivedAt: 'desc' } } },
  });
  if (!order) notFound();

  return (
    <div>
      <PageHeader title={order.number} subtitle={order.supplier?.name} />

      <div className="card p-6 mb-6">
        <p className="mb-4"><Badge label={order.status} /> <span className="text-sm text-slate-500 ml-2">Expected {formatDate(order.expectedDate)}</span></p>
        <table className="table-base">
          <thead><tr><th>Description</th><th>Ordered</th><th>Received</th><th>Unit cost</th></tr></thead>
          <tbody>
            {order.items.map((i) => (
              <tr key={i.id}>
                <td>{i.description}</td>
                <td>{i.quantity.toString()}</td>
                <td>{i.quantityReceived.toString()}</td>
                <td>{money(i.unitCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-right font-semibold mt-3">Total: {money(order.total)}</p>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="font-semibold text-slate-800 mb-3">Receive goods</h2>
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
      </div>

      <div className="card p-6">
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
    </div>
  );
}
