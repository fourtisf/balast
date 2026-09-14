import type { ReactNode } from 'react';
import { Facts } from './Facts';

/**
 * Every page opens the same way: an eyebrow, a serif headline, a line of
 * copy, and the four global figures in a facts column on the right, over a
 * single heavy rule. The listing's headline is the day's numbers; the other
 * pages' headlines are what the page does.
 */
export function Masthead({
  eyebrow,
  title,
  lede,
  actions,
  facts = true,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  /** Off where there is no market to read from — the error page. */
  facts?: boolean;
}) {
  return (
    <header className="mast">
      <div className="mast-l">
        <span className="eyebrow">{eyebrow}</span>
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
