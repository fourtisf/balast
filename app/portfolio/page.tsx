import type { Metadata } from 'next';
import { PortfolioBody } from '@/components/portfolio/PortfolioStats';
import { Masthead } from '@/components/shell/Masthead';

export const metadata: Metadata = { title: 'Portfolio' };

export default function PortfolioPage() {
  return (
    <section>
      <Masthead
        eyebrow="Portfolio"
        title="Your portfolio"
        lede="Every position your wallet holds, at today's prices, with the fees it has earned. Collect or withdraw any time."
      />
      <PortfolioBody />
    </section>
  );
}
