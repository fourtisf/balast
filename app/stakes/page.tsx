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
        title={
          <>
            Stake once. <em>Earn on every trade</em>.
          </>
        }
        lede="A stake is one full-range position, minted by Uniswap straight to your wallet. Never out of range, no lockup, no LockFi fee. ETH or USDG is enough to start."
      />
      <VaultGrid />
      <MyStakes />
    </section>
  );
}
