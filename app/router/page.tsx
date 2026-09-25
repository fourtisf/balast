import type { Metadata } from 'next';
import { RouterPanel } from '@/components/router/RouterPanel';
import { Masthead } from '@/components/shell/Masthead';

export const metadata: Metadata = { title: 'Router' };

export default function RouterPage() {
  return (
    <section>
      <Masthead
        eyebrow="Router · for token teams"
        title="Fees into liquidity"
        lede="Point your creator fees at the router and it turns them into permanent liquidity for your pool, on a schedule or at market-cap milestones."
      />
      <RouterPanel />
    </section>
  );
}
