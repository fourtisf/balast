import type { Metadata } from 'next';
import { Masthead } from '@/components/shell/Masthead';
import { MyStakes } from '@/components/stakes/MyStakes';
import { VaultGrid } from '@/components/stakes/VaultGrid';

export const metadata: Metadata = { title: 'Stakes' };

export default function StakesPage() {
  return (
    <section>
      <Masthead
        eyebrow="Stakes"
        title="Stake a pool"
        lede="One full-range position per stake, minted by Uniswap to your wallet. Never out of range, withdraw any time, no LockFi fee."
      />
      <VaultGrid />
      <MyStakes />
    </section>
  );
}
