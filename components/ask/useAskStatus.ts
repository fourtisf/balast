'use client';

import { useEffect, useState } from 'react';
import { askReachable, askStatus, type AskStatus } from '@/lib/ask';
import { DATA_SOURCE } from '@/lib/data';

/**
 * Whether the assistant is on, asked once per page load and shared: the
 * portfolio has an Ask button on every row, and each asking separately would
 * be a request per position for one fact. Null until the answer arrives.
 */
let pending: Promise<AskStatus> | null = null;

export function useAskStatus(): AskStatus | null {
  const [status, setStatus] = useState<AskStatus | null>(null);
  useEffect(() => {
    if (!askReachable(DATA_SOURCE === 'live')) {
      setStatus({ enabled: false, provider: '' });
      return;
    }
    pending ??= askStatus();
    let alive = true;
    void pending.then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);
  return status;
}
