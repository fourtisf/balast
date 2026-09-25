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
        title={
          <>
            Shape your liquidity <em>by hand</em>.
          </>
        }
        lede="Pick a range and a shape. Uniswap mints each bin straight to your wallet, and nothing is held by LockFi."
      />
      {/* The builder reads ?pool= and ?range= from the URL, which Next renders inside a boundary. */}
      <Suspense fallback={null}>
        <ShapeBuilder />
      </Suspense>
    </section>
  );
}
