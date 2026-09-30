import { requireMarketingViewer } from '@/marketing/http/page';
import MarketingTabs from '@/marketing/ui/MarketingTabs';

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  await requireMarketingViewer();
  return (
    <div>
      <MarketingTabs />
      {children}
    </div>
  );
}
