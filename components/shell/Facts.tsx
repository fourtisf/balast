'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { count, usdExact, usdHeadline } from '@/lib/format';

/**
 * The four global figures, as a facts column in the masthead.
 *
 * Every one of them is summed or read by the provider, never here (§4), so
 * the column cannot disagree with the rows beneath it (§12). `data-fact`
 * names each row for the test that checks exactly that.
 */
export function Facts() {
  const { global } = useMarket();

  return (
    <dl className="facts">
      <div>
        <dt>Positions</dt>
        <dd className="num" data-fact="positions">
          {count(global.totalPositions)}
        </dd>
      </div>
      <div>
        <dt>Value locked</dt>
        <dd className="num" data-fact="tvl">
          {usdHeadline(global.tvlUsd)}
        </dd>
      </div>
      <div>
        <dt>Paid to LPs, all time</dt>
        <dd className="num" data-fact="fees">
          {usdExact(global.totalFeesUsd)}
        </dd>
      </div>
      <div>
        <dt>ETH</dt>
        <dd className="num" data-fact="eth">
          {usdExact(global.ethPriceUsd, 2)}
        </dd>
      </div>
    </dl>
  );
}
