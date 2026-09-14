'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { count, shortWallet, usdExact, usdHeadline } from '@/lib/format';
import { TOKEN_CA } from '@/lib/site';

/**
 * The facts column in the masthead: the four global figures, and the
 * token's contract address.
 *
 * Every figure is summed or read by the provider, never here (§4), so the
 * column cannot disagree with the rows beneath it (§12). `data-fact` names
 * each row for the test that checks exactly that.
 *
 * The contract address is here, in the masthead of every page, because this
 * is where people will look for it — and until there is one, the honest
 * line is "coming soon". Any address circulating before it appears here is
 * not ours; the tooltip says so.
 */
export function Facts() {
  const { global } = useMarket();
  const { showToast } = useUi();

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(TOKEN_CA);
      showToast('Contract address copied');
    } catch {
      // Clipboard access can be refused; the full address is in the tooltip.
      showToast(TOKEN_CA);
    }
  };

  return (
    <dl className="facts">
      <div>
        <dt>Positions</dt>
        <dd
          className="num"
          data-fact="positions"
          title={
            global.totalPositions === 0
              ? 'Nothing minted yet. Position minting opens with the contracts.'
              : undefined
          }
        >
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
      <div>
        <dt>Contract address</dt>
        <dd data-fact="ca">
          {TOKEN_CA ? (
            <button className="ca num" onClick={copyAddress} title={`${TOKEN_CA} — click to copy`}>
              {shortWallet(TOKEN_CA)}
            </button>
          ) : (
            <span
              className="soon"
              title="The Balast token has not launched. Its contract address will be published here first; any address circulating before then is not ours."
            >
              CA · coming soon
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}
