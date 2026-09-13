import { Mark } from './Sidebar';

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-l">
        <Mark size={18} fill="var(--fg-4)" />
        Depth · Robinhood Chain · chain 4663
      </div>
      <div className="foot-r">
        <a href="#">Contracts</a>
        <a href="#">Audit</a>
        <a href="#">Docs</a>
        <a href="#">Status</a>
        <a href="#">X</a>
      </div>
    </footer>
  );
}
