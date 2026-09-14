'use client';

import type { ReactNode } from 'react';
import { useFlash } from '@/hooks/useFlash';

/**
 * An element that flashes when its value changes — green up, red down, ~1.1s
 * (§6). The flash is driven by the rendered text, so a value that formats to
 * the same string does not blink.
 */
export function Flash({
  text,
  className = '',
  title,
  as = 'span',
  children,
}: {
  text: string;
  className?: string;
  title?: string;
  as?: 'span' | 'div' | 'em';
  children?: ReactNode;
}) {
  const dir = useFlash(text);
  const Tag = as;
  return (
    <Tag className={[className, 'flash', dir].filter(Boolean).join(' ')} title={title}>
      {children ?? text}
    </Tag>
  );
}
