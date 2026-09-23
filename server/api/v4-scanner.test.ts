import { describe, expect, it } from 'vitest';
import { V4TokenScanner, redactEndpoints, type ScannerSource } from './v4-scanner';

const BOB = '0x0000000000000000000000000000000000000b0b';
const ALICE = '0x000000000000000000000000000000000000a11c';

function source(state: { next: bigint; owners: Map<bigint, string>; failFrom?: bigint | null }): ScannerSource & {
  reads: [bigint, bigint][];
} {
  const reads: [bigint, bigint][] = [];
  return {
    reads,
    next: async () => state.next,
    owners: async (from, to) => {
      if (state.failFrom != null && from >= state.failFrom) {
        throw new Error('v4 owners failed on all 2 endpoints:\n  https://paid.example/rpc/SECRET-KEY: 429 Too Many Requests\n  https://rpc.public.example: timeout');
      }
      reads.push([from, to]);
      const out = new Map<bigint, string>();
      for (const [id, owner] of state.owners) if (id >= from && id < to) out.set(id, owner);
      return out;
    },
  };
}

describe('V4TokenScanner', () => {
  it('sweeps the window a few chunks a pass, then reads only what was minted since', async () => {
    const state = { next: 2_001n, owners: new Map([[5n, BOB], [1_500n, BOB], [1_600n, ALICE]]) };
    const src = source(state);
    let now = 0;
    const scanner = new V4TokenScanner(src, { now: () => now, chunk: 500n, chunksPerPass: 2, rescanMs: 1_000_000 });
    await scanner.scan();
    // Two chunks of the sweep, not the whole window in one go.
    expect(src.reads).toEqual([[1n, 501n], [501n, 1_001n]]);
    expect(scanner.owned(BOB)).toEqual([5n]);
    expect(scanner.complete(now)).toBe(false);

    now = 10;
    await scanner.scan();
    expect(scanner.owned(BOB)).toEqual([5n, 1_500n]);
    expect(scanner.status().swept).toBe(true);
    expect(scanner.complete(now)).toBe(true);

    // New ids are read before anything else.
    state.next = 2_101n;
    state.owners.set(2_050n, BOB);
    now = 20;
    await scanner.scan();
    expect(src.reads.at(-1)).toEqual([2_001n, 2_101n]);
    expect(scanner.owned(BOB)).toEqual([5n, 1_500n, 2_050n]);
  });

  /** On the box a single refused request threw the whole pass away, and the scan never finished once. */
  it('keeps every chunk it read when one fails, and resumes there', async () => {
    const state: { next: bigint; owners: Map<bigint, string>; failFrom: bigint | null } = {
      next: 1_501n,
      owners: new Map([[100n, BOB], [1_200n, BOB]]),
      failFrom: 1_001n,
    };
    const src = source(state);
    let now = 0;
    const scanner = new V4TokenScanner(src, { now: () => now, chunk: 500n, chunksPerPass: 10, rescanMs: 1_000_000 });
    await scanner.scan();
    expect(scanner.owned(BOB)).toEqual([100n]);
    expect(scanner.complete(now)).toBe(false);
    // The whole reason is kept, with each endpoint's host and no path or key.
    const error = scanner.status().lastError!;
    expect(error).toContain('429 Too Many Requests');
    expect(error).toContain('paid.example');
    expect(error).not.toContain('SECRET-KEY');

    state.failFrom = null;
    now = 30_000;
    await scanner.scan();
    // Resumed at the chunk that failed, not from the start.
    expect(src.reads.slice(-1)).toEqual([[1_001n, 1_501n]]);
    expect(scanner.owned(BOB)).toEqual([100n, 1_200n]);
    expect(scanner.complete(now)).toBe(true);
  });

  it('rescans on its cadence, which is how a transfer or a burn inside the window is seen', async () => {
    const state = { next: 105n, owners: new Map([[101n, BOB], [102n, BOB]]) };
    let now = 0;
    const scanner = new V4TokenScanner(source(state), { now: () => now, rescanMs: 1_000 });
    await scanner.scan();
    expect(scanner.owned(BOB)).toEqual([101n, 102n]);
    state.owners.set(101n, ALICE);
    state.owners.delete(102n); // burned
    now = 500;
    await scanner.scan();
    expect(scanner.owned(BOB)).toEqual([101n, 102n]); // not yet seen
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
    expect(src.reads[0][0]).toBe(900n);
    expect(scanner.status().partial).toBe(true);
    expect(scanner.complete(now)).toBe(false);
    state.next = 1_010n;
    now = 100;
    await scanner.scan();
    expect(scanner.owned(BOB)).toEqual([950n]);
  });

  it('is not complete before a sweep has finished, after a failed pass, or when it has gone quiet', async () => {
    const state = { next: 105n, owners: new Map([[101n, BOB]]) };
    const src = source(state);
    let now = 0;
    const scanner = new V4TokenScanner(src, { now: () => now, rescanMs: 0 });
    expect(scanner.complete(now)).toBe(false);
    await scanner.scan();
    expect(scanner.complete(now)).toBe(true);
    expect(scanner.complete(now + 10 * 60_000)).toBe(false);
    src.next = async () => {
      throw new Error('nextTokenId failed on all 4 endpoints:\n  https://rpc.example: execution reverted');
    };
    now = 1;
    await scanner.scan();
    expect(scanner.owned(BOB)).toEqual([101n]);
    expect(scanner.status().lastError).toBe('nextTokenId failed on all 4 endpoints: | rpc.example: execution reverted');
    expect(scanner.complete(now)).toBe(false);
  });
});

describe('redactEndpoints', () => {
  it('keeps the host and drops the path and query, where a key lives', () => {
    expect(redactEndpoints('https://eth.example.com/v2/abc123: 429')).toBe('eth.example.com: 429');
    // A port is kept; a key after it is not.
    expect(redactEndpoints('http://node.local:8545/?key=x failed')).toBe('node.local:8545 failed');
    expect(redactEndpoints('failed on all 2 endpoints:\n  https://a.example/k/SECRET: 429')).toBe('failed on all 2 endpoints:\n  a.example: 429');
  });
});
