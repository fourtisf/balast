'use client';

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

export type FlashDirection = 'fu' | 'fd' | null;

const parse = (s: string) => {
  const n = Number.parseFloat(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Green when the value went up, red when it went down, ~1.1s, on change only
 * (§6). Returns the class the prototype uses.
 */
export function useFlash(text: string): FlashDirection {
  const previous = useRef<string | null>(null);
  const [dir, setDir] = useState<FlashDirection>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const prev = previous.current;
    previous.current = text;
    if (prev === null || prev === text || reduced) return;

    setDir(parse(text) >= parse(prev) ? 'fu' : 'fd');
    const t = setTimeout(() => setDir(null), 1100);
    return () => clearTimeout(t);
  }, [text, reduced]);

  return dir;
}
