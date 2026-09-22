import { describe, expect, it } from 'vitest';
import { MIN_BLOCK_TIME_MS, blockDate, isSaneBlockTime } from './block-time';

describe('block timestamps', () => {
  it('accepts a real one in any of the shapes a node answers', () => {
    const seconds = 1_790_000_000;
    expect(blockDate(BigInt(seconds), 'x').getTime()).toBe(seconds * 1000);
    expect(blockDate(seconds, 'x').getTime()).toBe(seconds * 1000);
    expect(blockDate(`0x${seconds.toString(16)}`, 'x').getTime()).toBe(seconds * 1000);
  });

  it('refuses zero and anything before the floor, naming the block', () => {
    // The box's own case: a zeroed field, recorded as 1 January 1970.
    expect(() => blockDate('0x0', 'getBlock(4410255)')).toThrow(/getBlock\(4410255\).*not a time/);
    expect(() => blockDate(0n, 'x')).toThrow();
    expect(() => blockDate(1_500_000_000, 'x')).toThrow();
    expect(isSaneBlockTime(new Date(0))).toBe(false);
    expect(isSaneBlockTime(new Date(NaN))).toBe(false);
    expect(isSaneBlockTime(new Date(MIN_BLOCK_TIME_MS))).toBe(true);
  });
});
