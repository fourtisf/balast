'use client';

import type { ReactNode } from 'react';
import { useFlash } from '@/hooks/useFlash';

/**
 * A table cell that flashes when its value changes. The flash is driven by the
 * rendered text, so a value that formats to the same string does not blink.
 */
export function FlashTd({
  text,
  className = '',
  title,
  children,
}: {
  text: string;
  className?: string;
  title?: string;
  children?: ReactNode;
}) {
  const dir = useFlash(text);
  return (
    <td className={[className, dir].filter(Boolean).join(' ')} title={title}>
      {children ?? text}
    </td>
  );
}
