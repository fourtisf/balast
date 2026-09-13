'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * FLIP reordering: rows move to their new rank with a transform, never a jump
 * (§6). Positions are measured with offsetTop so scrolling the board between
 * renders does not fake a move.
 */
export function useFlip(enabled: boolean) {
  const prevTops = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLElement>());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const register = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(key, el);
      else nodes.current.delete(key);
    },
    [],
  );

  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const hadPrevious = prevTops.current.size > 0;

    nodes.current.forEach((el, key) => {
      const top = el.offsetTop;
      next.set(key, top);
      const prev = prevTops.current.get(key);

      if (prev === undefined) {
        // A row that was not on the board a moment ago.
        if (enabled && hadPrevious) {
          el.classList.add('enter');
          timers.current.push(setTimeout(() => el.classList.remove('enter'), 520));
        }
        return;
      }

      const delta = prev - top;
      if (enabled && Math.abs(delta) > 1) {
        el.style.transition = 'none';
        el.style.transform = `translateY(${delta}px)`;
        requestAnimationFrame(() => {
          el.style.transition = '';
          el.style.transform = '';
        });
      }
    });

    prevTops.current = next;
  });

  useLayoutEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  return register;
}
