import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ShapeBuilder } from '@/components/positions/ShapeBuilder';
import { Masthead } from '@/components/shell/Masthead';

export const metadata: Metadata = { title: 'Positions' };

export default function PositionsPage() {
  return (
    <section>
      <Masthead
        eyebrow="Positions"
        title="Build a position"
        lede="Pick a pool, choose how your liquidity is spread, and deposit. Uniswap mints it straight to your wallet."
      />
      {/* The builder reads ?pool= and ?range= from the URL, which Next renders inside a boundary. */}
      <Suspense fallback={null}>
        <ShapeBuilder />
      </Suspense>
    </section>
  );
}
