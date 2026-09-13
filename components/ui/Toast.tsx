'use client';

import { useUi } from '@/components/providers/UiProvider';

export function Toast() {
  const { toast } = useUi();
  return (
    <div className={`toast${toast ? ' on' : ''}`} role="status" aria-live="polite">
      {toast}
    </div>
  );
}
