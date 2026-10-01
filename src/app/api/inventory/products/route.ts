import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { parsePage, pageWindow, totalPages } from '@/lib/pagination';
import type { Prisma, CatalogCategoryGroup } from '@prisma/client';

/** Lists CatalogProduct rows across every category (ovens, iron doors,
 * refractory materials, accessories, tools, stains/enhancers) with
 * optional search (partNo/productName/category), categoryGroup filtering,
 * and pagination, matching the pattern used by the Companies/Contacts/
 * Inventory list pages (see docs/SYSTEM_HARDENING.md F4). */
export async function GET(req: NextRequest) {
  const session = await requireApiModule('inventory');
  if (session instanceof NextResponse) return session;

  const q = req.nextUrl.searchParams.get('q')?.trim() || '';
  const category = req.nextUrl.searchParams.get('category')?.trim() || '';
  const categoryGroup = req.nextUrl.searchParams.get('categoryGroup')?.trim() as CatalogCategoryGroup | '' | null;
  const page = parsePage(req.nextUrl.searchParams.get('page') ?? undefined);

  const where: Prisma.CatalogProductWhereInput = {
    ...(category ? { category } : {}),
    ...(categoryGroup ? { categoryGroup } : {}),
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
    prisma.catalogProduct.findMany({
      where,
      orderBy: { productName: 'asc' },
      ...pageWindow(page),
    }),
    prisma.catalogProduct.count({ where }),
  ]);

  return NextResponse.json({ products, page, totalPages: totalPages(total), total });
}
