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
        lede="Every position, marked to market, with the fees it has actually earned and a way to collect them. Nothing here is projected."
      />
      <PortfolioBody />
    </section>
  );
}
