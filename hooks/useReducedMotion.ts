'use client';

import { useEffect, useState } from 'react';

/**
 * prefers-reduced-motion disables the flash and the FLIP transform. It does
 * not disable the data updates (§11) — the numbers still change, they just
 * change quietly.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  return reduced;
}
