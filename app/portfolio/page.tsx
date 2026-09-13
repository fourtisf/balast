import type { Metadata } from 'next';
import { PortfolioBody } from '@/components/portfolio/PortfolioStats';

export const metadata: Metadata = { title: 'Portfolio — Balast' };

export default function PortfolioPage() {
  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow" style={{ display: 'block', marginBottom: 12 }}>
            Portfolio
          </div>
          <h1>
            Your fees, <em>day by day</em>.
          </h1>
          <p className="lede">
            Every stake and position, marked to market, with the fees it actually earned. Nothing
            here is projected.
          </p>
        </div>
        <button className="btn btn-ghost">Share PnL card</button>
      </div>
      <PortfolioBody />
    </section>
  );
}
