'use client';

import type { ReactNode } from 'react';
import { SOCIAL } from '@/lib/site';

/**
 * Where the project talks: X and Telegram.
 *
 * The URLs are build-time facts (`NEXT_PUBLIC_X_URL`, `NEXT_PUBLIC_TELEGRAM_URL`
 * — see lib/site.ts). An unset one renders as a quiet, unlinked icon that
 * says "coming soon" on hover rather than as a link to nowhere: a dead link
 * on a page that asks people to connect a wallet is a small thing that reads
 * as a large one.
 */
const ICONS: Record<'X' | 'Telegram', ReactNode> = {
  X: <path d="M4 4l16 16M20 4L4 20" />,
  Telegram: (
    <>
      <path d="M21.5 3.5L2.5 11.2l6.6 2.3 2.4 6.9 3.6-4.6 4.9 3.4z" />
      <path d="M9.1 13.5l12.4-10" />
    </>
  ),
};

export function Community({ className = '' }: { className?: string }) {
  return (
    <div className={`community ${className}`.trim()}>
      <Social href={SOCIAL.x} name="X" labelled={className.includes('foot')} />
      <Social href={SOCIAL.telegram} name="Telegram" labelled={className.includes('foot')} />
    </div>
  );
}

function Social({
  href,
  name,
  labelled,
}: {
  href: string;
  name: 'X' | 'Telegram';
  labelled: boolean;
}) {
  const icon = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
  const label = <span className={labelled ? undefined : 'sr-only'}>{name}</span>;

  if (!href) {
    return (
      <span className="soc off" title={`${name}: coming soon`}>
        {icon}
        {label}
      </span>
    );
  }
  return (
    <a className="soc" href={href} target="_blank" rel="noopener noreferrer" title={name}>
      {icon}
      {label}
    </a>
  );
}
