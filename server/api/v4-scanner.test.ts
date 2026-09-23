import { describe, expect, it } from 'vitest';
import { V4TokenScanner, type ScannerSource } from './v4-scanner';

const BOB = '0x0000000000000000000000000000000000000b0b';
const ALICE = '0x000000000000000000000000000000000000a11c';

function source(state: { next: bigint; owners: Map<bigint, string> }): ScannerSource & { reads: [bigint, bigint][] } {
  const reads: [bigint, bigint][] = [];
  return {
    reads,
    next: async () => state.next,
    owners: async (from, to) => {
      reads.push([from, to]);
      const out = new Map<bigint, string>();
      for (const [id, owner] of state.owners) if (id >= from && id < to) out.set(id, owner);
      return out;
    },
  };
}

describe('V4TokenScanner', () => {
  /**
   * Not only the ids above the indexer's last: an old position sent to this
   * wallet since the indexer's last block is in the indexer's table under
   * its previous owner, and only a scan of its id finds it here.
   */
  it('scans every id in its window, then only what was minted since', async () => {
    const state = { next: 110n, owners: new Map([[5n, BOB], [101n, BOB], [105n, ALICE]]) };
    const src = source(state);
    let now = 0;
    const scanner = new V4TokenScanner(src, { now: () => now, rescanMs: 1_000 });
    await scanner.scan();
    expect(src.reads).toEqual([[1n, 110n]]);
    expect(scanner.owned(BOB)).toEqual([5n, 101n]);
    expect(scanner.complete(now)).toBe(true);

    state.next = 115n;
    state.owners.set(112n, BOB);
    now = 500;
    await scanner.scan();
    expect(src.reads[1]).toEqual([110n, 115n]);
    expect(scanner.owned(BOB.toUpperCase().replace('0X', '0x'))).toEqual([5n, 101n, 112n]);
  });

  it('rescans the whole window on its cadence, which is how a transfer inside it is seen', async () => {
    const state = { next: 105n, owners: new Map([[101n, BOB]]) };
    let now = 0;
    const scanner = new V4TokenScanner(source(state), { now: () => now, rescanMs: 1_000 });
    await scanner.scan();
    state.owners.set(101n, ALICE);
    now = 500;
    await scanner.scan();
    expect(scanner.owned(BOB)).toEqual([101n]); // not yet seen
    now = 1_500;
    await scanner.scan();
    expect(scanner.owned(BOB)).toEqual([]);
    expect(scanner.owned(ALICE)).toEqual([101n]);
  });

  it('caps the window, drops ids that slide out of it, and says it is partial', async () => {
    const state = { next: 1_000n, owners: new Map([[950n, BOB], [905n, BOB]]) };
    const src = source(state);
    let now = 0;
    const scanner = new V4TokenScanner(src, { maxSpan: 100n, now: () => now, rescanMs: 10_000 });
    await scanner.scan();
    expect(src.reads).toEqual([[900n, 1_000n]]);
    expect(scanner.status().partial).toBe(true);
    expect(scanner.complete(now)).toBe(false);
    state.next = 1_010n;
    now = 100;
    await scanner.scan();
    expect(scanner.owned(BOB)).toEqual([950n]);
  });

  it('is not complete before its first pass, after a failed one, or when it has gone quiet', async () => {
    const state = { next: 105n, owners: new Map([[101n, BOB]]) };
    const src = source(state);
    let now = 0;
    const scanner = new V4TokenScanner(src, { now: () => now, rescanMs: 0 });
    expect(scanner.complete(now)).toBe(false);
    await scanner.scan();
    expect(scanner.complete(now)).toBe(true);
    // Gone quiet: no pass for a long while.
    expect(scanner.complete(now + 10 * 60_000)).toBe(false);

    src.next = async () => {
      throw new Error('all endpoints refused\n detail');
    };
    now = 1;
    await scanner.scan();
    // The last answer stays, and the failure is reported.
    expect(scanner.owned(BOB)).toEqual([101n]);
    expect(scanner.status().lastError).toBe('all endpoints refused');
    expect(scanner.complete(now)).toBe(false);
  });
});
