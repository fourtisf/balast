import { describe, expect, it } from 'vitest';
import { TX_HISTORY_MAX, listTx, recordTx, updateTx, type TxRecord, type TxStorage } from './tx-history';

function memory(): TxStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const A = '0x000000000000000000000000000000000000a11c';
const B = '0x0000000000000000000000000000000000000b0b';
const tx = (n: number, wallet = A, at = n): TxRecord => ({
  hash: `0x${n.toString(16).padStart(64, '0')}`,
  kind: 'mint',
  wallet,
  at,
  status: 'pending',
  label: `tx ${n}`,
});

describe('tx history', () => {
  it('records per wallet, newest first, and updates a status by hash', () => {
    const store = memory();
    recordTx(tx(1), store);
    recordTx(tx(2), store);
    recordTx(tx(3, B), store);
    expect(listTx(A, store).map((r) => r.hash)).toEqual([tx(2).hash, tx(1).hash]);
    expect(listTx(B, store)).toHaveLength(1);
    // Case does not matter for a wallet or a hash.
    expect(listTx(A.toUpperCase().replace('0X', '0x'), store)).toHaveLength(2);
    updateTx(tx(1).hash.toUpperCase().replace('0X', '0x') as `0x${string}`, 'success', store);
    expect(listTx(A, store).find((r) => r.hash === tx(1).hash)?.status).toBe('success');
  });

  it('replaces a record with the same hash and caps the list', () => {
    const store = memory();
    for (let i = 1; i <= TX_HISTORY_MAX + 10; i++) recordTx(tx(i), store);
    expect(listTx(A, store)).toHaveLength(TX_HISTORY_MAX);
    expect(listTx(A, store)[0].hash).toBe(tx(TX_HISTORY_MAX + 10).hash);
    recordTx({ ...tx(TX_HISTORY_MAX + 10), label: 'renamed' }, store);
    expect(listTx(A, store).filter((r) => r.hash === tx(TX_HISTORY_MAX + 10).hash)).toHaveLength(1);
    expect(listTx(A, store)[0].label).toBe('renamed');
  });

  it('reads nothing from a corrupt store rather than throwing', () => {
    const store = memory();
    store.setItem('balast:tx', '{not json');
    expect(listTx(A, store)).toEqual([]);
    store.setItem('balast:tx', JSON.stringify([{ nope: true }, tx(4)]));
    expect(listTx(A, store)).toHaveLength(1);
  });
});
