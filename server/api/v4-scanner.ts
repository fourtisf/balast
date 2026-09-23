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
 * up to `nextTokenId()`. The window is NOT started at the indexer's highest
 * id: the indexer's record of an older id is only as current as its cursor,
 * so an old position sent to this wallet since then would be in neither
 * place. A chain with more ids than the window leaves the oldest unscanned,
 * and the scan says it is partial. It only DISCOVERS candidates:
 * `readV4Positions` confirms each one on chain before the portfolio shows it.
 *
 * **Progress is kept chunk by chunk.** The first version read the whole
 * window in one pass — about a hundred multicalls on public endpoints the
 * indexer is already pressing hard — and threw the pass away on any one
 * failure, so on the box it never finished once (`lastScanAt: null`). Now a
 * pass does at most `CHUNKS_PER_PASS` chunks of `CHUNK` ids: new ids first,
 * then the next part of a sweep across the window. A chunk that fails stops
 * the pass and is asked again next pass; every chunk that succeeded stays.
 * The sweep starts over every `RESCAN_MS`, which is how a transfer or a burn
 * inside the window is seen.
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
/** Ids per request: one multicall of `ownerOf`. */
export const CHUNK = 500n;
/** Requests per pass, so the scan never competes with the indexer for the endpoints' allowance. */
export const CHUNKS_PER_PASS = 10;

export interface ScannerStatus {
  /** The window: [from, to). Null until `nextTokenId` has been read once. */
  from: string | null;
  to: string | null;
  /** How far the current sweep across the window has got, and whether one has ever finished. */
  sweptTo: string | null;
  swept: boolean;
  /** True when the chain has more ids than the window and the oldest are not scanned. */
  partial: boolean;
  lastScanAt: string | null;
  lastError: string | null;
}

/**
 * An endpoint's error without its URL's path or query: a paid endpoint puts
 * its key there, and this text reaches `/api/health`. The host stays, since
 * which endpoint refused is the useful part.
 */
export function redactEndpoints(message: string): string {
  return message.replace(/https?:\/\/\S+/g, (match) => {
    // The failover writes `url: reason`, so a trailing colon is punctuation.
    const trailing = match.endsWith(':') ? ':' : '';
    const url = trailing ? match.slice(0, -1) : match;
    try {
      return new URL(url).host + trailing;
    } catch {
      return `[endpoint]${trailing}`;
    }
  });
}

export class V4TokenScanner {
  private owners = new Map<bigint, string>();
  private from: bigint | null = null;
  private to: bigint | null = null;
  /** The newest `nextTokenId` whose ids have all been read at least once. */
  private seenTo: bigint | null = null;
  /** The sweep in progress: where it has got to, and where it ends. */
  private sweep: { at: bigint; end: bigint; startedAt: number } | null = null;
  private lastSweepDone = -Infinity;
  private everSwept = false;
  private partial = false;
  private lastScanAt: Date | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly source: ScannerSource,
    private readonly options: {
      maxSpan?: bigint;
      rescanMs?: number;
      chunk?: bigint;
      chunksPerPass?: number;
      now?: () => number;
      log?: (line: string) => void;
    } = {},
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

  /** Read [from, to) and make the map agree with it: found ids set, missing ids (burned, or never minted) cleared. */
  private async read(from: bigint, to: bigint): Promise<void> {
    const found = await this.source.owners(from, to);
    for (const id of [...this.owners.keys()]) if (id >= from && id < to && !found.has(id)) this.owners.delete(id);
    for (const [id, owner] of found) this.owners.set(id, owner);
  }

  private async pass(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const chunk = this.options.chunk ?? CHUNK;
    let budget = this.options.chunksPerPass ?? CHUNKS_PER_PASS;
    try {
      const maxSpan = this.options.maxSpan ?? MAX_SPAN;
      const next = await this.source.next();
      // PositionManager's first id is 1.
      const from = next > maxSpan + 1n ? next - maxSpan : 1n;
      this.from = from;
      this.to = next;
      this.partial = from > 1n;
      for (const id of [...this.owners.keys()]) if (id < from) this.owners.delete(id);

      // New ids first: a position minted a minute ago is the one most likely
      // to be looked for.
      if (this.seenTo === null) this.seenTo = next;
      let at = this.seenTo < from ? from : this.seenTo;
      while (at < next && budget > 0) {
        const end = at + chunk < next ? at + chunk : next;
        await this.read(at, end);
        at = end;
        this.seenTo = end;
        budget -= 1;
      }

      // Then the sweep across the window, resumed where the last pass left it.
      if (!this.sweep && now - this.lastSweepDone >= (this.options.rescanMs ?? RESCAN_MS)) {
        this.sweep = { at: from, end: this.seenTo ?? next, startedAt: now };
      }
      while (this.sweep && budget > 0) {
        if (this.sweep.at < from) this.sweep.at = from;
        if (this.sweep.at >= this.sweep.end) {
          this.sweep = null;
          this.lastSweepDone = now;
          this.everSwept = true;
          break;
        }
        const end = this.sweep.at + chunk < this.sweep.end ? this.sweep.at + chunk : this.sweep.end;
        await this.read(this.sweep.at, end);
        this.sweep.at = end;
        budget -= 1;
      }
      if (this.sweep && this.sweep.at >= this.sweep.end) {
        this.sweep = null;
        this.lastSweepDone = now;
        this.everSwept = true;
      }

      this.lastScanAt = new Date(now);
      if (this.lastError !== null) this.options.log?.('v4 scan: recovered');
      this.lastError = null;
    } catch (e) {
      // Everything read so far stays; the next pass resumes from here. The
      // whole reason — every endpoint's answer, URLs trimmed to their host —
      // is kept, because "failed on all 4 endpoints" alone says nothing.
      const reason = redactEndpoints((e as Error).message).replace(/\s*\n\s*/g, ' | ').slice(0, 600);
      if (reason !== this.lastError) this.options.log?.(`v4 scan: ${reason}`);
      this.lastError = reason;
    }
  }

  /** The scanned ids this wallet held when last read. Candidates only — confirm before showing. */
  owned(owner: string): bigint[] {
    const who = owner.toLowerCase();
    const out: bigint[] = [];
    for (const [id, holder] of this.owners) if (holder === who) out.push(id);
    return out.sort((a, b) => (a < b ? -1 : 1));
  }

  /**
   * Whether the portfolio can rely on the scan: a sweep has finished at least
   * once, the new ids have been read, the last pass did not fail and is
   * recent, and the window covers every id. Anything else is reported to the
   * page as a possibly incomplete list.
   */
  complete(now = (this.options.now ?? Date.now)()): boolean {
    return (
      this.everSwept &&
      this.lastScanAt !== null &&
      this.lastError === null &&
      !this.partial &&
      this.seenTo !== null &&
      this.to !== null &&
      this.seenTo >= this.to &&
      now - this.lastScanAt.getTime() < 3 * SCAN_MS
    );
  }

  status(): ScannerStatus {
    return {
      from: this.from?.toString() ?? null,
      to: this.to?.toString() ?? null,
      sweptTo: this.sweep ? this.sweep.at.toString() : this.everSwept ? (this.seenTo?.toString() ?? null) : null,
      swept: this.everSwept,
      partial: this.partial,
      lastScanAt: this.lastScanAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }
}
