import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import ExpensesClient from './ExpensesClient';

export const dynamic = 'force-dynamic';

export default async function ExpensesPage() {
  await requireModule('finance');
  const expenses = await prisma.expense.findMany({ orderBy: { expenseDate: 'desc' }, take: 500 });

  return (
    <div>
      <PageHeader title="Expenses" subtitle="Rent, fuel, tools, subscriptions and other company spending" />
      <ExpensesClient
        initial={expenses.map((e) => ({
          id: e.id,
          expenseDate: e.expenseDate.toISOString(),
          category: e.category,
          payee: e.payee,
          description: e.description,
          amount: Number(e.amount),
          method: e.method,
          reference: e.reference,
        }))}
      />
    </div>
  );
}
