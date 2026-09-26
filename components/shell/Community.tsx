'use client';

import type { ReactNode } from 'react';
import { BRAND, SOCIAL, X_HANDLE } from '@/lib/site';

/**
 * Where the project talks: X and Telegram.
 *
 * Each icon is the service's own mark, filled. X's used to be two crossed
 * strokes, which in the navigation read as a close button rather than as a
 * link. In the navigation each carries a label beside it, so it is plainly
 * which service it is.
 *
 * The URLs are constants in lib/site.ts. Were one ever empty it would render
 * as a quiet, unlinked icon that says "coming soon" on hover rather than as
 * a link to nowhere: a dead link on a page that asks people to connect a
 * wallet is a small thing that reads as a large one.
 */
const X_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const TELEGRAM_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </svg>
);

function Channel({ href, icon, label, title, service }: { href: string; icon: ReactNode; label: string; title: string; service: string }) {
  if (!href) {
    return (
      <span className="soc off" title={`${service}: coming soon`}>
        {icon}
        <span>{label}</span>
      </span>
    );
  }
  return (
    <a className="soc" href={href} target="_blank" rel="noopener noreferrer" title={title} aria-label={`${BRAND} on ${service}`}>
      {icon}
      <span>{label}</span>
    </a>
  );
}

export function Community({ className = '' }: { className?: string }) {
  const inFooter = className.includes('foot-soc');
  return (
    <div className={`community ${className}`.trim()}>
      <Channel href={SOCIAL.x} icon={X_ICON} label={inFooter ? 'X' : X_HANDLE} title={`Follow ${X_HANDLE} on X`} service="X" />
      <Channel
        href={SOCIAL.telegram}
        icon={TELEGRAM_ICON}
        label="Telegram"
        title={`Join the ${BRAND} Telegram`}
        service="Telegram"
      />
    </div>
  );
}
