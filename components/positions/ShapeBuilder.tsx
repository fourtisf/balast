'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { BinChart } from '@/components/positions/BinChart';
import { DEFAULT_SLIPPAGE_BPS, useMintFlow } from '@/components/positions/useMintFlow';
import { CHAIN, EXPLORER_URL, NATIVE_ETH } from '@/lib/chain';
import { DATA_SOURCE } from '@/lib/data';
import type { Pool, ShapeId } from '@/lib/data/types';
import { ageLabel, feeTierLabel, price as fmtPrice, quoteIsWrappedEther, quoteLabel, usd } from '@/lib/format';
import {
  shownYield,
  stalenessText,
  yieldBasisShort,
  yieldCaption,
  yieldLabel,
  yieldTitle,
  yieldValue,
} from '@/lib/market-figures';
import { isMintable, orderMarkets, poolLiquidityUsd, quoteGroups } from '@/lib/markets';
import { densityAtPrice, MAX_BINS, MIN_BINS, SHAPES, shapeWeights } from '@/lib/shapes';
import { amount as fmtAmount, num } from '@/lib/v4/format';


/** Simulated data has no wallet, so the spendable balance is a fixed stand-in. */
const MAX_DEPOSIT_ETH = 4.18;

/**
 * The simulated wallet's balance, in the currency the chosen market is
 * quoted in.
 *
 * It is 4.18 ether; over a USDG market the field read `0.1 USDG · Max 4.18`,
 * which says the wallet holds four dollars. The prototype had one quote and
 * never met this. Live data reads the wallet instead and never comes here.
 */
function simulatedMax(pool: Pool, ethPriceUsd: number): number {
  return pool.quote === 'USDG' ? MAX_DEPOSIT_ETH * ethPriceUsd : MAX_DEPOSIT_ETH;
}
/** Ether to leave behind for gas when the deposit is in ether. */
const GAS_RESERVE_WEI = 500_000_000_000_000n; // 0.0005 ETH
/**
 * A first deposit a wallet is likely to hold: a tenth of an ether, or a
 * hundred dollars for a pool quoted in USDG. The old flat default of 2.5
 * opened the drawer's hand-off on "above your balance" for most wallets
 * (§22).
 */
function defaultDeposit(pool: Pool): string {
  return pool.quote === 'USDG' ? '100' : '0.1';
}

/** Slippage tolerances offered, in basis points. */
const SLIPPAGE_CHOICES = [50, 100, 300] as const;

const SHAPE_ICONS: Record<ShapeId, number[]> = {
  spot: [20, 20, 20, 20, 20, 20, 20, 20],
  curve: [6, 11, 17, 21, 21, 17, 11, 6],
  bidask: [21, 16, 11, 6, 6, 11, 16, 21],
};

/**
 * The builder needs a pool it may mint into. When the listing has none — no
 * pool listed at all, or every listed pool running a hook Balast has not
 * verified — it says so. It used to plan against `pools[0]`, which threw on
 * an empty listing and, on a listing with no verified pool, quietly offered
 * an unverified one that the select could not even show.
 */
/**
 * A pool's name among the others quoted in the same currency: its fee tier,
 * and the wrapper marked only where two pools would otherwise read alike.
 *
 * An ether pair is named ETH however the pool holds it (§27), so a token
 * with both a native and a wrapped pool at the same tier would show one
 * label twice. Naming the wrapper everywhere would put the distinction back
 * on every row, which is the thing the one name removed.
 */
function tierLabel(market: Pool, siblings: Pool[]): string {
  const base = feeTierLabel(market.feeTierBps);
  const clash = siblings.some((m) => m.id !== market.id && feeTierLabel(m.feeTierBps) === base);
  if (!clash) return base;
  // Two pools at one tier in one currency: say what separates them. The
  // protocol first, since a v3 and a v4 pool at the same tier are entirely
  // different pools; then the wrapper, for two v4 pools that differ only in
  // how they hold ether.
  if (siblings.some((m) => m.protocol !== market.protocol)) return `${base} · ${market.protocol}`;
  return quoteIsWrappedEther(market) ? `${base} · wrapped` : base;
}

export function ShapeBuilder() {
  const { pools, otherPools } = useMarket();
  const live = DATA_SOURCE === 'live';
  // The board keeps one pool per token (§20); a token's other markets ride
  // beside it. Here they matter: the pair is what a person is choosing, and
  // which currency it is quoted in decides whether their wallet can enter it.
  const everyPool = useMemo(() => [...pools, ...(otherPools ?? [])], [pools, otherPools]);
  const stakeablePools = everyPool.filter((p) => isMintable(p, live));
  if (stakeablePools.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <b>{everyPool.length === 0 ? 'Nothing to mint into yet' : 'No pool is offered for minting'}</b>
          {everyPool.length === 0
            ? 'No pool is listed yet. The builder opens on the first one the indexer lists.'
            : 'Every listed pool runs a hook Balast has not verified. A hook can refuse liquidity ' +
              'or take most of every trade as its fee, so none is offered until someone has looked ' +
              '(STAKEABLE_HOOKS).'}
        </div>
      </div>
    );
  }
  return <Builder pools={everyPool} stakeablePools={stakeablePools} live={live} />;
}

function Builder({ pools, stakeablePools, live }: { pools: Pool[]; stakeablePools: Pool[]; live: boolean }) {
  const { global, indexerLagSeconds } = useMarket();
  const { wallet, showToast } = useUi();

  // The drawer hands over here: ?pool= picks the pool, ?range=full is a stake.
  const params = useSearchParams();
  const wantedPool = params.get('pool');
  const wantedFull = params.get('range') === 'full';

  const [poolId, setPoolId] = useState(
    () => stakeablePools.find((p) => p.id === wantedPool)?.id ?? stakeablePools[0].id,
  );
  const [amount, setAmount] = useState(() =>
    defaultDeposit(stakeablePools.find((p) => p.id === wantedPool) ?? stakeablePools[0]),
  );
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [shape, setShape] = useState<ShapeId>('spot');
  const [minPct, setMinPct] = useState(-15);
  const [maxPct, setMaxPct] = useState(15);
  const [bins, setBins] = useState(24);
  const [fullRange, setFullRange] = useState(wantedFull);
  // The pools can arrive after the first render; honour the link once they do.
  useEffect(() => {
    if (wantedPool && pools.some((p) => p.id === wantedPool && isMintable(p, live))) setPoolId(wantedPool);
  }, [wantedPool, pools.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const pool = stakeablePools.find((p) => p.id === poolId) ?? stakeablePools[0];

  /**
   * A link that named a pool this builder cannot offer.
   *
   * The drawer hands over a pool it has already checked, so this is a
   * bookmarked link or a pool that has since fallen below the listing bar.
   * Either way the builder used to open on a different token without saying
   * so — the person asked for one market and got another.
   */
  const wantedMissing =
    wantedPool !== null && pool.id !== wantedPool && !pools.some((p) => p.id === wantedPool && isMintable(p, live));

  /**
   * Switch market, and re-default the deposit when the currency changes.
   *
   * A hundred is a sensible first deposit in USDG and a hundred ether is not.
   * Left alone, moving from a token's USDG market to its ether one carried
   * the number across and opened on "above your balance" — the same fault
   * §22 fixed for the drawer's hand-off, arriving by another door. A figure
   * the person typed themselves is theirs and is kept.
   */
  const choose = (id: string): void => {
    const next = stakeablePools.find((p) => p.id === id);
    if (!next) return;
    if (amount === defaultDeposit(pool) && defaultDeposit(next) !== defaultDeposit(pool)) {
      setAmount(defaultDeposit(next));
    }
    setPoolId(id);
  };

  /**
   * The two questions, asked separately: which token, then which of its
   * markets.
   *
   * One flat list of every pool answered neither. Choosing VIRTUAL meant
   * scrolling past TENOV, TISM, TSLA and VEX to find it, and once found its
   * other markets were somewhere else in the same alphabet rather than in
   * front of you. The token is the thing a person came here with; the pair
   * and the fee tier are what they choose once they have it.
   */
  const tokens = useMemo(() => {
    const byToken = new Map<string, Pool[]>();
    for (const p of stakeablePools) {
      const key = p.token.address.toLowerCase();
      const list = byToken.get(key);
      if (list) list.push(p);
      else byToken.set(key, [p]);
    }
    // A token's other listed markets that cannot be minted into — on the
    // live site, its v3 pools. They are named rather than silently dropped:
    // a person looking for a pair they can see on the board should be told
    // why it is not offered here, not left to wonder.
    const byUnmintable = new Map<string, Pool[]>();
    for (const p of pools) {
      if (isMintable(p, live)) continue;
      const key = p.token.address.toLowerCase();
      if (!byToken.has(key)) continue;
      const list = byUnmintable.get(key);
      if (list) list.push(p);
      else byUnmintable.set(key, [p]);
    }
    // A ticker is not unique on this chain — there are two CASHCATs (§24) —
    // so a repeated symbol carries the end of its own address, which is the
    // only honest way to tell two of them apart.
    const perSymbol = new Map<string, number>();
    for (const [, list] of byToken) {
      const symbol = list[0].token.symbol.toUpperCase();
      perSymbol.set(symbol, (perSymbol.get(symbol) ?? 0) + 1);
    }
    return [...byToken.entries()]
      .map(([address, list]) => {
        const markets = orderMarkets(list);
        const symbol = markets[0].token.symbol;
        const ambiguous = (perSymbol.get(symbol.toUpperCase()) ?? 0) > 1;
        return {
          address,
          symbol,
          label: ambiguous ? `${symbol} · ${address.slice(-4)}` : symbol,
          markets,
          // Listed and traded, but not something this builder can mint into.
          unmintable: (byUnmintable.get(address) ?? []).slice().sort((a, b) => b.tvlUsd - a.tvlUsd),
        };
      })
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.address.localeCompare(b.address));
  }, [stakeablePools, pools, live]);

  const token = tokens.find((t) => t.markets.some((m) => m.id === pool.id)) ?? tokens[0];

  /**
   * The chosen token's markets, grouped by what the wallet pays with.
   *
   * Two questions, asked separately for the same reason the token and the
   * market were split (§26): the quote currency is a choice with two or
   * three answers, and the pool is a choice only the pool's own liquidity
   * can settle.
   */
  const groups = useMemo(() => quoteGroups(token.markets), [token]);
  const group = groups.find((g) => g.markets.some((m) => m.id === pool.id)) ?? groups[0];
  const shapeMeta = SHAPES.find((s) => s.id === shape)!;
  const weights = useMemo(() => (fullRange ? [1] : shapeWeights(shape, bins)), [shape, bins, fullRange]);

  const eth = Number.parseFloat(amount) || 0;
  const onChain = Boolean(pool.key);

  // The inputs, before anything the chain has to say.
  const problems: string[] = [];
  const simMax = simulatedMax(pool, global.ethPriceUsd);
  if (!Number.isFinite(eth) || eth <= 0) problems.push('Enter a deposit amount.');
  else if (!onChain && eth > simMax)
    problems.push(`Deposit is above your balance of ${num(simMax)} ${quoteLabel(pool)}.`);
  if (!fullRange) {
    if (maxPct <= minPct) problems.push('Max must be above Min.');
    if (minPct > 0) problems.push('Min must be at or below the current price.');
    if (maxPct < 0) problems.push('Max must be at or above the current price.');
  }
  const inputsValid = problems.length === 0;

  const flow = useMintFlow({
    pool,
    deposit: amount,
    minPct,
    maxPct,
    bins: fullRange ? 1 : bins,
    shape: fullRange ? 'spot' : shape,
    fullRange,
    slippageBps,
    valid: inputsValid,
  });

  const quoteSymbol = quoteLabel(pool);
  const tokenSymbol = pool.token.symbol;
  // The pool holds its ether as aeWETH rather than natively. The page calls
  // both ETH (§27); this is the one thing that still follows from it — the
  // mint spends the wrapped token, so the wallet's ether is wrapped first.
  // Only asserted of a pool that exists: a simulated one has no key, and
  // saying what its mint would wrap is a claim about nothing.
  const wrapped = onChain && quoteIsWrappedEther(pool);

  // What the chain says: the plan's two sides against the wallet's balances.
  if (onChain && inputsValid) {
    if (flow.planError) problems.push(flow.planError);
    if (flow.needs && flow.balances && flow.sides) {
      const reserve = flow.sides.quoteCurrency.toLowerCase() === NATIVE_ETH ? GAS_RESERVE_WEI : 0n;
      // One balance for an ether market, whichever way the pool holds it:
      // a wrapped one counts the ether that would be wrapped for it, since
      // the page calls both ETH and the mint wraps what is missing.
      const spendable = flow.quoteSpendable ?? flow.balances.quote;
      if (spendable < flow.needs.quote + reserve) {
        problems.push(
          `Deposit is above your balance of ${fmtAmount(spendable, flow.sides.quoteDecimals)} ${quoteSymbol}` +
            (reserve > 0n ? ', keeping a little for gas.' : '.'),
        );
      }
      if (flow.balances.token < flow.needs.token) {
        problems.push(
          `This shape also needs ${fmtAmount(flow.needs.token, flow.sides.tokenDecimals)} ${tokenSymbol}; the wallet holds ` +
            `${fmtAmount(flow.balances.token, flow.sides.tokenDecimals)}. Hold both sides for now — the single-token zap is next.`,
        );
      }
    }
  }
  const valid = problems.length === 0;

  // Draw against a sane range even while the inputs are mid-edit.
  const safeMin = Math.min(minPct, 0);
  const safeMax = Math.max(maxPct, safeMin + 1);
  // The token's price NOW, in dollars: the chain's slot0 in the quote, times
  // the quote's dollar price; else the head reader's; the indexer's only as a
  // last resort. The axis read the indexer's alone — $0.46–$0.62 beside a
  // live price of 0.75 — because that one is as old as its last block.
  const quoteUsd = pool.quote === 'USDG' ? 1 : global.ethPriceUsd;
  const priceNowUsd =
    flow.live && quoteUsd > 0 ? flow.live.tokenPriceInQuote * quoteUsd : (pool.now?.priceUsd ?? pool.priceUsd);
  const lo = priceNowUsd * (1 + safeMin / 100);
  const hi = priceNowUsd * (1 + safeMax / 100);

  // Share of the deposit that has to sit above the current price, i.e. in the
  // token rather than in the quote — the simulated estimate of the split.
  const span = (safeMax - safeMin) / 100 || 1;
  const priceFraction = (0 - safeMin / 100) / span;
  // A full-range position holds both sides about equally in value at the
  // current price; a shaped one holds whatever its bins above the price weigh.
  const tokenShare = fullRange
    ? 0.5
    : weights.reduce((acc, w, i) => acc + ((i + 0.5) / bins > priceFraction ? w : 0), 0);

  // Estimated, and labelled as such: this pool's trailing-7d yield scaled by
  // how tightly the range concentrates it. Never a forecast (§1). Full range
  // is the pool's own yield: no concentration at all.
  const shownY = shownYield(pool);
  const known = shownY.pct !== null;
  const trailing = shownY.pct ?? 0;
  // What the shape puts where the price is, as a multiple of an even spread
  // over the same range. Only the bin holding the price earns, so this is
  // the whole difference between the shapes — and it is arithmetic on the
  // weights the person chose, not the constant per shape it replaced
  // (1.35 for curve, 0.8 for bid-ask), which was invented and flattered the
  // shape that holds the least where it counts.
  const density = fullRange ? 1 : densityAtPrice(weights, safeMin / 100, safeMax / 100);
  const concentration = fullRange ? 1 : Math.min(6, (0.6 / span) * density);
  const estYield = trailing * concentration;

  // The range the plan actually covers, in the quote, from its aligned ticks.
  const liveRange = useMemo(() => {
    if (!flow.plan || !flow.sides || !pool.key) return null;
    const at = (tick: number) => {
      const p = 1.0001 ** tick * 10 ** (pool.key!.decimals0 - pool.key!.decimals1);
      return flow.sides!.tokenIsCurrency0 ? p : 1 / p;
    };
    const a = at(flow.plan.tickLower);
    const b = at(flow.plan.tickUpper);
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }, [flow.plan, flow.sides, pool.key]);

  const setWidth = (w: number) => {
    setMinPct(-w);
    setMaxPct(w);
  };

  const nextApproval = flow.approvals[0];
  const approvalSymbol = nextApproval
    ? nextApproval.token.toLowerCase() === flow.sides?.tokenCurrency.toLowerCase()
      ? tokenSymbol
      : quoteSymbol
    : '';
  const buttonLabel =
    flow.step === 'simulated'
      ? 'Mint position'
      : flow.step === 'connect'
        ? 'Connect wallet to mint'
        : flow.step === 'wrong-chain'
          ? `Switch to ${CHAIN.name}`
        : flow.step === 'reading'
          ? 'Reading the pool…'
          : flow.step === 'unavailable'
            ? 'Pool unreadable'
            : flow.step === 'busy'
              ? flow.busyLabel
              : flow.step === 'wrap'
                ? `Wrap ${fmtAmount(flow.wrap!.shortfall, 18)} ETH for this pool`
              : flow.step === 'approve'
                ? nextApproval.kind === 'erc20'
                  ? `Approve ${approvalSymbol}`
                  : `Allow PositionManager to use ${approvalSymbol}`
                : flow.plan
                  ? `Mint ${flow.plan.positions.length} position${flow.plan.positions.length === 1 ? '' : 's'}`
                  : 'Mint position';
  // Switching networks is always allowed; the inputs are judged once it has.
  const buttonDisabled =
    flow.step !== 'wrong-chain' &&
    (!valid ||
    flow.step === 'reading' ||
    flow.step === 'unavailable' ||
    flow.step === 'busy' ||
    (flow.step === 'ready' && (!flow.plan || Boolean(flow.error))));

  return (
    <div className="builder">
      <div className="card panel">
        {wantedMissing && (
          <div className="note" style={{ marginBottom: 16 }} role="status">
            <b>That market is not offered here</b>
            <p className="hint">
              The pool the link named is not one this builder can mint into — it is a Uniswap v3
              pool, or it no longer clears the listing bar. It is showing {pool.token.symbol} /{' '}
              {quoteLabel(pool)} instead; pick the market you want below.
            </p>
          </div>
        )}
        <div className="field">
          <label htmlFor="b-token">Token</label>
          <div className="inp" style={{ height: 46 }}>
            <select
              id="b-token"
              value={token.address}
              onChange={(e) => {
                // Its deepest market, which is the one the board's row is.
                const picked = tokens.find((t) => t.address === e.target.value);
                if (picked) choose(picked.markets[0].id);
              }}
            >
              {tokens.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {/* Which token this is, exactly: a ticker is not unique here (two
              CASHCATs), and a site that asks for a wallet should show the
              contract it is about to put money next to. */}
          {pool.token.address.toLowerCase() === NATIVE_ETH ? (
            <p className="hint" style={{ marginTop: 8 }}>
              Ether is the chain&rsquo;s native asset: no contract.
            </p>
          ) : (
            <div className="ca" style={{ marginTop: 8 }} data-testid="token-ca">
              <code className="num" title={pool.token.address}>
                {pool.token.address}
              </code>
              <div className="ca-actions">
                <button
                  type="button"
                  className="btn btn-ghost sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(pool.token.address);
                      showToast(`${pool.token.symbol} contract address copied`);
                    } catch {
                      showToast('Could not copy — select the address instead');
                    }
                  }}
                >
                  Copy
                </button>
                <a
                  className="btn btn-ghost sm"
                  href={`${EXPLORER_URL}/token/${pool.token.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Explorer
                </a>
              </div>
            </div>
          )}
        </div>

        {/* This token's markets. A pair is a different pool to be in: the
            quote currency decides whether a wallet can enter at all, and the
            fee tier decides what the position earns. Shown even when there is
            one, so what you are in is on screen rather than implied. */}
        <div className="field">
          <span className="lbl" id="market-label">
            Market
          </span>
          <div className="seg wrap" role="group" aria-labelledby="market-label">
            {groups.map((g) => (
              <button
                key={g.label}
                className={g.label === group.label ? 'on' : undefined}
                aria-pressed={g.label === group.label}
                onClick={() => choose(g.markets[0].id)}
              >
                {g.label}
              </button>
            ))}
          </div>
          <p className="hint">
            {groups.length === 1
              ? `${token.symbol} trades against ${group.label} here, and nothing else this builder can mint into. A pool with no real money behind it is not offered.`
              : `The currency the deposit below is counted in. A position holds both sides, so the mint takes some ${group.label} and some ${token.symbol}.`}
            {wrapped
              ? ` This pool holds its ether as aeWETH — one token per ether, the same asset — so the mint wraps what your wallet is short of and spends that.`
              : ''}
            {token.unmintable.length > 0 &&
              ` ${token.unmintable.length} more ${token.symbol} pool${
                token.unmintable.length === 1 ? '' : 's'
              } (${[...new Set(token.unmintable.map((m) => quoteLabel(m)))].join(', ')}) ${
                token.unmintable.length === 1 ? 'runs a hook' : 'run hooks'
              } Balast has not verified, so ${token.unmintable.length === 1 ? 'it is' : 'they are'} listed but not offered here.`}
          </p>
        </div>

        {/* Which of that currency's pools. A fee tier alone is not a choice
            anybody can make — v4 lets a pool carry any fee its key names, so
            on this chain a token can have six ether pools at six arbitrary
            tiers. The pool's own liquidity is what settles it, so it is on
            the option rather than a click away. */}
        {group.markets.length > 1 && (
          <div className="field">
            <span className="lbl" id="tier-label">
              Fee tier
            </span>
            <div className="seg wrap" role="group" aria-labelledby="tier-label">
              {group.markets.map((m) => {
                const depth = poolLiquidityUsd(m);
                return (
                  <button
                    key={m.id}
                    className={m.id === pool.id ? 'on' : undefined}
                    aria-pressed={m.id === pool.id}
                    onClick={() => choose(m.id)}
                    title={
                      depth === null
                        ? 'This pool\u2019s liquidity cannot be reconstructed from its own events yet.'
                        : `${usd(depth)} of liquidity in this pool`
                    }
                  >
                    {tierLabel(m, group.markets)}{' '}
                    <span className="num" style={{ opacity: 0.7 }}>
                      {depth === null ? '—' : usd(depth)}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="hint">
              What every trade in the pool pays, and what the position earns a share of. The figure
              beside each is that pool&rsquo;s own liquidity — {group.markets.length} pools quote{' '}
              {token.symbol} in {group.label} here, and the deepest is the one the board&rsquo;s row
              is. A higher tier earns more per trade and usually sees fewer of them.
              {group.markets.some((m) => poolLiquidityUsd(m) === null) &&
                ' A dash means the indexer cannot reconstruct that pool\u2019s liquidity from its own events, so its depth is unknown rather than zero — the pool is listed because it has traded.'}
            </p>
          </div>
        )}

        <div className="field">
          <label htmlFor="b-amount">Deposit</label>
          <div className="inp">
            <input
              id="b-amount"
              type="number"
              min="0"
              step="0.1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="unit">{quoteSymbol}</span>
            {!onChain ? (
              <span className="max">Max {num(simMax)}</span>
            ) : flow.balances && flow.sides ? (
              /* One figure, because the page calls both ways of holding ether
                 ETH and the mint wraps what is missing. A wrapped market used
                 to show its wrapped balance alone — a zero beside a wallet
                 full of ether, which reads as "you cannot do this". */
              <span
                className="max"
                title={
                  wrapped
                    ? `${fmtAmount(flow.balances.quote, flow.sides.quoteDecimals)} held as aeWETH, ` +
                      `${fmtAmount(flow.balances.native, 18)} held natively`
                    : undefined
                }
              >
                Balance {fmtAmount(flow.quoteSpendable ?? flow.balances.quote, flow.sides.quoteDecimals)}
              </span>
            ) : null}
          </div>
          <p className="hint">
            {onChain
              ? `Bins above the current price hold ${tokenSymbol}; bins below hold ${quoteSymbol}. You deposit both sides at today's ratio — the single-token zap comes next.`
              : `Balast swaps part of this into ${tokenSymbol} to fill the shape you choose.`}
          </p>
        </div>

        {onChain && (
          <div className="field">
            <span className="lbl" id="slippage-label">
              Slippage
            </span>
            <div className="seg" role="group" aria-labelledby="slippage-label">
              {SLIPPAGE_CHOICES.map((bps) => (
                <button
                  key={bps}
                  className={slippageBps === bps ? 'on' : undefined}
                  aria-pressed={slippageBps === bps}
                  onClick={() => setSlippageBps(bps)}
                >
                  {(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%
                </button>
              ))}
            </div>
            <p className="hint">
              How much more than the amounts shown the mint may take if the price moves before it is included.
              Past that it reverts and nothing is taken.
            </p>
          </div>
        )}

        <div className="field">
          <label className="lbl" htmlFor="b-full" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              id="b-full"
              type="checkbox"
              checked={fullRange}
              onChange={(e) => setFullRange(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: 'var(--ac)' }}
            />
            Full range · a stake
          </label>
          <p className="hint">
            {fullRange
              ? 'One position across the whole price line: never out of range, earns this pool\u2019s fee on every trade, the least concentrated a position can be. Untick to shape it.'
              : 'Tick to stake instead: one full-range position, no shape and no bins to choose.'}
          </p>
        </div>

        {!fullRange && (<>
        <div className="field">
          <span className="lbl" id="shape-label">
            Shape
          </span>
          <div className="shape" role="group" aria-labelledby="shape-label">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                className={shape === s.id ? 'on' : undefined}
                aria-pressed={shape === s.id}
                onClick={() => setShape(s.id)}
              >
                <svg viewBox="0 0 52 24" aria-hidden="true">
                  {SHAPE_ICONS[s.id].map((h, i) => (
                    <rect key={i} x={2 + i * 6} y={24 - h} width={4} height={h} />
                  ))}
                </svg>
                {s.label}
              </button>
            ))}
          </div>
          <p className="hint">{shapeMeta.hint}</p>
          <p className="hint">
            Across {bins} bins it holds{' '}
            {shape === 'spot' ? (
              <>exactly what an even spread does at the current price</>
            ) : (
              <>
                <b className="num">{density >= 10 ? density.toFixed(0) : density >= 1 ? density.toFixed(2) : density.toFixed(2)}×</b>{' '}
                an even spread at the current price
              </>
            )}
            . Only the bin holding the price earns a fee, so that is the whole difference between
            the three — and it is what scales the estimate on the right.
          </p>
        </div>

        <div className="field">
          <span className="lbl">Price range</span>
          <div className="rangebox">
            <div className="inp sm">
              <label className="unit" htmlFor="b-min" style={{ fontSize: 12 }}>
                Min
              </label>
              <input id="b-min" type="number" step="1" value={minPct} onChange={(e) => setMinPct(Number(e.target.value))} />
              <span className="unit">%</span>
            </div>
            <div className="inp sm">
              <label className="unit" htmlFor="b-max" style={{ fontSize: 12 }}>
                Max
              </label>
              <input id="b-max" type="number" step="1" value={maxPct} onChange={(e) => setMaxPct(Number(e.target.value))} />
              <span className="unit">%</span>
            </div>
          </div>
          <label className="sr-only" htmlFor="b-width">
            Symmetric range width, percent
          </label>
          <input
            className="range"
            id="b-width"
            type="range"
            min="2"
            max="60"
            value={Math.round(Math.max(Math.abs(minPct), Math.abs(maxPct)))}
            onChange={(e) => setWidth(Number(e.target.value))}
            style={{ marginTop: 10 }}
          />
          <p className="hint">
            Tighter range earns more per dollar while price stays inside, and nothing once it leaves.
          </p>
        </div>

        <div className="field">
          <label htmlFor="b-bins">
            Bins <span className="muted" style={{ fontWeight: 400 }}>· {bins}</span>
          </label>
          <input className="range" id="b-bins" type="range" min={MIN_BINS} max={MAX_BINS} value={bins} onChange={(e) => setBins(Number(e.target.value))} />
          <p className="hint">
            Up to {MAX_BINS} bins in one transaction — past that, two transactions are cheaper.
            {flow.plan && flow.plan.positions.length < bins
              ? ` This range fits ${flow.plan.positions.length} at the pool's tick spacing.`
              : ''}
          </p>
        </div>
        </>)}

        <button
          className="btn btn-brand"
          style={{ width: '100%', justifyContent: 'center', height: 46 }}
          disabled={buttonDisabled}
          onClick={() => void flow.run()}
        >
          {buttonLabel}
        </button>
        {!valid ? (
          <p className="hint down" style={{ textAlign: 'center', marginTop: 8 }} role="alert">
            {problems[0]}
          </p>
        ) : flow.error ? (
          <p className="hint down" style={{ textAlign: 'center', marginTop: 8 }} role="alert">
            {flow.error}
          </p>
        ) : flow.liveError ? (
          <p className="hint down" style={{ textAlign: 'center', marginTop: 8 }} role="alert">
            {flow.liveError}
          </p>
        ) : flow.result ? (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            {flow.result.minted} position{flow.result.minted === 1 ? '' : 's'} minted to your wallet.{' '}
            <a href={`${EXPLORER_URL}/tx/${flow.result.hash}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
              View the transaction
            </a>
          </p>
        ) : (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            {onChain
              ? flow.step === 'wrong-chain'
                ? `The wallet is on another network. Nothing is sent until it is on ${CHAIN.name}; the price shown is read from the chain's public RPC.`
                : flow.step === 'wrap'
                ? `This pool holds its ether as aeWETH. One transaction wraps ${fmtAmount(flow.wrap!.shortfall, 18)} of your ETH into the same amount of it — one token per ether, no price and nothing to slip — and the mint follows.`
              : flow.step === 'approve'
                ? `${flow.approvals.length} approval${flow.approvals.length === 1 ? '' : 's'} first, then one transaction to mint. Nothing is held by Balast.`
                : `One transaction through Uniswap's PositionManager${flow.plan ? `: ${flow.plan.positions.length} position${flow.plan.positions.length === 1 ? '' : 's'}, each an NFT in your wallet` : ''}. Nothing is held by Balast.`
              : 'One transaction. You keep the NFT.'}
          </p>
        )}
      </div>

      <div className="card viz">
        <div className="viz-h">
          <div>
            <span className="t">
              {tokenSymbol} / {quoteSymbol}
            </span>{' '}
            <span className="sub">
              · current price{' '}
              {flow.live ? (
                <>
                  <span className="num">
                    {num(flow.live.tokenPriceInQuote)} {quoteSymbol}
                  </span>{' '}
                  on chain
                </>
              ) : (
                <span className="num">{fmtPrice(pool.priceUsd)}</span>
              )}
            </span>
          </div>
          <span className="pill brand">{fullRange ? 'Full range' : shapeMeta.label}</span>
        </div>

        {fullRange ? (
          <div className="note" style={{ margin: '12px 0' }}>
            <b>Full range</b>
            <p className="hint">
              The position covers every price the pool can reach, so it holds both {tokenSymbol} and{' '}
              {quoteSymbol} at today&rsquo;s ratio and is never out of range. It earns the pool&rsquo;s
              fee on every trade, spread over the whole line rather than concentrated around the price.
            </p>
          </div>
        ) : (
          <BinChart weights={weights} minPct={safeMin / 100} maxPct={safeMax / 100} currentPrice={priceNowUsd} shape={shape} symbol={tokenSymbol} />
        )}

        {/* The legend reads the bin chart, and a full-range position draws
            none — it was describing a picture that was not on screen. */}
        {!fullRange && (
          <div className="legend">
            <span>
              <i style={{ background: 'var(--ac)' }} />
              Token side (above price)
            </span>
            <span>
              <i style={{ background: 'var(--ac-soft)' }} />
              {quoteSymbol} side
            </span>
            <span>
              <i style={{ background: 'var(--fg-2)' }} />
              Current price
            </span>
          </div>
        )}

        <div className="sum">
          <div>
            <div className="k">Range</div>
            {/* A full-range position runs to the lowest and highest ticks the
                spacing allows, which as a price is 0 and about 1e38. Printed
                literally that was `0 – 337,815,857,900,711,430,000,000,000,
                000,000,000,000 ETH`, four lines of a number that means "every
                price" and reads as a fault. */}
            <div className="v num">
              {fullRange
                ? '0 → ∞'
                : liveRange
                  ? `${num(liveRange.lo)} – ${num(liveRange.hi)} ${quoteSymbol}`
                  : `${fmtPrice(lo)} – ${fmtPrice(hi)}`}
            </div>
          </div>
          <div>
            {/* Full range concentrates nothing, so the figure is not an
                estimate of anything — it is this pool's own trailing yield,
                and it is labelled the way the board and the drawer label it
                (§7). Calling it `est. · from 1445% trailing` over the same
                1445% read as a projection stacked on a projection. */}
            <div className="k">{fullRange ? 'Fee yield' : 'Est. fee yield'}</div>
            <div className={`v num${known ? ' up' : ' muted'}`} title={yieldTitle(shownY)}>
              {fullRange ? yieldValue(shownY) : known ? `${estYield.toFixed(0)}%` : '—'}
              {(() => {
                const qualifier = yieldCaption(shownY, ageLabel(pool.ageHours), stalenessText(indexerLagSeconds));
                const text = fullRange
                  ? (qualifier ?? yieldBasisShort(shownY))
                  : known
                    ? `est. · from ${trailing.toFixed(0)}% · ${yieldBasisShort(shownY)}`
                    : qualifier;
                return text ? <span className="est">{text}</span> : null;
              })()}
            </div>
          </div>
          <div>
            <div className="k">{onChain ? 'You deposit' : 'Split at mint'}</div>
            <div className="v num">
              {flow.needs && flow.sides ? (
                <>
                  {fmtAmount(flow.needs.quote, flow.sides.quoteDecimals)} {quoteSymbol} · {fmtAmount(flow.needs.token, flow.sides.tokenDecimals)} {tokenSymbol}
                </>
              ) : onChain ? (
                '—'
              ) : (
                <>
                  {(eth * (1 - tokenShare)).toFixed(2)} {quoteSymbol} ·{' '}
                  {((eth * tokenShare * global.ethPriceUsd) / pool.priceUsd).toLocaleString('en-US', { maximumFractionDigits: 1 })} {tokenSymbol}
                </>
              )}
            </div>
          </div>
          <div>
            <div className="k">Fee tier</div>
            <div className="v num">{feeTierLabel(pool.feeTierBps)}</div>
          </div>
        </div>

        <p className="hint">
          {fullRange
            ? `Fee yield is this pool\u2019s own ${yieldLabel(shownY)} figure: a full-range position concentrates nothing, so there is nothing to scale. It is arithmetic on fees already paid, not a forecast.`
            : `Est. fee yield scales this pool\u2019s ${yieldLabel(shownY)} by how tightly your range concentrates them. It is arithmetic on fees already paid, not a forecast, and it earns nothing while price sits outside the range.`}
          {shownY.current && shownY.feesUsd !== null && shownY.liquidityUsd !== null
            ? ` Today: ${usd(shownY.feesUsd)} of fees over ${usd(shownY.liquidityUsd)} in the pool now, ${
                shownY.liquiditySource === 'chain' ? 'read from the pool on chain' : `per ${shownY.liquiditySource}`
              }.`
            : !shownY.current && shownY.pct !== null
              ? ' No current liquidity figure for this pool, so this is the indexer’s figure, fees and liquidity from the same day — its age is beside it.'
              : ''}
          {onChain && !wallet ? ' Connect a wallet to see the exact amounts for your deposit.' : ''}
        </p>
      </div>
    </div>
  );
}
