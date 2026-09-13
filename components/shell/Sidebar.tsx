'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Mark } from './Logo';

const NAV = [
  {
    href: '/pools',
    label: 'Pools',
    icon: <path d="M3 17l5-6 4 4 5-8 4 5" />,
  },
  {
    href: '/stakes',
    label: 'Stakes',
    icon: (
      <>
        <path d="M12 3l9 5-9 5-9-5 9-5z" />
        <path d="M3 13l9 5 9-5" />
      </>
    ),
  },
  {
    href: '/positions',
    label: 'Positions',
    icon: <path d="M4 20V10M9 20V4M14 20v-8M19 20V7" />,
  },
  {
    href: '/router',
    label: 'Router',
    icon: (
      <>
        <path d="M4 7h10a4 4 0 014 4v6" />
        <path d="M15 14l3 3 3-3" />
        <circle cx="4" cy="7" r="2" />
      </>
    ),
  },
  {
    href: '/portfolio',
    label: 'Portfolio',
    icon: (
      <>
        <rect x="3" y="7" width="18" height="13" rx="2" />
        <path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2" />
      </>
    ),
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="rail" aria-label="Primary">
      <div className="logo-m">
        <Mark size={26} title="Depth" />
        <span>DEPTH</span>
      </div>
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={active ? 'on' : undefined}
            aria-current={active ? 'page' : undefined}
            title={item.label}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {item.icon}
            </svg>
            <span>{item.label}</span>
          </Link>
        );
      })}
      <div className="sp" />
      <div className="div" />
      <a className="soc" href="#" title="X">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 4l16 16M20 4L4 20" />
        </svg>
        <span>X</span>
      </a>
      <a className="soc" href="#" title="Discord">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 11h.01M16 11h.01" />
          <path d="M8.5 18l-1 2.5C5 19.5 3.5 17 3.5 14c0-4 2-7.5 5-8.5L9.5 8" />
          <path d="M15.5 18l1 2.5c2.5-1 4-3.5 4-6.5 0-4-2-7.5-5-8.5L14.5 8" />
        </svg>
        <span>Discord</span>
      </a>
      <a className="soc" href="#" title="Docs">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M9 12h7M9 16h7" />
        </svg>
        <span>Docs</span>
      </a>
    </nav>
  );
}
