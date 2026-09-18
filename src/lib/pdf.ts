import PDFDocument from 'pdfkit';

export interface InvoicePdfData {
  number: string;
  type: string;
  issueDate: Date;
  dueDate?: Date | null;
  status: string;
  company?: { name: string; taxId?: string | null; addressLine1?: string | null; city?: string | null; country?: string | null } | null;
  contact?: { firstName: string; lastName: string; email?: string | null } | null;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    discount: number;
  }>;
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  total: number;
  amountPaid: number;
  notes?: string | null;
  businessName?: string;
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Renders a simple, clean invoice/estimate/receipt PDF and returns the buffer. */
export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text(data.businessName || 'Your Company', { continued: false });
      doc.moveDown(0.3);
      doc
        .fontSize(14)
        .fillColor('#444')
        .text(`${data.type} ${data.number}`);
      doc.fillColor('#000');
      doc.moveDown(1);

      doc.fontSize(10).fillColor('#555');
      doc.text(`Issue date: ${data.issueDate.toDateString()}`);
      if (data.dueDate) doc.text(`Due date: ${data.dueDate.toDateString()}`);
      doc.text(`Status: ${data.status}`);
      doc.fillColor('#000');
      doc.moveDown(1);

      if (data.company) {
        doc.fontSize(12).text('Bill to:', { underline: true });
        doc.fontSize(10).text(data.company.name);
        if (data.company.taxId) doc.text(`Tax ID: ${data.company.taxId}`);
        if (data.company.addressLine1) doc.text(data.company.addressLine1);
        const cityLine = [data.company.city, data.company.country].filter(Boolean).join(', ');
        if (cityLine) doc.text(cityLine);
        if (data.contact) doc.text(`Attn: ${data.contact.firstName} ${data.contact.lastName}`);
        doc.moveDown(1);
      }

      const tableTop = doc.y;
      const colX = { desc: 50, qty: 300, price: 360, tax: 420, total: 480 };
      doc.fontSize(10).fillColor('#fff').rect(50, tableTop, 495, 20).fill('#2563eb');
      doc.fillColor('#fff');
      doc.text('Description', colX.desc + 4, tableTop + 5);
      doc.text('Qty', colX.qty, tableTop + 5);
      doc.text('Price', colX.price, tableTop + 5);
      doc.text('Tax%', colX.tax, tableTop + 5);
      doc.text('Total', colX.total, tableTop + 5);
      doc.fillColor('#000');

      let y = tableTop + 25;
      for (const item of data.items) {
        const lineTotal =
          item.quantity * item.unitPrice * (1 + item.taxRate / 100) - item.discount;
        doc.fontSize(9);
        doc.text(item.description, colX.desc, y, { width: 240 });
        doc.text(String(item.quantity), colX.qty, y);
        doc.text(money(item.unitPrice), colX.price, y);
        doc.text(`${item.taxRate}%`, colX.tax, y);
        doc.text(money(lineTotal), colX.total, y);
        y += 20;
      }

      doc.moveTo(50, y).lineTo(545, y).strokeColor('#ddd').stroke();
      y += 10;

      const totalsX = 400;
      doc.fontSize(10);
      doc.text('Subtotal:', totalsX, y);
      doc.text(money(data.subtotal), 480, y);
      y += 16;
      doc.text('Tax:', totalsX, y);
      doc.text(money(data.taxTotal), 480, y);
      y += 16;
      doc.text('Discount:', totalsX, y);
      doc.text(`-${money(data.discountTotal)}`, 480, y);
      y += 16;
      doc.fontSize(12).text('Total:', totalsX, y);
      doc.text(money(data.total), 480, y);
      y += 16;
      if (data.amountPaid > 0) {
        doc.fontSize(10).text('Paid:', totalsX, y);
        doc.text(money(data.amountPaid), 480, y);
        y += 16;
        doc.fontSize(11).text('Balance due:', totalsX, y);
        doc.text(money(data.total - data.amountPaid), 480, y);
      }

      if (data.notes) {
        y += 40;
        doc.fontSize(9).fillColor('#555').text('Notes:', 50, y);
        doc.text(data.notes, 50, y + 14, { width: 495 });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
