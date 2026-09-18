import { prisma } from '@/lib/prisma';
import { requireModule } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import PipelineBoard from './PipelineBoard';
import NewOpportunityForm from './NewOpportunityForm';

export default async function PipelinePage() {
  await requireModule('sales');
  const opportunities = await prisma.opportunity.findMany({
    include: { company: true, contact: true },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <div>
      <PageHeader title="Sales Pipeline" subtitle="Drag cards between stages to update them" />
      <NewOpportunityForm />
      <PipelineBoard
        initial={opportunities.map((o) => ({
          id: o.id,
          title: o.title,
          value: o.value.toString(),
          stage: o.stage,
          company: o.company ? { id: o.company.id, name: o.company.name } : null,
          contact: o.contact,
        }))}
      />
    </div>
  );
}
