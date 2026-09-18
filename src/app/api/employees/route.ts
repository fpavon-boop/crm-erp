import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiModule } from '@/lib/api-auth';
import { employeeSchema } from '@/lib/validation';
import { csvResponse } from '@/lib/csv';

export async function GET(req: NextRequest) {
  const session = await requireApiModule('employees');
  if (session instanceof NextResponse) return session;

  const format = req.nextUrl.searchParams.get('format');
  const employees = await prisma.employee.findMany({ orderBy: { firstName: 'asc' } });

  if (format === 'csv') {
    return csvResponse('employees.csv', employees.map((e) => ({
      firstName: e.firstName,
      lastName: e.lastName,
      email: e.email,
      phone: e.phone,
      position: e.position,
      department: e.department,
      hireDate: e.hireDate,
      active: e.active,
    })));
  }

  return NextResponse.json({ employees });
}

export async function POST(req: NextRequest) {
  const session = await requireApiModule('employees');
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const parsed = employeeSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const employee = await prisma.employee.create({
    data: {
      ...parsed.data,
      hireDate: parsed.data.hireDate ? new Date(parsed.data.hireDate) : null,
    },
  });
  return NextResponse.json({ employee }, { status: 201 });
}
