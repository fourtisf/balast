import type { Metadata } from 'next';
import Link from 'next/link';
import { Leaderboard } from '@/components/pools/Leaderboard';
import { LivePayouts } from '@/components/pools/LivePayouts';
import { Masthead } from '@/components/shell/Masthead';

export const metadata: Metadata = { title: 'Pools' };

export default function PoolsPage() {
  return (
    <section>
      <Masthead
        eyebrow="Live · Robinhood Chain"
        title="Top tokens on Robinhood Chain"
        lede="Ranked live by market cap. Stake into any of them through Uniswap, straight from your wallet."
        facts
      />

      <Leaderboard />

      <div className="grid g2">
        <LivePayouts />
        <div className="card panel cta">
          <div>
            <h2>
              Own a share of the <em>liquidity</em>.
            </h2>
            <p className="lede">
              Deposit into any token on Robinhood Chain and earn its pool&rsquo;s swap fees, in a
              position minted straight to your wallet. No lockups, no emissions, nothing held by
              Balast.
            </p>
          </div>
          <div className="row">
            <Link className="btn btn-brand" href="/stakes">
              Start earning
            </Link>
            <Link className="btn btn-ghost" href="/positions">
              Build a position
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
