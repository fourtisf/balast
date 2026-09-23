import { restorePortfolio, storePortfolio } from './portfolio-cache';
import { restoreSnapshot, storeSnapshot } from './snapshot-cache';
import { closedV3, mintedV4Ids, v3TxHints } from '../tx-history';
import type { DataProvider, MarketListener, MarketSnapshot, Portfolio, Unsubscribe, UserPosition } from './types';

/**
 * P1. The indexer-backed provider (§4).
 *
 * It fetches the snapshot the API builds from `pool_fee_hourly` and
 * `pool_state`, then holds a websocket that pushes a new one when the indexer
 * writes something — real events, debounced server-side to about a second per
 * §4.4, rather than the simulator's fixed 3.2s tick.
 *
 * Three things it deliberately does not do:
 *
 *   It never falls back to simulated data. If the API is down the snapshot
 *   stays null and the UI says so. A site that quietly swaps generated
 *   numbers in when the indexer dies is the exact dishonesty §7 is about.
 *
 *   It never computes a displayed figure. Fee yield, prices and totals all
 *   arrive settled from SQL (§4.2), so the boards and the simulator cannot
 *   drift apart.
 *
 *   It never renders a stale snapshot as current. `indexerLagSeconds` comes
 *   over the wire and the top bar shows it.
 */

/** Same origin by default: nginx proxies /api to the Fastify process. */
const API_BASE =
  (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_BASE : undefined) ?? '';

/** Backoff between reconnects, doubling to this ceiling. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * Poll as a safety net behind the socket. A websocket that dies silently — a
 * proxy idle timeout is the usual cause — would otherwise leave the page on
 * the last snapshot forever, with a lag figure frozen at whatever it was.
 */
const POLL_MS = 20_000;

function streamUrl(): string {
  if (API_BASE) return `${API_BASE.replace(/^http/, 'ws')}/api/stream`;
  if (typeof window === 'undefined') return '';
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/api/stream`;
}

export class LiveProvider implements DataProvider {
  readonly kind = 'live' as const;

  private snapshot: MarketSnapshot | null = null;
  private listeners = new Set<MarketListener>();
  private socket: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = RECONNECT_MIN_MS;
  private started = false;
  /** The wallet whose positions the portfolio carries, and the last answer for it. */
  private wallet: string | null = null;
  private portfolio: Portfolio | null = null;
  /** The wallet's read failed and nothing is on screen for it: say so rather than "loading" for ever. */
  private portfolioFailed = false;

  getSnapshot(): MarketSnapshot | null {
    return this.snapshot;
  }

  /**
   * The portfolio is per wallet, so it is not in the cached snapshot the
   * API serves everyone. It is fetched for the connected wallet, merged over
   * the snapshot's (empty) portfolio, and re-read on the poll cadence and on
   * request — after a mint, a collect or a withdrawal.
   */
  setWallet(address: string | null): void {
    const next = address ? address.toLowerCase() : null;
    if (next === this.wallet) return;
    this.wallet = next;
    // The positions this browser last read for the wallet, shown at once and
    // marked as kept until the chain answers (portfolio-cache.ts).
    this.portfolio = next ? restorePortfolio(browserStorage(), next) : null;
    this.portfolioFailed = false;
    this.reissue();
    if (next) void this.fetchPortfolio();
  }

  async refreshPortfolio(): Promise<void> {
    await this.fetchPortfolio();
  }

  subscribe(listener: MarketListener): Unsubscribe {
    this.listeners.add(listener);
    if (this.snapshot) listener(this.snapshot);
    this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  // ---------------------------------------------------------------- private --

  private start(): void {
    // Server-rendered: there is no socket and no fetch loop. The first paint
    // is the null state, and the client fills it in.
    if (typeof window === 'undefined' || this.started) return;
    this.started = true;
    // The board this browser last saw, aged, until the API answers
    // (snapshot-cache.ts). After the first paint and outside hydration, so
    // the server-rendered null state and the client agree.
    if (!this.snapshot) {
      const kept = restoreSnapshot(browserStorage());
      if (kept) {
        this.snapshot = this.withPortfolio(kept);
        this.listeners.forEach((listener) => listener(this.snapshot!));
      }
    }
    void this.fetchSnapshot();
    this.openSocket();
    this.pollTimer = setInterval(() => void this.fetchSnapshot(), POLL_MS);
  }

  private stop(): void {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      const response = await fetch(`${API_BASE}/api/snapshot`, { cache: 'no-store' });
      if (response.status === 503) {
        // The indexer has not written a block yet. Stay null: the UI shows
        // "waiting for the indexer" rather than a page of zeros.
        return;
      }
      if (!response.ok) return;
      this.accept((await response.json()) as MarketSnapshot);
    } catch {
      // Offline, or the API is restarting. The last good snapshot stays on
      // screen with its lag figure climbing, which is the honest state.
    }
    // The wallet's positions ride the same cadence.
    void this.fetchPortfolio();
  }

  private async fetchPortfolio(): Promise<void> {
    const wallet = this.wallet;
    if (!wallet) return;
    try {
      // The v4 positions this browser saw minted, so each is on the page the
      // moment its receipt is in; the API shows only what the chain confirms.
      const hints = mintedV4Ids(wallet);
      // And the transactions it sent for v3 positions, so a position minted
      // here is measured even when the explorer does not answer.
      const v3tx = v3TxHints(wallet);
      // And the v3 positions it withdrew, so what they earned stays in the totals.
      const closed = closedV3(wallet);
      const params = [
        hints.length > 0 ? `v4=${hints.join(',')}` : '',
        v3tx.length > 0 ? `v3tx=${v3tx.join(',')}` : '',
        closed.length > 0 ? `v3closed=${closed.join(',')}` : '',
      ].filter(Boolean);
      const query = params.length > 0 ? `?${params.join('&')}` : '';
      const response = await fetch(`${API_BASE}/api/portfolio/${wallet}${query}`, { cache: 'no-store' });
      if (!response.ok) {
        this.portfolioMissed(wallet);
        return;
      }
      const body = (await response.json()) as {
        wallet: string;
        positions: UserPosition[];
        netValueUsd: number;
        priceImpactUsd: number;
        pricedToday?: boolean;
        chain?: Portfolio['chain'];
        closed?: Portfolio['closed'];
      };
      // The wallet may have changed while this was in flight.
      if (this.wallet !== wallet) return;
      // v3 unreadable just now, and the API had no earlier read to fall back
      // on (it restarted): keep the v3 positions this page already showed
      // rather than drop them, marked as not re-checked. Withdraw and Collect
      // still ask the chain before anything is signed.
      let positions = body.positions;
      let chain = body.chain;
      let netValueUsd = body.netValueUsd;
      let priceImpactUsd = body.priceImpactUsd;
      const previous = this.portfolio?.wallet === wallet ? this.portfolio : null;
      if (chain?.v3Unavailable && previous) {
        const keptV3 = previous.positions.filter((p) => p.live?.protocol === 'v3');
        if (keptV3.length > 0) {
          positions = [...positions.filter((p) => p.live?.protocol !== 'v3'), ...keptV3];
          chain = { ...chain, v3Unavailable: false, v3Unchecked: true };
          netValueUsd = positions.reduce((a, p) => a + (p.valueUnknown ? 0 : p.valueUsd), 0);
          priceImpactUsd = positions.reduce((a, p) => a + (p.priceImpactUsd ?? 0), 0);
        }
      }
      this.portfolio = {
        netValueUsd,
        netChangeUsd: 0,
        netChangePct: 0,
        // Not tracked: a position's collected history is not indexed, and
        // the uncollected figure is read from the chain by the page (§7).
        feesEarnedWeth: null,
        feesEarnedUsd: null,
        priceImpactUsd,
        fees7dUsd: null,
        dailyFeesWeth: [],
        stakes: [],
        positions,
        claimableWeth: 0,
        wallet,
        pricedToday: body.pricedToday,
        chain,
        // A closed position stays closed: one read once stays in the totals
        // when a later read cannot place it (the explorer slow, the node busy).
        closed: mergeClosed(previous?.closed, body.closed),
      };
      this.portfolioFailed = false;
      storePortfolio(browserStorage(), wallet, this.portfolio);
      this.reissue();
    } catch {
      // The last answer stays; the next poll asks again.
      this.portfolioMissed(wallet);
    }
  }

  /** A read that did not answer: with nothing on screen for the wallet, the page says so. */
  private portfolioMissed(wallet: string): void {
    if (this.wallet !== wallet || this.portfolio) return;
    this.portfolioFailed = true;
    this.reissue();
  }

  /** The snapshot's portfolio, with the wallet's over it when there is one. */
  private withPortfolio(snapshot: MarketSnapshot): MarketSnapshot {
    if (!this.portfolio) {
      // A wallet whose read has not answered: the snapshot's empty portfolio
      // is not a statement about it, and is marked so the page does not say
      // "no positions yet" over positions it has not looked for.
      return this.wallet
        ? { ...snapshot, portfolio: { ...snapshot.portfolio, wallet: this.wallet, status: this.portfolioFailed ? 'error' : 'loading' } }
        : snapshot;
    }
    return { ...snapshot, portfolio: this.portfolio };
  }

  /** Re-notify with the current snapshot after the portfolio changed. */
  private reissue(): void {
    if (!this.snapshot) return;
    this.snapshot = this.withPortfolio(this.snapshot);
    this.listeners.forEach((listener) => listener(this.snapshot!));
  }

  private openSocket(): void {
    const url = streamUrl();
    if (!url || typeof WebSocket === 'undefined') return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectMs = RECONNECT_MIN_MS;
    };
    socket.onmessage = (event) => {
      try {
        this.accept(JSON.parse(event.data as string) as MarketSnapshot);
      } catch {
        /* a malformed frame is not worth tearing the stream down for */
      }
    };
    socket.onclose = () => {
      this.socket = null;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose follows, which is where the reconnect is scheduled.
    };
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
  }

  /**
   * Take a snapshot only if it is newer than the one we hold. The poll and
   * the socket race constantly, and an out-of-order snapshot would make the
   * boards jump backwards and flash a change that never happened.
   */
  private accept(next: MarketSnapshot): void {
    if (this.snapshot && next.revision <= this.snapshot.revision) return;
    this.snapshot = this.withPortfolio(next);
    this.listeners.forEach((listener) => listener(this.snapshot!));
    storeSnapshot(browserStorage(), next);
  }
}

/** localStorage when the browser allows it; a private window or a blocked origin is not an error. */
function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function mergeClosed(before: Portfolio['closed'], now: Portfolio['closed']): Portfolio['closed'] {
  if (!before?.length) return now;
  const byId = new Map(before.map((c) => [c.tokenId, c]));
  for (const c of now ?? []) byId.set(c.tokenId, c);
  return [...byId.values()];
}
