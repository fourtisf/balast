import type { Metadata } from 'next';
import { PortfolioBody } from '@/components/portfolio/PortfolioStats';
import { Masthead } from '@/components/shell/Masthead';

export const metadata: Metadata = { title: 'Portfolio' };

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
        lede="Every position at today's prices, with the fees it has earned and a way to collect them. Nothing here is projected."
      />
      <PortfolioBody />
    </section>
  );
}
