import type { Metadata } from 'next';
import { MyStakes } from '@/components/stakes/MyStakes';
import { VaultGrid } from '@/components/stakes/VaultGrid';

export const metadata: Metadata = { title: 'Stakes — Balast' };

export default function StakesPage() {
  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow" style={{ display: 'block', marginBottom: 12 }}>
            Stakes
          </div>
          <h1>
            Stake once. Fees stream for <em>7 days</em>.
          </h1>
          <p className="lede">
            Drop in one token and Balast pairs it, places it, and harvests the fees. Your share
            arrives as WETH over a rolling week. Claim, compound, or leave whenever you like.
          </p>
        </div>
      </div>

      <VaultGrid />
      <MyStakes />
    </section>
  );
}
