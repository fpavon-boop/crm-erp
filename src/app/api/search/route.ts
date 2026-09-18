import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiSession } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  const session = await requireApiSession();
  if (session instanceof NextResponse) return session;

  const q = req.nextUrl.searchParams.get('q')?.trim() || '';
  if (q.length < 2) return NextResponse.json({ results: [] });

  const [companies, contacts, invoices, orders, products] = await Promise.all([
    prisma.company.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      take: 5,
    }),
    prisma.contact.findMany({
      where: {
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 5,
    }),
    prisma.invoice.findMany({ where: { number: { contains: q, mode: 'insensitive' } }, take: 5 }),
    prisma.salesOrder.findMany({ where: { number: { contains: q, mode: 'insensitive' } }, take: 5 }),
    prisma.product.findMany({
      where: {
        OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }],
      },
      take: 5,
    }),
  ]);

  const results = [
    ...companies.map((c) => ({ type: 'company', id: c.id, label: c.name, href: `/companies/${c.id}` })),
    ...contacts.map((c) => ({
      type: 'contact',
      id: c.id,
      label: `${c.firstName} ${c.lastName}`,
      href: `/contacts/${c.id}`,
    })),
    ...invoices.map((i) => ({ type: 'invoice', id: i.id, label: i.number, href: `/invoicing/${i.id}` })),
    ...orders.map((o) => ({ type: 'order', id: o.id, label: o.number, href: `/sales/orders/${o.id}` })),
    ...products.map((p) => ({ type: 'product', id: p.id, label: `${p.name} (${p.sku})`, href: `/inventory/${p.id}` })),
  ];

  return NextResponse.json({ results });
}
