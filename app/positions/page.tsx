import type { Metadata } from 'next';
import { ShapeBuilder } from '@/components/positions/ShapeBuilder';

export const metadata: Metadata = { title: 'Positions — Balast' };

export default function PositionsPage() {
  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow" style={{ display: 'block', marginBottom: 12 }}>
            Positions
          </div>
          <h1>
            Shape your liquidity <em>by hand</em>.
          </h1>
          <p className="lede">
            Choose a range, pick a shape, deposit one token. Balast splits it across bins and mints a
            single Uniswap v4 position straight to your wallet.
          </p>
        </div>
      </div>
      <ShapeBuilder />
    </section>
  );
}
