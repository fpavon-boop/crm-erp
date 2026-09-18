interface LineItem {
  quantity: number;
  unitPrice: number;
  taxRate: number;
  discount: number;
}

export function computeTotals(items: LineItem[]) {
  let subtotal = 0;
  let taxTotal = 0;
  let discountTotal = 0;

  for (const item of items) {
    const lineBase = item.quantity * item.unitPrice;
    subtotal += lineBase;
    taxTotal += lineBase * (item.taxRate / 100);
    discountTotal += item.discount;
  }

  const total = subtotal + taxTotal - discountTotal;
  return {
    subtotal: round2(subtotal),
    taxTotal: round2(taxTotal),
    discountTotal: round2(discountTotal),
    total: round2(total),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
