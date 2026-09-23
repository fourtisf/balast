/**
 * Finds the v4 positions minted since the indexer's last one.
 *
 * The portfolio learns which v4 token ids a wallet holds from the indexer's
 * `positions` table, which is as far behind as the backfill — weeks, on this
 * chain (§25). Every position minted in that gap, including every one minted
 * through this site, was invisible to the portfolio, and so could not be
 * withdrawn here.
 *
 * PositionManager numbers its tokens sequentially and is not enumerable, so
 * the chain is scanned by id: `ownerOf` for every id in the last `MAX_SPAN`
 * up to `nextTokenId()`. New ids are read every `SCAN_MS`; the whole window
 * again every `RESCAN_MS`, which is how a transfer or a burn inside it is
 * seen.
 *
 * The window is NOT started at the indexer's highest id, although that
 * would be cheaper. The indexer's record of an older id is only as current
 * as its cursor, so an old position sent to this wallet — or emptied and
 * then topped up — since the indexer's last block would be in neither place.
 * A chain with more ids than the window leaves the oldest unscanned, and
 * the scan says it is partial. It only DISCOVERS candidates:
 * `readV4Positions` then confirms each one on chain before the portfolio
 * shows it.
 */

export interface ScannerSource {
  /** `nextTokenId()` on PositionManager. */
  next(): Promise<bigint>;
  /** Owners of ids in [from, to); burned ids absent. Lowercase addresses. */
  owners(from: bigint, to: bigint): Promise<Map<bigint, string>>;
}

export const SCAN_MS = 30_000;
export const RESCAN_MS = 10 * 60_000;
export const MAX_SPAN = 50_000n;

export interface ScannerStatus {
  /** Ids covered: [from, to). Null until the first scan completes. */
  from: string | null;
  to: string | null;
  /** True when the gap is wider than MAX_SPAN and its oldest ids are not scanned. */
  partial: boolean;
  lastScanAt: string | null;
  lastError: string | null;
}

export class V4TokenScanner {
  private owners = new Map<bigint, string>();
  private from: bigint | null = null;
  private to: bigint | null = null;
  private partial = false;
  private lastFullScan = 0;
  private lastScanAt: Date | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly source: ScannerSource,
    private readonly options: { maxSpan?: bigint; rescanMs?: number; now?: () => number } = {},
  ) {}

  start(intervalMs = SCAN_MS): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), intervalMs);
    // Never holds a process open on its own.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Concurrent calls share the pass in flight. */
  scan(): Promise<void> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async pass(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    try {
      const maxSpan = this.options.maxSpan ?? MAX_SPAN;
      const next = await this.source.next();
      // PositionManager's first id is 1.
      const from = next > maxSpan + 1n ? next - maxSpan : 1n;
      const partial = from > 1n;

      const full =
        this.from === null ||
        this.to === null ||
        now - this.lastFullScan >= (this.options.rescanMs ?? RESCAN_MS) ||
        from > this.to;
      if (full) {
        const owners = from < next ? await this.source.owners(from, next) : new Map<bigint, string>();
        this.owners = owners;
        this.lastFullScan = now;
      } else {
        // Only the ids minted since the last pass; drop any that have slid
        // out of the bottom of the window.
        const start = this.to! > from ? this.to! : from;
        if (start < next) {
          const fresh = await this.source.owners(start, next);
          for (const [id, owner] of fresh) this.owners.set(id, owner);
        }
        for (const id of this.owners.keys()) if (id < from) this.owners.delete(id);
      }
      this.from = from;
      this.to = next;
      this.partial = partial;
      this.lastScanAt = new Date(now);
      this.lastError = null;
    } catch (e) {
      // The last good map stays; the next pass tries again.
      this.lastError = (e as Error).message.split('\n')[0].slice(0, 200);
    }
  }

  /** The scanned ids this wallet held at the last scan. Candidates only — confirm before showing. */
  owned(owner: string): bigint[] {
    const who = owner.toLowerCase();
    const out: bigint[] = [];
    for (const [id, holder] of this.owners) if (holder === who) out.push(id);
    return out.sort((a, b) => (a < b ? -1 : 1));
  }

  /**
   * Whether the portfolio can rely on the scan: a pass has completed, the
   * last one did not fail, it is recent, and the window covers every id.
   * Anything else is reported to the page as a possibly incomplete list.
   */
  complete(now = (this.options.now ?? Date.now)()): boolean {
    return (
      this.lastScanAt !== null &&
      this.lastError === null &&
      !this.partial &&
      now - this.lastScanAt.getTime() < 3 * SCAN_MS
    );
  }

  status(): ScannerStatus {
    return {
      from: this.from?.toString() ?? null,
      to: this.to?.toString() ?? null,
      partial: this.partial,
      lastScanAt: this.lastScanAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }
}
