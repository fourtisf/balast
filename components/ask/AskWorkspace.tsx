'use client';

/**
 * /ask: the assistant on a page of its own. The person picks what the
 * conversation is about — LockFi in general, or one of the board's pools —
 * and the server supplies that pool's figures, as it does in the drawer.
 */

import { useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { feeTierLabel, quoteLabel } from '@/lib/format';
import { AskPanel } from './AskPanel';

const GENERAL = [
  'How do I earn fees on LockFi?',
  'What is price impact on holdings?',
  'Are my funds safe with LockFi?',
  'Full range or a shape: which should I start with?',
];

export function AskWorkspace() {
  const { pools } = useMarket();
  const [poolId, setPoolId] = useState<string>('');
  const pool = pools.find((p) => p.id === poolId) ?? null;

  const suggestions = pool
    ? [
        `What are the risks of ${pool.token.symbol} / ${quoteLabel(pool)}?`,
        'What does this fee tier mean?',
        'How is this pool’s fee yield worked out?',
        'What happens if the price leaves my range?',
      ]
    : GENERAL;

  return (
    <div>
      <div className="ask-topic">
        <label htmlFor="ask-about">About</label>
        <select id="ask-about" value={poolId} onChange={(e) => setPoolId(e.target.value)}>
          <option value="">LockFi in general</option>
          {pools.map((p) => (
            <option key={p.id} value={p.id}>
              {p.token.symbol} / {quoteLabel(p)} · {feeTierLabel(p.feeTierBps)}
            </option>
          ))}
        </select>
      </div>
      <AskPanel
        page
        poolId={pool ? pool.id : null}
        suggestions={suggestions}
        placeholder={pool ? `Ask about ${pool.token.symbol} / ${quoteLabel(pool)}` : 'Ask about LockFi, liquidity or a risk'}
      />
    </div>
  );
}
