'use client';

import { useMarket, usePools } from '@/components/providers/MarketProvider';
import { Flash } from '@/components/ui/Flash';
import { count, duration, usd, usdExact, usdHeadline } from '@/lib/format';

/**
 * The global figures, as a row of tiles on the listing. The token's contract
 * address lives in the top bar, on every page.
 *
 * Every figure is read by the provider or summed from the listed pools,
 * never derived here (§4), so the tiles cannot disagree with the rows
 * beneath them (§12). `data-fact` names each tile for the test that checks
 * exactly that.
 */
/** "4m" / "12s": how long ago an ISO time was, for a tooltip. */
function ageOf(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return duration(seconds);
}

export function Facts() {
  const { global } = useMarket();
  const pools = usePools();

  const fees24h = pools.reduce((sum, p) => sum + p.fees24hUsd, 0);

  return (
    <dl className="facts">
      <div>
        <dt>Value locked</dt>
        <dd className="num" data-fact="tvl">
          {usdHeadline(global.tvlUsd)}
        </dd>
      </div>
      <div>
        <dt>Fees, 24h</dt>
        {/* Summed from the rows beneath, so the two cannot disagree (§12). */}
        <dd className="num" data-fact="fees24h">
          <Flash as="span" text={usd(fees24h)} />
        </dd>
      </div>
      <div>
        <dt>Paid to LPs, all time</dt>
        <dd className="num" data-fact="fees">
          {usdExact(global.totalFeesUsd)}
        </dd>
      </div>
      <div>
        <dt>Open positions</dt>
        <dd
          className="num"
          data-fact="positions"
          title={
            global.totalPositions === 0
              ? 'Open positions minted through PositionManager on this chain, as the indexer counts them. None yet, or the indexer has not reached the block they were minted in.'
              : 'Open positions minted through PositionManager on this chain, as the indexer counts them. A burned position leaves the count.'
          }
        >
          {count(global.totalPositions)}
        </dd>
      </div>
      <div>
        <dt>ETH</dt>
        <dd
          className="num"
          data-fact="eth"
          data-basis={global.ethPriceBasis}
          title={
            global.ethPriceBasis === 'live'
              ? `Live, via ${global.ethPriceSource ?? 'an aggregator'}${global.ethPriceAt ? `, ${ageOf(global.ethPriceAt)} ago` : ''}. The chain's own anchor price still values every dollar figure on the site.`
              : global.ethPriceBasis === 'chain'
                ? 'The anchor price at the last indexed block: the chain\u2019s, and as old as the lag in the top bar. No aggregator has answered for ether yet.'
                : undefined
          }
        >
          {usdExact(global.ethPriceUsd, 2)}
          {global.ethPriceBasis && (
            <span className="basis" aria-label={`${global.ethPriceBasis} price`}>
              {global.ethPriceBasis}
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}
