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
        lede="Choose a range, pick a shape, set a deposit. Balast splits it across bins and mints them through Uniswap's PositionManager straight to your wallet, in one transaction. Nothing is held by Balast."
      />
      {/* The builder reads ?pool= and ?range= from the URL, which Next renders inside a boundary. */}
      <Suspense fallback={null}>
        <ShapeBuilder />
      </Suspense>
    </section>
  );
}
