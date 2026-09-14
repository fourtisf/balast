import type { Metadata } from 'next';
import { Masthead } from '@/components/shell/Masthead';
import { MyStakes } from '@/components/stakes/MyStakes';
import { VaultGrid } from '@/components/stakes/VaultGrid';

export const metadata: Metadata = { title: 'Stakes — Balast' };

export default function StakesPage() {
  return (
    <section>
      <Masthead
        eyebrow="Stakes"
        title={
          <>
            Stake once. Fees stream for <em>7 days</em>.
          </>
        }
        lede="Drop in one token and Balast pairs it, places it, and harvests the fees. Your share arrives as WETH over a rolling week. Claim, compound, or leave whenever you like."
      />
      <VaultGrid />
      <MyStakes />
    </section>
  );
}
