'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { duration } from '@/lib/format';
import { Mark } from './Logo';

/** Above this the indexer is behind and the bar has to say so (§7). */
const LAG_THRESHOLD_SECONDS = 30;

/** Routes whose content the search query actually filters. */
const SEARCHABLE = ['/pools', '/stakes', '/portfolio'];

const NAV = [
  { href: '/pools', label: 'Pools' },
  { href: '/stakes', label: 'Stakes' },
  { href: '/positions', label: 'Positions' },
  { href: '/router', label: 'Router' },
  { href: '/portfolio', label: 'Portfolio' },
];

/**
 * The masthead's navigation: brand, the five pages, search, the indexer's
 * freshness, and the wallet. The four global figures that used to sit here
 * live in the page masthead's facts column now (§19), where there is room
 * to label them.
 */
export function TopNav() {
  const { indexerLagSeconds } = useMarket();
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
    <header className="nav">
      <div className="nav-in">
        <Link href="/pools" className="brand" aria-label="Balast, to the pools">
          <Mark size={22} color="var(--fg)" />
          <span>Balast</span>
        </Link>

        <nav className="nav-links" aria-label="Primary">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? 'on' : undefined}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

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
            placeholder={filtersHere ? 'Search tokens' : 'Search pools'}
            autoComplete="off"
          />
        </div>

        {/* Indexer freshness (§7: never render stale numbers as if they were
            live). Neutral by design — the colour rule reserves red for
            negative numbers. */}
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
              <span className="lag-word">Indexer</span>{' '}
              <span className="num">{duration(indexerLagSeconds)}</span> behind
            </>
          ) : (
            <span className="lag-live">Live</span>
          )}
        </span>

        <button className="btn btn-ink" onClick={connect}>
          {wallet ?? (
            <>
              <span className="wallet-long">Connect wallet</span>
              <span className="wallet-short">Connect</span>
            </>
          )}
        </button>
      </div>
    </header>
  );
}
