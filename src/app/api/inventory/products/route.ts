import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { parsePage, pageWindow, totalPages } from '@/lib/pagination';
import type { Prisma } from '@prisma/client';

/** Lists RefractoryProduct rows with optional search (partNo/productName/
 * category) and pagination, matching the pattern used by the Companies/
 * Contacts/Inventory list pages (see docs/SYSTEM_HARDENING.md F4). */
export async function GET(req: NextRequest) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const q = req.nextUrl.searchParams.get('q')?.trim() || '';
  const category = req.nextUrl.searchParams.get('category')?.trim() || '';
  const page = parsePage(req.nextUrl.searchParams.get('page') ?? undefined);

  const where: Prisma.RefractoryProductWhereInput = {
    ...(category ? { category } : {}),
    ...(q
      ? {
          OR: [
            { partNo: { contains: q, mode: 'insensitive' } },
            { productName: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [products, total] = await Promise.all([
    prisma.refractoryProduct.findMany({
      where,
      orderBy: { productName: 'asc' },
      ...pageWindow(page),
    }),
    prisma.refractoryProduct.count({ where }),
  ]);

  return NextResponse.json({ products, page, totalPages: totalPages(total), total });
}
