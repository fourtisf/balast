'use client';

import { useEffect, useState } from 'react';
import { useUi } from '@/components/providers/UiProvider';
import { EXPLORER_URL } from '@/lib/chain';
import { TX_CHANGED_EVENT, listTx, updateTx, type TxRecord, type TxStatus } from '@/lib/tx-history';
import { readClient } from '@/lib/v4/flow';

/** A transaction left pending by a reload is asked about on this cadence until it is mined. */
const RECEIPT_POLL_MS = 8_000;

const KIND_LABEL: Record<TxRecord['kind'], string> = {
  approve: 'Approval',
  wrap: 'Wrap',
  swap: 'Swap',
  mint: 'Mint',
  collect: 'Collect',
  withdraw: 'Withdraw',
};

const STATUS: Record<TxStatus, { text: string; className: string }> = {
  pending: { text: 'pending', className: 'pill grey' },
  success: { text: 'confirmed', className: 'pill up' },
  reverted: { text: 'reverted', className: 'pill down' },
};

function when(at: number): string {
  return new Date(at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * What this browser has sent through the site for the connected wallet
 * (lib/tx-history.ts). A convenience, not a record: the explorer link on
 * each row is the record, and the caption says so.
 */
export function TxHistory() {
  const { wallet } = useUi();
  const address = wallet?.address ?? null;
  const [records, setRecords] = useState<TxRecord[]>([]);

  useEffect(() => {
    if (!address) {
      setRecords([]);
      return;
    }
    const read = () => setRecords(listTx(address));
    read();
    window.addEventListener(TX_CHANGED_EVENT, read);
    return () => window.removeEventListener(TX_CHANGED_EVENT, read);
  }, [address]);

  // A flow that is still open marks its own transaction mined; one cut off
  // by a reload would stay "pending" for ever. So pending rows are asked
  // about on a cadence, through the public RPC, until the receipt is in.
  const pendingKey = records
    .filter((r) => r.status === 'pending')
    .map((r) => r.hash)
    .join(',');
  useEffect(() => {
    if (pendingKey === '') return;
    const hashes = pendingKey.split(',') as TxRecord['hash'][];
    let cancelled = false;
    const client = readClient(null);
    const check = async () => {
      for (const hash of hashes) {
        try {
          const receipt = await client.getTransactionReceipt({ hash });
          if (!cancelled) updateTx(hash, receipt.status === 'success' ? 'success' : 'reverted');
        } catch {
          /* not mined yet, or the RPC is refusing: ask again next time */
        }
      }
    };
    void check();
    const id = setInterval(check, RECEIPT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pendingKey]);

  return (
    <div className="card panel" style={{ marginTop: 14 }} data-tx-history>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <h2 style={{ fontWeight: 600, fontSize: 17, letterSpacing: '-.02em' }}>Activity</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          sent from this browser · the explorer is the record
        </span>
      </div>
      {!address ? (
        <div className="empty">
          <b>Connect a wallet</b>Approvals, mints, collections and withdrawals sent from this browser appear here.
        </div>
      ) : records.length === 0 ? (
        <div className="empty">
          <b>Nothing sent yet</b>Approvals, mints, collections and withdrawals sent from this browser appear here,
          with whether they were mined.
        </div>
      ) : (
        records.map((r) => {
          const status = STATUS[r.status] ?? STATUS.pending;
          return (
            <div className="pnl-row" key={r.hash}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  <span className="muted" style={{ fontWeight: 500, marginRight: 8 }}>
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </span>
                  {r.label}
                </div>
                <div className="muted num" style={{ fontSize: 12, marginTop: 2 }}>
                  {when(r.at)}
                </div>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end', flex: 'none' }}>
                <span className={status.className}>{status.text}</span>
                <a
                  href={`${EXPLORER_URL}/tx/${r.hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="muted"
                  style={{ fontSize: 12, textDecoration: 'underline' }}
                >
                  View
                </a>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
