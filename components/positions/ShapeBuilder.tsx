'use client';

import { useMemo, useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { BinChart } from '@/components/positions/BinChart';
import { useMintFlow } from '@/components/positions/useMintFlow';
import { EXPLORER_URL, NATIVE_ETH } from '@/lib/chain';
import type { ShapeId } from '@/lib/data/types';
import { price as fmtPrice } from '@/lib/format';
import { MAX_BINS, MIN_BINS, SHAPES, shapeWeights } from '@/lib/shapes';
import { amount as fmtAmount, num } from '@/lib/v4/format';
import { yieldPct } from '@/lib/yield';

/** Simulated data has no wallet, so the spendable balance is a fixed stand-in. */
const MAX_DEPOSIT_ETH = 4.18;
/** Ether to leave behind for gas when the deposit is in ether. */
const GAS_RESERVE_WEI = 500_000_000_000_000n; // 0.0005 ETH

const SHAPE_ICONS: Record<ShapeId, number[]> = {
  spot: [20, 20, 20, 20, 20, 20, 20, 20],
  curve: [6, 11, 17, 21, 21, 17, 11, 6],
  bidask: [21, 16, 11, 6, 6, 11, 16, 21],
};

export function ShapeBuilder() {
  const { pools, global } = useMarket();
  const { wallet } = useUi();

  const stakeablePools = pools.filter((p) => p.stakeable);
  const [poolId, setPoolId] = useState(stakeablePools[0]?.id ?? pools[0].id);
  const [amount, setAmount] = useState('2.5');
  const [shape, setShape] = useState<ShapeId>('spot');
  const [minPct, setMinPct] = useState(-15);
  const [maxPct, setMaxPct] = useState(15);
  const [bins, setBins] = useState(24);

  const pool = pools.find((p) => p.id === poolId) ?? pools[0];
  const shapeMeta = SHAPES.find((s) => s.id === shape)!;
  const weights = useMemo(() => shapeWeights(shape, bins), [shape, bins]);

  const eth = Number.parseFloat(amount) || 0;
  const onChain = Boolean(pool.key);

  // The inputs, before anything the chain has to say.
  const problems: string[] = [];
  if (!Number.isFinite(eth) || eth <= 0) problems.push('Enter a deposit amount.');
  else if (!onChain && eth > MAX_DEPOSIT_ETH) problems.push(`Deposit is above your balance of ${MAX_DEPOSIT_ETH} ETH.`);
  if (maxPct <= minPct) problems.push('Max must be above Min.');
  if (minPct > 0) problems.push('Min must be at or below the current price.');
  if (maxPct < 0) problems.push('Max must be at or above the current price.');
  const inputsValid = problems.length === 0;

  const flow = useMintFlow({ pool, deposit: amount, minPct, maxPct, bins, shape, valid: inputsValid });

  const quoteSymbol = !flow.sides
    ? pool.quote
    : flow.sides.quoteCurrency.toLowerCase() === NATIVE_ETH
      ? 'ETH'
      : pool.quote === 'ETH'
        ? 'WETH'
        : pool.quote;
  const tokenSymbol = pool.token.symbol;

  // What the chain says: the plan's two sides against the wallet's balances.
  if (onChain && inputsValid) {
    if (flow.planError) problems.push(flow.planError);
    if (flow.needs && flow.balances && flow.sides) {
      const reserve = flow.sides.quoteCurrency.toLowerCase() === NATIVE_ETH ? GAS_RESERVE_WEI : 0n;
      if (flow.balances.quote < flow.needs.quote + reserve) {
        problems.push(
          `Deposit is above your balance of ${fmtAmount(flow.balances.quote, flow.sides.quoteDecimals)} ${quoteSymbol}` +
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
  const lo = pool.priceUsd * (1 + safeMin / 100);
  const hi = pool.priceUsd * (1 + safeMax / 100);

  // Share of the deposit that has to sit above the current price, i.e. in the
  // token rather than in the quote — the simulated estimate of the split.
  const span = (safeMax - safeMin) / 100 || 1;
  const priceFraction = (0 - safeMin / 100) / span;
  const tokenShare = weights.reduce((acc, w, i) => acc + ((i + 0.5) / bins > priceFraction ? w : 0), 0);

  // Estimated, and labelled as such: this pool's trailing-7d yield scaled by
  // how tightly the range concentrates it. Never a forecast (§1).
  const known = pool.feeYield.basis !== 'insufficient';
  const trailing = yieldPct(pool.feeYield);
  const concentration = Math.min(6, 0.6 / span);
  const shapeFactor = shape === 'curve' ? 1.35 : shape === 'bidask' ? 0.8 : 1;
  const estYield = trailing * concentration * shapeFactor;

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
        : flow.step === 'reading'
          ? 'Reading the pool…'
          : flow.step === 'unavailable'
            ? 'Pool unreadable'
            : flow.step === 'busy'
              ? flow.busyLabel
              : flow.step === 'approve'
                ? nextApproval.kind === 'erc20'
                  ? `Approve ${approvalSymbol}`
                  : `Allow PositionManager to use ${approvalSymbol}`
                : flow.plan
                  ? `Mint ${flow.plan.positions.length} position${flow.plan.positions.length === 1 ? '' : 's'}`
                  : 'Mint position';
  const buttonDisabled =
    !valid ||
    flow.step === 'reading' ||
    flow.step === 'unavailable' ||
    flow.step === 'busy' ||
    (flow.step === 'ready' && (!flow.plan || Boolean(flow.error)));

  return (
    <div className="builder">
      <div className="card panel">
        <div className="field">
          <label htmlFor="b-token">Token</label>
          <div className="inp" style={{ height: 46 }}>
            <select id="b-token" value={poolId} onChange={(e) => setPoolId(e.target.value)}>
              {stakeablePools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.token.symbol} / {p.quote === 'ETH' ? 'ETH' : p.quote}
                </option>
              ))}
            </select>
          </div>
        </div>

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
              <span className="max">Max {MAX_DEPOSIT_ETH}</span>
            ) : flow.balances && flow.sides ? (
              <span className="max">Balance {fmtAmount(flow.balances.quote, flow.sides.quoteDecimals)}</span>
            ) : null}
          </div>
          <p className="hint">
            {onChain
              ? `Bins above the current price hold ${tokenSymbol}; bins below hold ${quoteSymbol}. You deposit both sides at today's ratio — the single-token zap comes next.`
              : `Balast swaps part of this into ${tokenSymbol} to fill the shape you choose.`}
          </p>
        </div>

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
              ? flow.step === 'approve'
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
          <span className="pill brand">{shapeMeta.label}</span>
        </div>

        <BinChart weights={weights} minPct={safeMin / 100} maxPct={safeMax / 100} currentPrice={pool.priceUsd} shape={shape} symbol={tokenSymbol} />

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
            <i style={{ background: 'var(--red)' }} />
            Current price
          </span>
        </div>

        <div className="sum">
          <div>
            <div className="k">Range</div>
            <div className="v num">
              {liveRange ? `${num(liveRange.lo)} – ${num(liveRange.hi)} ${quoteSymbol}` : `${fmtPrice(lo)} – ${fmtPrice(hi)}`}
            </div>
          </div>
          <div>
            <div className="k">Est. fee yield</div>
            <div className={`v num${known ? ' up' : ' muted'}`}>
              {known ? `${estYield.toFixed(0)}%` : '—'}
              {known && <span className="est">est. · from {trailing.toFixed(0)}% trailing</span>}
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
                  {(eth * (1 - tokenShare)).toFixed(2)} ETH ·{' '}
                  {((eth * tokenShare * global.ethPriceUsd) / pool.priceUsd).toLocaleString('en-US', { maximumFractionDigits: 1 })} {tokenSymbol}
                </>
              )}
            </div>
          </div>
          <div>
            <div className="k">Fee tier</div>
            <div className="v num">{(pool.feeTierBps / 100).toFixed(2)}%</div>
          </div>
        </div>

        <p className="hint">
          Est. fee yield scales this pool&rsquo;s trailing 7d fees by how tightly your range concentrates them. It is
          arithmetic on past fees, not a forecast, and it earns nothing while price sits outside the range.
          {onChain && !wallet ? ' Connect a wallet to see the exact amounts for your deposit.' : ''}
        </p>
      </div>
    </div>
  );
}
