'use client';

import { useEffect } from 'react';
import { Masthead } from '@/components/shell/Masthead';
import { DATA_SOURCE } from '@/lib/data';

/**
 * When the data source fails, say so. Never fall back to numbers from
 * somewhere else and render them as if they were live (§7).
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const notImplemented = error.message.includes('not implemented');

  return (
    <section>
      <Masthead
        eyebrow="No data"
        title={
          <>
            Nothing to show, so we&rsquo;re showing <em>nothing</em>.
          </>
        }
        lede={
          notImplemented
            ? `DATA_SOURCE is "${DATA_SOURCE}", which is not implemented yet. Set DATA_SOURCE=sim to run against the P0 simulator.`
            : 'The data source failed. Rather than render stale or partial numbers as if they were live, this page shows you the failure.'
        }
        facts={false}
      />
      <div className="card panel">
        <div className="sect-h" style={{ display: 'block', marginBottom: 10 }}>
          What happened
        </div>
        <p className="note num" style={{ wordBreak: 'break-word' }}>
          {error.message}
        </p>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn-brand" onClick={reset}>
            Try again
          </button>
        </div>
      </div>
    </section>
  );
}
