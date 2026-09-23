'use client';

import { useEffect, useState } from 'react';
import { useMarket, usePools } from '@/components/providers/MarketProvider';
import { Flash } from '@/components/ui/Flash';
import { count, usd } from '@/lib/format';

const WORDS = [
  'No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six',
  'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
];

/**
 * The dateline. Chain time, not wall-clock time: the date is the one the
 * numbers are as of — now, less the indexer's lag — because §7 does not
 * allow stale numbers to pass as live, and a dateline is a claim about when.
 *
 * Rendered after mount. The server's clock and time zone are not the
 * reader's, so a date computed during render would differ between the two
 * and React would report the mismatch.
 */
export function LedgerDate() {
  const { indexerLagSeconds } = useMarket();
  const [date, setDate] = useState<string | null>(null);

  useEffect(() => {
    const asOf = new Date(Date.now() - indexerLagSeconds * 1000);
    setDate(
      asOf.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
    );
  }, [indexerLagSeconds]);

  return <>The Balast ledger{date ? ` · ${date}` : ''}</>;
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
        Nothing on the ledger <em>yet</em>.
      </>
    );
  }
  const word = n < WORDS.length ? WORDS[n] : count(n);

  return (
    <>
      <em>{word}</em> {n === 1 ? 'market' : 'markets'} on the ledger.{' '}
      <Flash as="em" text={usd(fees24h)} /> in fees in the last 24 hours.
    </>
  );
}
