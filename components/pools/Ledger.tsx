'use client';

import { usePools } from '@/components/providers/MarketProvider';
import { Flash } from '@/components/ui/Flash';
import { count, usd } from '@/lib/format';
import { CHAIN } from '@/lib/chain';

const WORDS = [
  'No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six',
  'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
];

/**
 * The eyebrow over the headline. It carried the date the numbers were as of
 * until the owner asked for it gone: during the first sync that date is
 * weeks old and read as a fault rather than as a fact. The lag is still on
 * screen — the top bar's indexer chip says how far behind the numbers are
 * (§7) — so removing the date hides nothing.
 */
export function LedgerDate() {
  return <>Live markets · {CHAIN.name}</>;
}

/**
 * The day in one sentence: how many markets are listed, and what they paid
 * in fees over the last 24 hours. Both are sums over the rows beneath it,
 * so the headline cannot disagree with the board (§12). The fee figure
 * flashes as it moves, like any other figure on the page.
 */
export function LedgerHeadline() {
  const pools = usePools();
  const n = pools.length;
  const fees24h = pools.reduce((sum, p) => sum + p.fees24hUsd, 0);

  if (n === 0) {
    return (
      <>
        No markets listed <em>yet</em>.
      </>
    );
  }
  const word = n < WORDS.length ? WORDS[n] : count(n);

  return (
    <>
      <em>{word}</em> {n === 1 ? 'market' : 'markets'} live.{' '}
      <Flash as="em" text={usd(fees24h)} /> paid to liquidity providers in the last 24 hours.
    </>
  );
}
