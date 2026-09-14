import type { Metadata } from 'next';
import { PortfolioBody } from '@/components/portfolio/PortfolioStats';
import { Masthead } from '@/components/shell/Masthead';

export const metadata: Metadata = { title: 'Portfolio — Balast' };

export default function PortfolioPage() {
  return (
    <section>
      <Masthead
        eyebrow="Portfolio"
        title={
          <>
            Your fees, <em>day by day</em>.
          </>
        }
        lede="Every stake and position, marked to market, with the fees it actually earned. Nothing here is projected."
        actions={<button className="btn btn-ghost">Share PnL card</button>}
      />
      <PortfolioBody />
    </section>
  );
}
