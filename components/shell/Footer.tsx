import { CHAIN } from '@/lib/chain';
import { shortWallet } from '@/lib/format';
import { TOKEN_CA } from '@/lib/site';
import { Community } from './Community';
import { Mark } from './Logo';

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-l">
        <Mark size={18} color="var(--fg-4)" />
        Balast · {CHAIN.name} · chain {CHAIN.id}
      </div>
      <div className="foot-r">
        <Community className="foot" />
        <span className="foot-ca" title={TOKEN_CA || 'The token has not launched; its contract address will be published here first.'}>
          {TOKEN_CA ? `CA ${shortWallet(TOKEN_CA)}` : 'CA · coming soon'}
        </span>
        <a href="#">Contracts</a>
        <a href="#">Audit</a>
        <a href="#">Docs</a>
        <a href="#">Status</a>
      </div>
    </footer>
  );
}
