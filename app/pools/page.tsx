import type { Metadata } from 'next';
import Link from 'next/link';
import { Featured, MiniCards } from '@/components/pools/Featured';
import { LivePayouts } from '@/components/pools/LivePayouts';
import { PoolBoard } from '@/components/pools/PoolBoard';

export const metadata: Metadata = { title: 'Pools — Balast' };

export default function PoolsPage() {
  return (
    <section>
      <h1 className="sr-only">Pools</h1>

      <div className="hero">
        <Featured />
        <MiniCards />
      </div>

      <div className="boards">
        <PoolBoard variant="trending" title="Trending" boardId="A" />
        <PoolBoard variant="established" title="Established" boardId="B" />
      </div>

      <div className="grid g2" style={{ marginTop: 12 }}>
        <LivePayouts />
        <div
          className="card panel"
          style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14 }}
        >
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-.01em', margin: '0 0 8px' }}>
              Own a share of the <em style={{ fontStyle: 'normal', color: 'var(--ac)' }}>depth</em>.
            </h2>
            <p className="lede">
              Deposit into any token on Robinhood Chain and collect swap fees in WETH, streamed to
              your wallet. No lockups, no emissions, nothing to trust but the contract.
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
