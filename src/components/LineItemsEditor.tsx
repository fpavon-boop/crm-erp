'use client';

import { useEffect, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';

export interface LineItem {
  productId?: string | null;
  productVariantId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  discount: number;
}

interface ProductOption {
  id: string;
  name: string;
  sku: string;
  price: number;
  taxRate: number;
  variants: { id: string; name: string; sku: string }[];
}

export const EMPTY_LINE_ITEM: LineItem = {
  description: '',
  quantity: 1,
  unitPrice: 0,
  taxRate: 0,
  discount: 0,
};

/** Shared editable line-item table for quotes, sales orders, invoices, and
 * purchase orders. `costLabel` swaps "Unit price" for "Unit cost" on POs, and
 * `hideTax`/`hideDiscount` trims columns that purchase orders don't use. */
export default function LineItemsEditor({
  items,
  onChange,
  costLabel = 'Unit price',
  hideTax = false,
  hideDiscount = false,
}: {
  items: LineItem[];
  onChange: (items: LineItem[]) => void;
  costLabel?: string;
  hideTax?: boolean;
  hideDiscount?: boolean;
}) {
  const [products, setProducts] = useState<ProductOption[]>([]);

  useEffect(() => {
    fetch('/api/products')
      .then((r) => r.json())
      .then((d) =>
        setProducts(
          (d.products || []).map((p: { id: string; name: string; sku: string; price: string; taxRate: string; variants: { id: string; name: string; sku: string }[] }) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            price: Number(p.price),
            taxRate: Number(p.taxRate),
            variants: p.variants,
          }))
        )
      );
  }, []);

  function update(index: number, patch: Partial<LineItem>) {
    const next = items.slice();
    next[index] = { ...next[index], ...patch };
    onChange(next);
  }

  function addRow() {
    onChange([...items, { ...EMPTY_LINE_ITEM }]);
  }

  function removeRow(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function applyProduct(index: number, productId: string) {
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    update(index, {
      productId: product.id,
      productVariantId: product.variants[0]?.id || null,
      description: product.name,
      unitPrice: product.price,
      taxRate: hideTax ? 0 : product.taxRate,
    });
  }

  const cols = 2 + 1 + (hideTax ? 0 : 1) + (hideDiscount ? 0 : 1) + 1 + 1;

  return (
    <div>
      <table className="table-base">
        <thead>
          <tr>
            <th>Product</th>
            <th>Description</th>
            <th className="w-20">Qty</th>
            <th className="w-28">{costLabel}</th>
            {!hideTax && <th className="w-20">Tax %</th>}
            {!hideDiscount && <th className="w-24">Discount</th>}
            <th className="w-28">Line total</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => {
            const lineTotal =
              item.quantity * item.unitPrice * (1 + (hideTax ? 0 : item.taxRate) / 100) - (hideDiscount ? 0 : item.discount);
            return (
              <tr key={i}>
                <td>
                  <select className="input" defaultValue="" onChange={(e) => e.target.value && applyProduct(i, e.target.value)}>
                    <option value="">— manual —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input className="input" value={item.description} onChange={(e) => update(i, { description: e.target.value })} required />
                </td>
                <td>
                  <input type="number" step="0.01" className="input" value={item.quantity} onChange={(e) => update(i, { quantity: Number(e.target.value) })} />
                </td>
                <td>
                  <input type="number" step="0.01" className="input" value={item.unitPrice} onChange={(e) => update(i, { unitPrice: Number(e.target.value) })} />
                </td>
                {!hideTax && (
                  <td>
                    <input type="number" step="0.01" className="input" value={item.taxRate} onChange={(e) => update(i, { taxRate: Number(e.target.value) })} />
                  </td>
                )}
                {!hideDiscount && (
                  <td>
                    <input type="number" step="0.01" className="input" value={item.discount} onChange={(e) => update(i, { discount: Number(e.target.value) })} />
                  </td>
                )}
                <td className="text-right font-medium">${lineTotal.toFixed(2)}</td>
                <td>
                  <button type="button" onClick={() => removeRow(i)} className="text-red-500 hover:text-red-700">
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr><td colSpan={cols} className="text-center text-slate-400 py-4">No line items yet.</td></tr>
          )}
        </tbody>
      </table>
      <button type="button" onClick={addRow} className="btn-secondary mt-3">
        <Plus size={16} /> Add line
      </button>
    </div>
  );
}
