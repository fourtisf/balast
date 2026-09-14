'use client';

import { SOCIAL } from '@/lib/site';

/**
 * Where the project talks: X.
 *
 * The URL is a build-time fact (`NEXT_PUBLIC_X_URL`, defaulting to the
 * owner's account — see lib/site.ts). Were it ever unset it would render as
 * a quiet, unlinked icon that says "coming soon" on hover rather than as a
 * link to nowhere: a dead link on a page that asks people to connect a
 * wallet is a small thing that reads as a large one.
 */
export function Community({ className = '' }: { className?: string }) {
  const labelled = className.includes('foot');
  const icon = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4l16 16M20 4L4 20" />
    </svg>
  );
  const label = <span className={labelled ? undefined : 'sr-only'}>X</span>;
  return (
    <div className={`community ${className}`.trim()}>
      {SOCIAL.x ? (
        <a className="soc" href={SOCIAL.x} target="_blank" rel="noopener noreferrer" title="Balast on X">
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
