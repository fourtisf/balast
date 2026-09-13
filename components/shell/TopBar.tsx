'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { count, usdExact } from '@/lib/format';

/** Above this the indexer is behind and the top bar has to say so (§7). */
const LAG_THRESHOLD_SECONDS = 30;

/** Routes whose content the search query actually filters. */
const SEARCHABLE = ['/pools', '/stakes', '/portfolio'];

export function TopBar() {
  const { global, indexerLagSeconds } = useMarket();
  const { query, setQuery, wallet, connect } = useUi();
  const pathname = usePathname();
  const router = useRouter();
  const behind = indexerLagSeconds > LAG_THRESHOLD_SECONDS;
  const filtersHere = SEARCHABLE.includes(pathname);

  const onSearch = (value: string) => {
    setQuery(value);
    // Typing on a page the query cannot filter takes you to the listing it can.
    if (value !== '' && !filtersHere) router.push('/pools');
  };

  return (
    <header className="top">
      <div className="top-in">
        <div className="search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <label htmlFor="q" className="sr-only">
            Search tokens and stakes
          </label>
          <input
            id="q"
            value={query}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={filtersHere ? 'Search tokens & stakes' : 'Search pools & stakes'}
            autoComplete="off"
          />
        </div>

        <div className="tstats">
          <Stat label="Total positions" value={count(global.totalPositions)}>
            <path d="M12 3l9 5-9 5-9-5 9-5z" />
            <path d="M3 13l9 5 9-5" />
          </Stat>
          <Stat label="Total fees" value={usdExact(global.totalFeesUsd)}>
            <path d="M9 15l6-6M8 8h.01M16 16h.01" />
            <circle cx="12" cy="12" r="9" />
          </Stat>
          <Stat label="TVL" value={usdExact(global.tvlUsd)}>
            <path d="M12 3s6 6.5 6 10a6 6 0 11-12 0c0-3.5 6-10 6-10z" />
          </Stat>
          <Stat label="ETH price" value={usdExact(global.ethPriceUsd, 2)}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v10M9.5 9.5h5M9.5 14.5h5" />
          </Stat>
        </div>

        <div className="top-r">
          <span
            className={`lag${behind ? ' behind' : ''}`}
            title={
              behind
                ? 'The indexer is behind head. Numbers on screen are as of this lag, not live.'
                : 'Indexer is at head.'
            }
          >
            <i />
            {behind ? (
              <>
                <span className="lag-word">Indexer</span> {Math.round(indexerLagSeconds)}s behind
              </>
            ) : (
              <span className="lag-live">Live</span>
            )}
          </span>
          <button className="btn btn-ghost" onClick={connect}>
            {wallet ?? (
              <>
                <span className="wallet-long">Connect wallet</span>
                <span className="wallet-short">Connect</span>
              </>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ts">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {children}
      </svg>
      <div>
        <div className="k">{label}</div>
        <div className="v num">{value}</div>
      </div>
    </div>
  );
}
