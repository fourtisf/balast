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
            Stake once. Earn the pool&rsquo;s fee on <em>every trade</em>.
          </>
        }
        lede="A stake is one full-range position in the pool, minted through Uniswap's PositionManager straight to your wallet as an NFT. It earns the pool's fee on every trade, in the pool's own tokens, and is never out of range. No lockup, no Balast fee, nothing held by Balast. Pick a pool below — holding only ETH or USDG is enough."
      />
      <VaultGrid />
      <MyStakes />
    </section>
  );
}
