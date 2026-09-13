import type { Metadata } from 'next';
import { RouterPanel } from '@/components/router/RouterPanel';

export const metadata: Metadata = { title: 'Router — Balast' };

export default function RouterPage() {
  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow" style={{ display: 'block', marginBottom: 12 }}>
            Router · for token teams
          </div>
          <h1>
            Turn creator fees into <em>permanent depth</em>.
          </h1>
          <p className="lede">
            For token teams. Point your fee wallet at the router and it buys back liquidity on a
            schedule or when you hit a market-cap milestone. TWAP priced, keeper triggered, funds
            never leave the contract.
          </p>
        </div>
      </div>
      <RouterPanel />
    </section>
  );
}
