import { CHAIN, CONTRACTS, EXPLORER_URL } from '@/lib/chain';
import { BRAND } from '@/lib/site';
import { Community } from './Community';
import { Mark } from './Logo';

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-l">
        <Mark size={16} color="var(--fg-3)" />
        <span>
          {BRAND} · {CHAIN.name} · chain {CHAIN.id}
        </span>
      </div>
      <div className="foot-r">
        <Community className="foot" />
        {/* Balast deploys no contract of its own (§20): every position is
            minted through Uniswap's PositionManager, and the audits and the
            docs are Uniswap's. A link to nowhere on a site that asks for a
            wallet reads badly (§22), so each one goes to the real thing. */}
        <a
          href={`${EXPLORER_URL}/address/${CONTRACTS.positionManager}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Uniswap v4 PositionManager on the explorer: the contract every position here is minted through"
        >
          Contracts
        </a>
        <a
          href="https://github.com/Uniswap/v4-periphery/tree/main/audits"
          target="_blank"
          rel="noopener noreferrer"
          title="Uniswap's audits of v4-periphery, which holds PositionManager"
        >
          Audit
        </a>
        <a href="https://docs.uniswap.org/contracts/v4/overview" target="_blank" rel="noopener noreferrer">
          Docs
        </a>
        <a href="/api/health" target="_blank" rel="noopener noreferrer" title="The indexer's health, live">
          Status
        </a>
      </div>
    </footer>
  );
}
