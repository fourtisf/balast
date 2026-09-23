'use client';

import { SOCIAL, X_HANDLE } from '@/lib/site';

/**
 * Where the project talks: X.
 *
 * The icon is X's own mark, filled. It used to be two crossed strokes,
 * which in the navigation read as a close button rather than as a link.
 * In the navigation it carries the handle beside it, so it is plainly X.
 *
 * The URL is a constant in lib/site.ts. Were it ever empty it would render
 * as a quiet, unlinked icon that says "coming soon" on hover rather than as
 * a link to nowhere: a dead link on a page that asks people to connect a
 * wallet is a small thing that reads as a large one.
 */
export function Community({ className = '' }: { className?: string }) {
  const inFooter = className.includes('foot');
  const icon = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
  const label = <span>{inFooter ? 'X' : X_HANDLE}</span>;
  return (
    <div className={`community ${className}`.trim()}>
      {SOCIAL.x ? (
        <a className="soc" href={SOCIAL.x} target="_blank" rel="noopener noreferrer" title={`Follow ${X_HANDLE} on X`} aria-label={`Balast on X, ${X_HANDLE}`}>
          {icon}
          {label}
        </a>
      ) : (
        <span className="soc off" title="X: coming soon">
          {icon}
          {label}
        </span>
      )}
    </div>
  );
}
