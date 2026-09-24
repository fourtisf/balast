import type { ReactNode } from 'react';
import { Facts } from './Facts';

/**
 * Every page opens the same way: an eyebrow, a headline and one line of
 * copy saying what the page does. The listing also carries the global
 * figures as a row of tiles; no other page repeats them.
 */
export function Masthead({
  eyebrow,
  title,
  lede,
  actions,
  facts = false,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  /** The global figures, as tiles. On the listing only; elsewhere they repeat what the page is not about. */
  facts?: boolean;
}) {
  return (
    <header className="mast">
      <div className="mast-l">
        <span className="eyebrow mast-eyebrow">
          <i aria-hidden="true" />
          {eyebrow}
        </span>
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
        {actions ? <div className="row mast-actions">{actions}</div> : null}
      </div>
      {facts ? (
        <div className="mast-r">
          <Facts />
        </div>
      ) : null}
    </header>
  );
}
