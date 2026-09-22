/**
 * A block's timestamp, checked before it is believed.
 *
 * The box once recorded the cursor's chain time as 1 January 1970: the top
 * bar read "20718d behind", the dateline said 1 January, and every window
 * measured back from chain time — the trailing 24h, the 7d yield — was
 * measured from the epoch. A timestamp of zero is not a time; it is an
 * endpoint answering with a zeroed field, and it must be refused where it
 * arrives rather than written into every row of the pass.
 *
 * The floor is generous on purpose: no chain this indexer will follow mined
 * a block before 2020, so anything under it is nonsense, and anything over
 * it is left alone.
 */

export const MIN_BLOCK_TIME_MS = Date.UTC(2020, 0, 1);

export function isSaneBlockTime(date: Date): boolean {
  const ms = date.getTime();
  return Number.isFinite(ms) && ms >= MIN_BLOCK_TIME_MS;
}

/**
 * The timestamp a node answered, as a Date — or an error naming the block,
 * so a failover wrapper moves on to the next endpoint rather than the pass
 * recording the epoch.
 */
export function blockDate(timestamp: bigint | number | string, what: string): Date {
  const seconds = typeof timestamp === 'string' ? Number(BigInt(timestamp)) : Number(timestamp);
  const date = new Date(seconds * 1000);
  if (!isSaneBlockTime(date)) {
    throw new Error(`${what} answered with timestamp ${String(timestamp)}, which is not a time; refusing to record it`);
  }
  return date;
}
