'use client';

import Link from 'next/link';
import { PositionList } from '@/components/portfolio/PositionList';
import { useLiveFees } from '@/components/portfolio/useLiveFees';
import { usePositionActions } from '@/components/portfolio/usePositionActions';
import { useMarket } from '@/components/providers/MarketProvider';
import type { TokenMeta } from '@/lib/data/types';

/**
 * The wallet's positions in the token the builder is on, under the builder.
 *
 * A mint used to end on a toast and a link to the transaction; the position
 * itself lived on another page. ALFA, having minted: there should be a way
 * to see it running and to withdraw it any time. This is the Portfolio's own
 * list — live status, uncollected fees read from the chain, Collect and
 * Withdraw with the same dry runs — filtered to this token.
 */
export function MyTokenPositions({ token }: { token: TokenMeta }) {
  const { portfolio, pools, otherPools } = useMarket();
  const actions = usePositionActions();
  const address = token.address.toLowerCase();
  const tokenOf = (poolId: string, live?: TokenMeta) =>
    (pools.find((p) => p.id === poolId) ?? (otherPools ?? []).find((p) => p.id === poolId))?.token ?? live;
  const mine = portfolio.positions.filter((p) => tokenOf(p.poolId, p.live?.token)?.address.toLowerCase() === address);
  const fees = useLiveFees(mine, actions.version);
  if (mine.length === 0) return null;
  return (
    <div style={{ marginTop: 22 }}>
      <PositionList fees={fees} actions={actions} tokenAddress={token.address} title={`Your ${token.symbol} positions`} />
      <p className="hint" style={{ marginTop: 8 }}>
        Every position this wallet holds, in every token, is on the <Link href="/portfolio">Portfolio</Link> page.
      </p>
    </div>
  );
}
