import type { Metadata } from 'next';
import { ShapeBuilder } from '@/components/positions/ShapeBuilder';
import { Masthead } from '@/components/shell/Masthead';

export const metadata: Metadata = { title: 'Positions — Balast' };

export default function PositionsPage() {
  return (
    <section>
      <Masthead
        eyebrow="Positions"
        title={
          <>
            Shape your liquidity <em>by hand</em>.
          </>
        }
        lede="Choose a range, pick a shape, deposit one token. Balast splits it across bins and mints a single Uniswap v4 position straight to your wallet."
      />
      <ShapeBuilder />
    </section>
  );
}
