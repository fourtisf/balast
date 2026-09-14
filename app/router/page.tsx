import type { Metadata } from 'next';
import { RouterPanel } from '@/components/router/RouterPanel';
import { Masthead } from '@/components/shell/Masthead';

export const metadata: Metadata = { title: 'Router — Balast' };

export default function RouterPage() {
  return (
    <section>
      <Masthead
        eyebrow="Router · for token teams"
        title={
          <>
            Turn creator fees into <em>permanent depth</em>.
          </>
        }
        lede="For token teams. Point your fee wallet at the router and it buys back liquidity on a schedule or when you hit a market-cap milestone. TWAP priced, keeper triggered, funds never leave the contract."
      />
      <RouterPanel />
    </section>
  );
}
