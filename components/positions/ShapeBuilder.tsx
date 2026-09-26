'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AskPanel } from '@/components/ask/AskPanel';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { BinChart } from '@/components/positions/BinChart';
import { MyTokenPositions } from '@/components/positions/MyTokenPositions';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { DEFAULT_SLIPPAGE_BPS, GAS_RESERVE_WEI, useMintFlow } from '@/components/positions/useMintFlow';
import { CHAIN, EXPLORER_URL, NATIVE_ETH } from '@/lib/chain';
import { DATA_SOURCE } from '@/lib/data';
import type { Pool, ShapeId } from '@/lib/data/types';
import { ageLabel, feeTierLabel, price as fmtPrice, quoteIsWrappedEther, quoteLabel, tokenPrice, usd } from '@/lib/format';
import {
  shownLiquidity,
  shownPrice,
  shownVolume,
  shownYield,
  stalenessText,
  yieldBasisShort,
  yieldCaption,
  yieldLabel,
  yieldTitle,
  yieldValue,
} from '@/lib/market-figures';
import { isMintable, orderMarkets, poolLiquidityUsd, quoteGroups } from '@/lib/markets';
import { estimateFeeYield } from '@/lib/fee-estimate';
import { densityAtPrice, MAX_BINS, MIN_BINS, SHAPES, shapeWeights } from '@/lib/shapes';
import { MIN_DATA_HOURS } from '@/lib/yield';
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
            : 'Every listed pool runs a hook LockFi has not verified. A hook can refuse liquidity ' +
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
  // A rebalance hands over the old position's width, centred on today's price.
  const wantedMin = Number(params.get('min'));
  const wantedMax = Number(params.get('max'));
  const wantedRange =
    params.get('min') !== null && Number.isFinite(wantedMin) && Number.isFinite(wantedMax) && wantedMin <= 0 && wantedMax >= 0 && wantedMax > wantedMin
      ? { min: Math.max(-99, wantedMin), max: Math.min(1000, wantedMax) }
      : null;

  const [poolId, setPoolId] = useState(
    () => stakeablePools.find((p) => p.id === wantedPool)?.id ?? stakeablePools[0].id,
  );
  const [amount, setAmount] = useState(() =>
    defaultDeposit(stakeablePools.find((p) => p.id === wantedPool) ?? stakeablePools[0]),
  );
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [shape, setShape] = useState<ShapeId>('spot');
  const [minPct, setMinPct] = useState(wantedRange?.min ?? -15);
  const [maxPct, setMaxPct] = useState(wantedRange?.max ?? 15);
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
    if (flow.zap) {
      // One side held, the other swapped for (§33): the only thing that can
      // stop it is the swap itself — too thin a pool, or too little to swap.
      if (flow.zap.problem) problems.push(flow.zap.problem);
    } else if (flow.needs && flow.balances && flow.sides) {
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
            `${fmtAmount(flow.balances.token, flow.sides.tokenDecimals)}, and not enough ${quoteSymbol} beside it to swap for the rest.`,
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

  // The pool's own figure, for the simulator and for the full-range fallback.
  const shownY = shownYield(pool);
  const known = shownY.pct !== null;
  const trailing = shownY.pct ?? 0;

  // Simulated data only: there is no chain to read, so the prototype's
  // estimate stays — the pool's yield scaled by what the shape puts at the
  // price. On a live pool this is never shown.
  const density = fullRange ? 1 : densityAtPrice(weights, safeMin / 100, safeMax / 100);
  const concentration = fullRange ? 1 : Math.min(6, (0.6 / span) * density);
  const simYield = trailing * concentration;

  // A live pool: what THIS position would have earned from today's fees. The
  // pool's active liquidity at the price and the liquidity the plan mints are
  // both read or computed in the chain's own units, so the share is exact at
  // today's price; the only assumption is that today's fees repeat and the
  // price stays in the bin it is in. It replaced the heuristic above, whose
  // 0.6 was invented and which could not see how much other LPs already hold
  // at the price: 285% for spot and 643% for curve on a pool it knew nothing
  // about (fee-estimate.ts).
  const todaysFees =
    pool.now && pool.ageHours >= MIN_DATA_HOURS && Number.isFinite(pool.now.fees24hUsd) ? pool.now.fees24hUsd : null;
  const depositUsd =
    flow.needs && flow.sides && quoteUsd > 0
      ? (Number(flow.needs.quote) / 10 ** flow.sides.quoteDecimals) * quoteUsd +
        (Number(flow.needs.token) / 10 ** flow.sides.tokenDecimals) * priceNowUsd
      : 0;
  const chainEstimate =
    onChain && flow.live && flow.plan
      ? estimateFeeYield({
          fees24hUsd: todaysFees,
          activeLiquidity: flow.live.activeLiquidity,
          positions: flow.plan.positions,
          tick: flow.live.tick,
          depositUsd,
        })
      : null;
  // Why there is no live figure, in words, for the caption.
  const chainEstimateMissing = !onChain
    ? null
    : todaysFees === null
      ? pool.ageHours < MIN_DATA_HOURS
        ? 'not enough data yet'
        : 'no fees measured today'
      : !flow.live
        ? 'reading the pool'
        : flow.live.activeLiquidity === null
          ? 'pool liquidity unreadable'
          : 'enter a deposit';
  const pctText = (pct: number) =>
    pct >= 10 ? `${Math.round(pct).toLocaleString('en-US')}%` : `${pct.toFixed(pct >= 1 ? 1 : 2)}%`;
  const dayText = (usdPerDay: number) =>
    usdPerDay >= 100 ? usd(usdPerDay) : `$${usdPerDay.toFixed(usdPerDay >= 1 ? 2 : 3)}`;
  const shareText = (share: number) =>
    share >= 0.01 ? `${(share * 100).toFixed(1)}%` : share > 0 ? `${(share * 100).toPrecision(2)}%` : '0%';

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
  // Step 1 of 2 when the wallet holds one side: what it spends and receives.
  const zapIn = flow.zap?.direction === 'quote-to-token' ? quoteSymbol : tokenSymbol;
  const zapOut = flow.zap?.direction === 'quote-to-token' ? tokenSymbol : quoteSymbol;
  const zapInDecimals = flow.sides ? (flow.zap?.direction === 'quote-to-token' ? flow.sides.quoteDecimals : flow.sides.tokenDecimals) : 18;
  const zapOutDecimals = flow.sides ? (flow.zap?.direction === 'quote-to-token' ? flow.sides.tokenDecimals : flow.sides.quoteDecimals) : 18;
  const zapButtonLabel = !flow.zap
    ? ''
    : flow.zap.problem
      ? 'Swap not offered'
      : !flow.zap.quote
        ? 'Pricing the swap…'
        : flow.zap.approvals.length > 0
          ? flow.zap.approvals[0].kind === 'erc20'
            ? `Step 1 of 2 · Approve ${zapIn} for the swap`
            : `Step 1 of 2 · Allow the router to use ${zapIn}`
          : `Step 1 of 2 · Swap ${fmtAmount(flow.zap.quote.amountIn, zapInDecimals)} ${zapIn} → ${zapOut}`;
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
              : flow.step === 'zap'
                ? zapButtonLabel
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
    (flow.step === 'zap' && (!flow.zap?.quote || Boolean(flow.zap.problem))) ||
    (flow.step === 'ready' && (!flow.plan || Boolean(flow.error))));

  // The pool header's figures, from the same choices the board makes.
  const headPrice = flow.live ? `${num(flow.live.tokenPriceInQuote)} ${quoteSymbol}` : tokenPrice(shownPrice(pool).value);
  const headLiquidity = shownLiquidity(pool).value;
  const headVolume = shownVolume(pool).value;
  // The tier that paid its LPs the most today — the one worth pointing at.
  const busiestTier = (() => {
    let best: { id: string; fees: number } | null = null;
    for (const m of group.markets) {
      const fees = m.now?.fees24hUsd ?? 0;
      if (fees > 0 && (!best || fees > best.fees)) best = { id: m.id, fees };
    }
    return best?.id ?? null;
  })();

  const statusLine = !valid ? (
    <p className="hint down status" role="alert">
      {problems[0]}
    </p>
  ) : flow.error ? (
    <p className="hint down status" role="alert">
      {flow.error}
    </p>
  ) : flow.liveError ? (
    <p className="hint down status" role="alert">
      {flow.liveError}
    </p>
  ) : flow.result ? (
    <p className="hint status">
      {flow.result.minted} position{flow.result.minted === 1 ? '' : 's'} minted to your wallet — listed below under{' '}
      <i>Your {tokenSymbol} positions</i>, with Collect and Withdraw any time.{' '}
      <a href={`${EXPLORER_URL}/tx/${flow.result.hash}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
        View the transaction
      </a>
    </p>
  ) : (
    <p className="hint status">
      {onChain
        ? flow.step === 'wrong-chain'
          ? `The wallet is on another network. Nothing is sent until it is on ${CHAIN.name}.`
          : flow.step === 'wrap'
            ? `This pool holds its ether as aeWETH. One transaction wraps ${fmtAmount(flow.wrap!.shortfall, 18)} of your ETH into the same amount of it, then the mint follows.`
            : flow.step === 'zap'
              ? flow.zap?.quote
                ? `Step 1 swaps ${fmtAmount(flow.zap.quote.amountIn, zapInDecimals)} ${zapIn} for about ${fmtAmount(flow.zap.quote.expectedOut, zapOutDecimals)} ${zapOut} in this pool through Uniswap (${(flow.zap.quote.lossBps / 100).toFixed(2)}% to fee and impact; reverts below ${fmtAmount(flow.zap.quote.minOut, zapOutDecimals)}). Step 2 ${wrapped && pool.protocol !== 'v3' ? 'wraps the ETH side and mints' : 'mints'}. Nothing is held by LockFi.`
                : `The wallet holds ${zapIn} and not enough ${zapOut}: pricing a swap for the rest in this pool.`
              : flow.step === 'approve'
                ? `${flow.approvals.length} approval${flow.approvals.length === 1 ? '' : 's'} first, then one transaction to mint. Nothing is held by LockFi.`
                : `${flow.fitted ? `Fitted to your balance: ${(flow.fitted.bps / 100).toFixed(1)}% of the deposit typed. ` : ''}One transaction through Uniswap's ${pool.protocol === 'v3' ? 'v3 position manager' : 'PositionManager'}${flow.plan ? `: ${flow.plan.positions.length} position${flow.plan.positions.length === 1 ? '' : 's'}, each an NFT in your wallet` : ''}.`
        : 'One transaction. You keep the NFT.'}
    </p>
  );

  return (
    <>
    <div className="builder dlmm">
      {wantedMissing && (
        <div className="note" role="status">
          <b>That market is not offered here</b>
          <p className="hint">
            The pool the link named is not one this builder can mint into — it is a Uniswap v3 pool, or it no
            longer clears the listing bar. It is showing {pool.token.symbol} / {quoteLabel(pool)} instead.
          </p>
        </div>
      )}

      {/* The pool, first and whole: which token, which market, and its
          figures in one strip — the way a DLMM screen opens on its pool. */}
      <header className="card pool-head">
        <div className="ph-id">
          <TokenBadge token={pool.token} className="logo ph-logo" />
          <div className="ph-main">
            <div className="ph-pick">
              <label htmlFor="b-token" className="sr-only">
                Token
              </label>
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
              <span className="ph-quote">/ {quoteSymbol}</span>
            </div>
            {/* Which token this is, exactly: a ticker is not unique here. */}
            {pool.token.address.toLowerCase() === NATIVE_ETH ? (
              <p className="ph-ca muted">Native asset · no contract</p>
            ) : (
              <div className="ca ph-ca" data-testid="token-ca">
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
                  <a className="btn btn-ghost sm" href={`${EXPLORER_URL}/token/${pool.token.address}`} target="_blank" rel="noreferrer">
                    Explorer
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
        <dl className="ph-stats">
          <div>
            <dt>Price</dt>
            <dd className="num">{headPrice}</dd>
          </div>
          <div>
            <dt>Liquidity</dt>
            <dd className="num">{headLiquidity === null ? '—' : usd(headLiquidity)}</dd>
          </div>
          <div>
            <dt>Volume 24h</dt>
            <dd className="num">{usd(headVolume)}</dd>
          </div>
          <div>
            <dt>Fees 24h</dt>
            <dd className="num">{todaysFees === null ? '—' : usd(todaysFees)}</dd>
          </div>
          <div>
            <dt>Fee tier</dt>
            <dd className="num">{feeTierLabel(pool.feeTierBps)}</dd>
          </div>
        </dl>
      </header>

      {/* This token's markets: the currency, then that currency's pools. */}
      <div className="card market-bar">
        <div className="field">
          <span className="lbl" id="market-label">
            Market
          </span>
          <div className="seg" role="group" aria-labelledby="market-label">
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
        </div>
        {group.markets.length > 1 && (
          <div className="field grow">
            <span className="lbl" id="tier-label">
              Fee tier
            </span>
            {/* Each tier is its own pool, so each option says what separates
                it from the others: what a trade pays, how much sits in it,
                and what it actually paid its LPs today. The last is the one
                that decides what a position earns, so the busiest is marked. */}
            <div className="tiers" role="group" aria-labelledby="tier-label">
              {group.markets.map((m) => {
                const depth = poolLiquidityUsd(m);
                const fees = m.now ? m.now.fees24hUsd : null;
                const busiest = m.id === busiestTier;
                return (
                  <button
                    key={m.id}
                    className={`tier${m.id === pool.id ? ' on' : ''}`}
                    aria-pressed={m.id === pool.id}
                    onClick={() => choose(m.id)}
                  >
                    <span className="tier-top">
                      <b>{tierLabel(m, group.markets)}</b>
                      {busiest && <span className="tier-tag">Most active</span>}
                    </span>
                    <span className="tier-row">
                      <span>Liquidity</span>
                      <span className="num">{depth === null ? '—' : usd(depth)}</span>
                    </span>
                    <span className="tier-row">
                      <span>Fees 24h</span>
                      <span className={`num${fees !== null && fees > 0 ? ' up' : ''}`}>{fees === null ? '—' : usd(fees)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {group.markets.length > 1 && (
        <div className="tier-explain">
          <b>What is a fee tier?</b> Every trade in a pool pays this percentage, and that money goes to the people
          providing liquidity there — you, once you deposit. Each tier is a separate pool with its own traders, so you
          earn only from the one you pick. A higher percentage earns nothing if nobody trades there: pick the pool
          with the most <i>fees 24h</i>
          {busiestTier ? ', marked Most active' : ''}.
        </div>
        )}
        <p className="hint market-note">
          {wrapped ? 'This pool holds its ether as aeWETH; the mint wraps what your wallet is short of. ' : ''}
          {token.unmintable.length > 0 &&
            `${token.unmintable.length} more ${token.symbol} pool${token.unmintable.length === 1 ? '' : 's'} (${[
              ...new Set(token.unmintable.map((m) => quoteLabel(m))),
            ].join(', ')}) ${token.unmintable.length === 1 ? 'runs a hook' : 'run hooks'} LockFi has not verified, so ${
              token.unmintable.length === 1 ? 'it is' : 'they are'
            } not offered here. `}
          {group.markets.some((m) => poolLiquidityUsd(m) === null) &&
            'A dash is a liquidity the indexer cannot reconstruct yet: unknown, not zero.'}
        </p>
      </div>

      {/* The chart, full width: the distribution is the thing being made. */}
      <section className="card viz">
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
          <div className="note fullrange-note">
            <b>Full range</b>
            <p className="hint">
              The position covers every price the pool can reach: it holds both {tokenSymbol} and {quoteSymbol} at
              today&rsquo;s ratio, is never out of range, and earns the pool&rsquo;s fee on every trade, spread over
              the whole line.
            </p>
          </div>
        ) : (
          <BinChart weights={weights} minPct={safeMin / 100} maxPct={safeMax / 100} currentPrice={priceNowUsd} shape={shape} symbol={tokenSymbol} />
        )}

        {!fullRange && (
          <div className="legend">
            <span>
              <i style={{ background: 'var(--ac)' }} />
              {tokenSymbol} side (above price)
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
      </section>

      <div className="dlmm-cols">
        {/* Strategy: how the liquidity is laid out. */}
        <div className="card panel">
          <h2 className="panel-t">Strategy</h2>
          <div className="field">
            <label className="fr-toggle" htmlFor="b-full">
              <input id="b-full" type="checkbox" checked={fullRange} onChange={(e) => setFullRange(e.target.checked)} />
              <span>
                <b>Full range</b>
                <small>One position across every price, never out of range. Untick to shape it.</small>
              </span>
            </label>
          </div>

          {!fullRange && (
            <>
              <div className="field">
                <span className="lbl" id="shape-label">
                  Shape
                </span>
                <div className="shape" role="group" aria-labelledby="shape-label">
                  {SHAPES.map((s) => (
                    <button key={s.id} className={shape === s.id ? 'on' : undefined} aria-pressed={shape === s.id} onClick={() => setShape(s.id)}>
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
                      <b className="num">{density >= 10 ? density.toFixed(0) : density.toFixed(2)}×</b> an even spread at the
                      current price
                    </>
                  )}
                  . Only the bin holding the price earns a fee.
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
              </div>

              <div className="field">
                <label htmlFor="b-bins">
                  Bins <span className="muted" style={{ fontWeight: 400 }}>· {bins}</span>
                </label>
                <input className="range" id="b-bins" type="range" min={MIN_BINS} max={MAX_BINS} value={bins} onChange={(e) => setBins(Number(e.target.value))} />
                <p className="hint">
                  Up to {MAX_BINS} in one transaction.
                  {flow.plan && flow.plan.positions.length < bins
                    ? ` This range fits ${flow.plan.positions.length} at the pool's tick spacing.`
                    : ''}
                </p>
              </div>
            </>
          )}
        </div>

        {/* Deposit: how much, what it becomes, and the one button. */}
        <div className="card panel deposit">
          <h2 className="panel-t">Deposit</h2>
          <div className="field">
            <label htmlFor="b-amount">Amount</label>
            <div className="inp big">
              <input id="b-amount" type="number" min="0" step="0.1" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <span className="unit">{quoteSymbol}</span>
              {!onChain ? (
                <span className="max">Max {num(simMax)}</span>
              ) : flow.balances && flow.sides ? (
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
                ? `Holding only ${quoteSymbol} is fine: LockFi swaps part of it for ${tokenSymbol} in this pool first, then mints.`
                : `LockFi swaps part of this into ${tokenSymbol} to fill the shape you choose.`}
            </p>
          </div>

          {onChain && (
            <div className="field">
              <span className="lbl" id="slippage-label">
                Slippage
              </span>
              <div className="seg" role="group" aria-labelledby="slippage-label">
                {SLIPPAGE_CHOICES.map((bps) => (
                  <button key={bps} className={slippageBps === bps ? 'on' : undefined} aria-pressed={slippageBps === bps} onClick={() => setSlippageBps(bps)}>
                    {(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="sum">
            <div>
              <div className="k">Range</div>
              {/* Full range is 0 to about 1e38 as a price; printed literally it
                  read as a fault. */}
              <div className="v num">
                {fullRange
                  ? '0 → ∞'
                  : liveRange
                    ? `${num(liveRange.lo)} – ${num(liveRange.hi)} ${quoteSymbol}`
                    : `${fmtPrice(lo)} – ${fmtPrice(hi)}`}
              </div>
            </div>
            <div>
              {onChain ? (
                <>
                  {/* A yearly rate, said so on the figure itself; the day's
                      dollars beneath it (fee-estimate.ts). */}
                  <div className="k">Est. fee yield · per year</div>
                  <div
                    className={`v num${chainEstimate ? ' up' : ' muted'}`}
                    title="A yearly rate: today's fees in this pool, times the share of the liquidity at the current price this position would hold, over what you deposit, times 365. Not a forecast."
                    data-testid="est-yield"
                  >
                    {chainEstimate ? `${pctText(chainEstimate.pct)} / yr` : '—'}
                    <span className="est">
                      {chainEstimate
                        ? `≈ ${dayText(chainEstimate.dailyUsd)} a day (${pctText(chainEstimate.pct / 365)}) · ${shareText(chainEstimate.share)} of fees at the price${
                            shownY.young ? ` · ${ageLabel(pool.ageHours)} old pool` : ''
                          }`
                        : chainEstimateMissing}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="k">{fullRange ? 'Fee yield' : 'Est. fee yield'}</div>
                  <div className={`v num${known ? ' up' : ' muted'}`} title={yieldTitle(shownY)}>
                    {fullRange ? yieldValue(shownY) : known ? `${simYield.toFixed(0)}%` : '—'}
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
                </>
              )}
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
          </div>

          <button className="btn btn-brand mint-btn" disabled={buttonDisabled} onClick={() => void flow.run()}>
            {buttonLabel}
          </button>
          {statusLine}

          <details className="how">
            <summary>How the estimate is worked out</summary>
            <p className="hint">
              {onChain
                ? chainEstimate && todaysFees !== null
                  ? `At the current price this position would hold ${shareText(chainEstimate.share)} of the liquidity trading there, so ${shareText(chainEstimate.share)} of the ${usd(todaysFees)} of fees this pool took in the last 24 hours: about ${dayText(chainEstimate.dailyUsd)} a day on ${usd(depositUsd)} deposited. Only liquidity at the price earns — if the price leaves your ${fullRange ? 'range' : 'bin'} or other LPs add there, it falls. Arithmetic on fees already paid, not a forecast.`
                  : `This position's share of the fees this pool took in the last 24 hours, measured against the liquidity at the current price read from the chain. It needs both, and a deposit to size the position.`
                : fullRange
                  ? `This pool’s own ${yieldLabel(shownY)} figure: a full-range position concentrates nothing, so there is nothing to scale. Arithmetic on fees already paid, not a forecast.`
                  : `This pool’s ${yieldLabel(shownY)} scaled by how tightly your range concentrates it. Arithmetic on fees already paid, not a forecast, and nothing while the price sits outside the range.`}
              {onChain && !wallet ? ' Connect a wallet to see the exact amounts for your deposit.' : ''}
            </p>
          </details>
          <AskPanel
            poolId={pool.id}
            plan={{
              fullRange,
              shape,
              minPct: safeMin,
              maxPct: safeMax,
              bins,
              deposit: Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : null,
            }}
            suggestions={[
              fullRange ? 'Why pick full range over a shape?' : `What does the ${shapeMeta.label} shape do to my fees?`,
              'What happens if the price leaves my range?',
              'Kenapa estimasi yield bisa berubah?',
            ]}
          />
        </div>
      </div>
    </div>
    <MyTokenPositions token={pool.token} />
    </>
  );
}
