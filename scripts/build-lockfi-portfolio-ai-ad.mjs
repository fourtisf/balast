/**
 * LockFi AI on the portfolio: an ad, filmed from the real site.
 *
 *   DATA_SOURCE=sim npm run build && npx next start -p 3123   (in one shell)
 *   npm run brand:ad:portfolio                               (in another)
 *
 * Writes brand/lockfi/video/lockfi-portfolio-ai-ad.mp4: 1920 × 1080, 30 fps,
 * 34s. It opens on its own scene rather than the logo the other films share:
 * a position card whose price line leaves its range, the status flipping to
 * "earning nothing", and the question typed out. Then, with the same engine as
 * scripts/build-lockfi-ai-ad.mjs, one window of
 * /portfolio, an out-of-range position, its Ask AI button, and the answer.
 *
 * The simulator has no API, so /api/ask is answered here with a sample answer
 * written inside the assistant's rules (server/api/ask.ts): it explains what
 * waiting, rebalancing and withdrawing each do, and does not choose. The
 * footnote says the figures are illustrative and the answer is a sample.
 */
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'brand', 'lockfi', 'video');
const SITE = process.env.AD_SITE ?? 'http://localhost:3123';
const FONT_FILE = join(ROOT, 'brand', 'lockfi', '.fonts', 'InstrumentSans.ttf');
const FFMPEG =
  process.env.FFMPEG ??
  ['/usr/local/lib/python3.11/dist-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2'].find((p) =>
    existsSync(p),
  ) ??
  'ffmpeg';
const FPS = 30;
const DURATION = 34;
const W = 1920;
const H = 1080;
const ONLY = process.env.AD_FRAMES ? Number(process.env.AD_FRAMES) : null; // render a prefix while iterating
const STILLS = process.env.AD_STILLS ?? null; // a directory: save one still a second instead of encoding
if (!existsSync(FONT_FILE)) throw new Error('Run `npm run brand:lockfi` once first: it fetches Instrument Sans.');
mkdirSync(OUT, { recursive: true });

// ── The mark (components/shell/Logo.tsx) ──────────────────────────────────────
const mark = (c) =>
  `<svg viewBox="0 0 64 64"><path d="M23 53.5V22.5a9 9 0 0 1 18 0v31" fill="none" stroke="${c}" stroke-width="6.5"/>` +
  [[9.75, 41.5, 12], [28.75, 32.5, 21], [47.75, 41.5, 12]]
    .map(([x, y, h]) => `<rect x="${x}" y="${y}" width="6.5" height="${h}" rx="1.5" fill="${c}"/>`)
    .join('') +
  `</svg>`;

// ── The windows: one per page, each its own iframe ────────────────────────────
const WINDOWS = [
  // Narrow, so the position list is large enough to read; tall, so the
  // answer never runs off the bottom of the page.
  { id: 'port', path: '/portfolio', h: 1500, w: 1080, url: 'lockfi.org/portfolio' },
];
const CHROME = 46; // the browser bar, in iframe pixels

const SPARK =
  '<svg viewBox="0 0 20 20"><g fill="none" stroke="#93C5FD" stroke-width="1.6" stroke-linejoin="round">' +
  '<path d="M9 3.5c.5 2.8 1.7 4 4.5 4.5-2.8.5-4 1.7-4.5 4.5-.5-2.8-1.7-4-4.5-4.5 2.8-.5 4-1.7 4.5-4.5Z"/>' +
  '<path d="M15 12c.3 1.5.9 2.1 2.5 2.5-1.6.4-2.2 1-2.5 2.5-.3-1.5-.9-2.1-2.5-2.5 1.6-.4 2.2-1 2.5-2.5Z"/></g></svg>';
// The opening's chart: a price that wanders inside the range, then leaves it.
const BAND = [78, 150];
const PRICE = [
  [0, 124], [40, 118], [80, 128], [120, 112], [160, 120], [200, 104], [240, 114], [280, 98], [320, 108],
  [360, 94], [400, 102], [440, 86], [470, 80], [500, 66], [530, 58], [560, 44], [600, 40], [640, 30], [700, 26],
];
const MOONCAT = `data:image/svg+xml;base64,${readFileSync(join(ROOT, 'public', 'tokens', 'demo', 'mooncat.svg')).toString('base64')}`;
const words = (s) =>
  s
    .split(' ')
    .map((w) => `<span class="w"><span>${w}</span></span>`)
    .join(' ');

const STAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'Instrument Sans';src:url(data:font/ttf;base64,${readFileSync(FONT_FILE).toString('base64')}) format('truetype');font-weight:400 700;font-stretch:75% 100%}
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#06070A}
body{font-family:'Instrument Sans',sans-serif;color:#EDEEF1;-webkit-font-smoothing:antialiased}
#stage{position:absolute;inset:0;overflow:hidden;background:#06070A}
#glow{position:absolute;width:1500px;height:1100px;border-radius:50%;background:radial-gradient(closest-side,rgba(59,130,246,.30),rgba(59,130,246,.08) 55%,transparent);filter:blur(10px)}
#grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:80px 80px;-webkit-mask-image:radial-gradient(ellipse 70% 70% at 50% 45%,#000 10%,transparent 72%)}
.win{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform,opacity}
.tilt{transform-origin:50% 100%}
.frame{border-radius:18px;overflow:hidden;background:#0A0B0D;border:1px solid rgba(255,255,255,.10);
  box-shadow:0 0 0 1px rgba(0,0,0,.6),0 60px 140px -30px rgba(0,0,0,.95),0 0 120px -20px rgba(59,130,246,.35)}
.bar{height:${CHROME}px;display:flex;align-items:center;gap:8px;padding:0 18px;background:#111215;border-bottom:1px solid rgba(255,255,255,.06)}
.bar i{width:12px;height:12px;border-radius:50%;background:#2A2C33}
.url{margin:0 auto;display:flex;align-items:center;gap:8px;height:28px;padding:0 16px;border-radius:8px;background:#0A0B0D;border:1px solid rgba(255,255,255,.06);font-size:14px;color:#9A9EA8;transform:translateX(-30px)}
.url svg{width:12px;height:12px}
iframe{display:block;border:0;width:1440px}
#scrim{position:absolute;left:0;right:0;bottom:0;height:520px;background:linear-gradient(0deg,rgba(6,7,10,.96) 0%,rgba(6,7,10,.82) 38%,transparent 100%)}
#cap{position:absolute;left:120px;bottom:96px;width:1200px}
.eyebrow{display:inline-flex;align-items:center;gap:10px;height:34px;padding:0 16px;border-radius:99px;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.34);color:#93C5FD;font-size:14px;font-weight:600;letter-spacing:.16em;text-transform:uppercase}
.eyebrow i{width:7px;height:7px;border-radius:50%;background:#3B82F6;box-shadow:0 0 12px #3B82F6}
#cap h2{margin-top:20px;font-size:62px;line-height:1.02;letter-spacing:-.04em;font-weight:700}
#cap h2 b,.blue{color:#93C5FD;font-weight:700}
#cap p{margin-top:18px;font-size:25px;line-height:1.4;color:#A7ABB5;font-weight:500;max-width:980px}
#brand{position:absolute;left:120px;top:72px;display:flex;align-items:center;gap:14px}
.tile{display:grid;place-items:center;background:linear-gradient(160deg,#2A2C33 0%,#0D0E11 55%,#030304 100%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.22),inset 0 0 0 1px rgba(255,255,255,.13),0 18px 40px -16px rgba(0,0,0,.95)}
.tile svg{width:74%;height:74%}
#brand .tile{width:44px;height:44px;border-radius:11px}
#brand b{font-size:30px;letter-spacing:-.04em}
#foot{position:absolute;right:120px;bottom:58px;font-size:15px;color:#6B6F7A;font-weight:500;letter-spacing:.02em}
.center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
#intro .lock{display:flex;align-items:center;gap:30px}
#intro .tile{width:150px;height:150px;border-radius:36px;position:relative}
#intro .ring{position:absolute;inset:-2px;border-radius:38px;border:2px solid rgba(147,197,253,.7)}
#intro .word{font-size:124px;font-weight:700;letter-spacing:-.05em}
#intro .tag{margin-top:40px;font-size:32px;color:#A7ABB5;font-weight:500;display:flex;align-items:center;gap:14px}
.spark{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:12px;background:rgba(59,130,246,.14);border:1px solid rgba(59,130,246,.4)}
.spark svg{width:26px;height:26px}
.kin{font-size:108px;line-height:1.02;font-weight:700;letter-spacing:-.05em}
.kin .w{display:inline-block;overflow:hidden;vertical-align:bottom;padding-bottom:.08em}
.kin .w>span{display:inline-block}
#trio .rows{display:flex;flex-direction:column;align-items:flex-start}
#trio .row{display:flex;align-items:center;gap:30px;font-size:96px;font-weight:700;letter-spacing:-.05em;line-height:1.18}
#trio .chk{width:78px;height:78px;border-radius:20px;display:grid;place-items:center;background:rgba(59,130,246,.14);border:1px solid rgba(59,130,246,.4)}
#trio .chk svg{width:44px;height:44px}
#trio .sub{margin-top:40px;font-size:34px;color:#A7ABB5;font-weight:500}
#end .tile{width:112px;height:112px;border-radius:28px}
#end .lock{display:flex;align-items:center;gap:24px}
#end .lock b{font-size:88px;letter-spacing:-.05em}
#end h1{margin-top:46px;font-size:84px;line-height:1.02;letter-spacing:-.045em;font-weight:700}
#end .cta{margin-top:50px;display:flex;align-items:center;gap:22px}
#end .btn{height:76px;padding:0 44px;border-radius:16px;display:flex;align-items:center;font-size:32px;font-weight:700;background:#2563EB;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 20px 50px -14px rgba(37,99,235,.9)}
#end .ghost{height:76px;padding:0 34px;border-radius:16px;display:flex;align-items:center;font-size:30px;font-weight:600;color:#EDEEF1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12)}
#end .small{margin-top:40px;font-size:22px;color:#6B6F7A;font-weight:500;letter-spacing:.02em}
#black{position:absolute;inset:0;background:#000}
#open{gap:34px}
.pcard{width:820px;padding:30px 34px 22px;border-radius:26px;background:linear-gradient(180deg,#121419,#0B0C10);border:1px solid rgba(255,255,255,.10);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 50px 120px -30px rgba(0,0,0,.95),0 0 140px -30px rgba(59,130,246,.45);text-align:left}
.ph{display:flex;align-items:center;gap:18px}
.ph img{width:64px;height:64px;border-radius:50%;background:#1b1d24}
.ph b{display:block;font-size:34px;letter-spacing:-.03em}
.ph span{font-size:19px;color:#8B8F99;font-weight:500}
.pill{margin-left:auto;display:inline-flex;align-items:center;gap:10px;height:44px;padding:0 18px;border-radius:99px;font-size:19px!important;font-weight:600!important;white-space:nowrap}
.pill i{width:9px;height:9px;border-radius:50%}
.pill.in{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.4);color:#86EFAC!important}
.pill.in i{background:#22C55E;box-shadow:0 0 12px #22C55E}
.pill.out{background:rgba(229,72,77,.14);border:1px solid rgba(229,72,77,.5);color:#FCA5A5!important}
.pill.out i{background:#E5484D;box-shadow:0 0 14px #E5484D}
.chart{display:block;width:100%;height:auto;margin-top:18px;overflow:visible}
.bandl{font-size:15px;fill:#93C5FD;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.chat{width:820px;height:78px;border-radius:20px;display:flex;align-items:center;gap:16px;padding:0 14px 0 22px;background:#0E1014;border:1px solid rgba(255,255,255,.12);
  box-shadow:0 30px 80px -30px rgba(0,0,0,.9);font-size:27px;font-weight:500;color:#EDEEF1;text-align:left}
.chat .spark{flex:none}
#typed{white-space:pre}
#caret{width:2px;height:32px;background:#93C5FD;margin-left:-12px}
.send{margin-left:auto;height:52px;padding:0 26px;border-radius:14px;display:flex;align-items:center;font-size:22px;font-weight:700;background:#2563EB;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 14px 36px -12px rgba(37,99,235,.9)}
#glow,#grid,#scrim,#tscrim,#cap,#brand,#foot,.center,#black{pointer-events:none}
#tscrim{position:absolute;left:0;right:0;top:0;height:230px;background:linear-gradient(180deg,rgba(6,7,10,.92) 0%,rgba(6,7,10,.6) 45%,transparent 100%)}
</style></head><body><div id="stage">
<div id="glow"></div><div id="grid"></div>
${WINDOWS.map(
  (w) => `<div class="win" id="w-${w.id}"><div class="tilt"><div class="frame">
  <div class="bar"><i></i><i></i><i></i><span class="url"><svg viewBox="0 0 12 12"><rect x="2" y="5" width="8" height="6" rx="1.5" fill="#6B6F7A"/><path d="M4 5V3.6a2 2 0 0 1 4 0V5" fill="none" stroke="#6B6F7A" stroke-width="1.3"/></svg>${w.url}</span></div>
  <iframe name="${w.id}" src="${SITE}${w.path}" scrolling="no" style="height:${w.h}px;width:${w.w ?? 1440}px"></iframe></div></div></div>`,
).join('')}
<div id="scrim"></div><div id="tscrim"></div>
<div id="brand"><span class="tile">${mark('#EDEEF1')}</span><b>LockFi</b></div>
<div id="cap"><span class="eyebrow"><i></i><span id="eb"></span></span><h2 id="ch"></h2><p id="cp"></p></div>
<div id="foot">Product preview · illustrative figures · sample answer</div>
<div class="center" id="open">
  <div class="pcard">
    <div class="ph"><img src="${MOONCAT}" alt=""><div><b>MOONCAT / ETH</b><span>#2044 · Bid-ask · \u00b140%</span></div>
      <span class="pill in" id="pill"><i></i><span id="pilltxt">In range \u00b7 earning fees</span></span></div>
    <svg class="chart" viewBox="0 0 700 172">
      <defs><clipPath id="reveal"><rect id="revealr" x="-10" y="0" width="0" height="172"/></clipPath>
        <linearGradient id="bandg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#3B82F6" stop-opacity=".20"/><stop offset="1" stop-color="#3B82F6" stop-opacity=".08"/></linearGradient></defs>
      <rect id="band" x="0" y="${BAND[0]}" width="700" height="${BAND[1] - BAND[0]}" fill="url(#bandg)"/>
      <line x1="0" x2="700" y1="${BAND[0]}" y2="${BAND[0]}" stroke="#3B82F6" stroke-opacity=".55" stroke-dasharray="6 7"/>
      <line x1="0" x2="700" y1="${BAND[1]}" y2="${BAND[1]}" stroke="#3B82F6" stroke-opacity=".55" stroke-dasharray="6 7"/>
      <text x="690" y="${BAND[1] - 10}" text-anchor="end" class="bandl">your range</text>
      <polyline clip-path="url(#reveal)" id="price" points="${PRICE.map(([x, y]) => x + ',' + y).join(' ')}" fill="none" stroke="#EDEEF1" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle id="head" r="7" fill="#EDEEF1"/><circle id="headring" r="16" fill="none" stroke="#EDEEF1" stroke-opacity=".35"/>
    </svg>
  </div>
  <div class="chat"><span class="spark">${SPARK}</span><span id="typed"></span><span id="caret"></span><span class="send" id="send">Ask</span></div>
</div>
<div class="center" id="k2"><div class="kin">${words('Don\u2019t guess.')}<br><span class="blue">${words('Just ask.')}</span></div></div>
<div class="center" id="trio"><div class="rows">
  ${['Your positions.', 'Plain answers.', 'Your decision.']
    .map(
      (s) =>
        `<div class="row"><span class="chk"><svg viewBox="0 0 20 20"><path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="#93C5FD" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>${s}</div>`,
    )
    .join('')}</div>
  <div class="sub">It explains what each choice does. Never which to make.</div></div>
<div class="center" id="end"><div class="lock"><span class="tile">${mark('#EDEEF1')}</span><b>LockFi</b></div>
  <h1>Ask about<br><span class="blue">your positions.</span></h1>
  <div class="cta"><span class="btn">lockfi.org/portfolio</span><span class="ghost">@lockfiorg</span></div>
  <div class="small">Built on Uniswap · CA coming soon</div></div>
<div id="black"></div>
</div>
<script>
const CH = ${CHROME};
const PRICE = ${JSON.stringify(PRICE)};
const BAND = ${JSON.stringify(BAND)};
const $ = (s) => document.querySelector(s);
const clamp = (x) => Math.max(0, Math.min(1, x));
const p = (t, a, b) => clamp((t - a) / (b - a));
const eo = (x) => 1 - Math.pow(1 - x, 3);
const eio = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const expo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const lerp = (a, b, x) => a + (b - a) * x;
const show = (el, o) => { el.style.opacity = o; el.style.visibility = o <= 0.001 ? 'hidden' : 'visible'; };

// Camera: iframe point (cx, cy) lands at stage (960, sy) at zoom z.
const CAM = {
  port: [
    { t: 0, cx: 580, cy: 420, z: 1.12, sy: 500 },
    { t: 10.4, cx: 580, cy: 420, z: 1.1, sy: 500 },
    { t: 11.8, cx: 700, cy: 600, z: 1.35, sy: 470 },
    { t: 13.4, cx: 700, cy: 610, z: 1.35, sy: 470 },
    { t: 14.8, cx: 600, cy: 780, z: 1.5, sy: 470 },
    { t: 16.4, cx: 580, cy: 880, z: 1.6, sy: 500 },
    { t: 25.6, cx: 580, cy: 905, z: 1.62, sy: 510 },
  ],
};
function cam(id, t) {
  const k = CAM[id];
  if (t <= k[0].t) return k[0];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i].t) {
      const a = k[i - 1], b = k[i], x = eio(p(t, a.t, b.t));
      return { cx: lerp(a.cx, b.cx, x), cy: lerp(a.cy, b.cy, x), z: lerp(a.z, b.z, x), sy: lerp(a.sy, b.sy, x) };
    }
  }
  return k[k.length - 1];
}
// Which window is on screen, and how it enters and leaves.
const LIFE = { port: [7.8, 9.0, 25.6, 26.4] };
const state = {};
function placeWindow(id, t) {
  const el = $('#w-' + id), [a, b, c, d] = LIFE[id];
  const vin = eo(p(t, a, b)), vout = p(t, c, d);
  const o = Math.min(vin, 1 - eo(vout));
  show(el, o);
  if (o <= 0) { state[id] = null; return; }
  const k = cam(id, t);
  const z = k.z * lerp(1, 1.05, eio(vout));
  const lift = lerp(360, 0, vin);
  const tx = 960 - z * k.cx, ty = k.sy - z * k.cy + lift;
  el.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
  el.querySelector('.tilt').style.transform = 'perspective(2600px) rotateX(' + lerp(22, 0, vin) + 'deg)';
  state[id] = { tx, ty: ty + CH * z, z };
}
// Map an iframe point to the stage, for the real mouse.
window.mapPoint = (id, x, y) => { const s = state[id]; return s ? { x: s.tx + x * s.z, y: s.ty + y * s.z } : null; };

const CAPS = [
  [8.7, 12.4, 'Portfolio', 'Every position, <b>in one place.</b>', 'In range or out, value, fees earned and price impact, read from your wallet.'],
  [13.2, 18.8, 'Ask AI', 'Ask about <b>your own position.</b>', 'Why it is out of range, what it is earning, what price impact means.'],
  [19.3, 25.4, 'Your decision', 'Every option explained. <b>Your call.</b>', 'Wait, rebalance or withdraw: what each does and costs. It never decides for you.'],
];
let capNow = -1;
function captions(t) {
  const i = CAPS.findIndex(([a, b]) => t >= a - 0.01 && t <= b + 0.45);
  const cap = $('#cap');
  if (i < 0) { show(cap, 0); return; }
  const [a, b, eb, h, pp] = CAPS[i];
  if (capNow !== i) { $('#eb').textContent = eb; $('#ch').innerHTML = h; $('#cp').textContent = pp; capNow = i; }
  const vin = eo(p(t, a, a + 0.6)), vout = p(t, b, b + 0.45);
  show(cap, Math.min(vin, 1 - vout));
  cap.style.transform = 'translateY(' + lerp(26, 0, vin) + 'px)';
  $('#ch').style.filter = 'blur(' + lerp(8, 0, vin) + 'px)';
  $('#cp').style.opacity = eo(p(t, a + 0.25, a + 0.85));
}
function kinetic(sel, t, a, b, stagger) {
  const el = $(sel);
  const o = t >= a - 0.05 && t <= b + 0.5 ? 1 : 0;
  show(el, o);
  if (!o) return;
  const out = eio(p(t, b, b + 0.45));
  el.querySelectorAll('.w>span').forEach((w, i) => {
    const x = expo(p(t, a + i * stagger, a + i * stagger + 0.7));
    w.style.transform = 'translateY(' + lerp(110, 0, x) + '%)';
  });
  el.style.opacity = 1 - out;
  el.style.transform = 'translateY(' + lerp(0, -30, out) + 'px)';
  el.style.filter = 'blur(' + lerp(0, 10, out) + 'px)';
}
window.render = (t) => {
  // background glow drifts behind everything
  const g = $('#glow');
  g.style.left = (960 - 750 + Math.sin(t * 0.22) * 260) + 'px';
  g.style.top = (-260 + Math.cos(t * 0.17) * 120) + 'px';
  g.style.opacity = t < 30.4 ? 1 : 1.25;

  // opening: a position leaves its range, then the question is typed
  const open = $('#open');
  const oIn = expo(p(t, 0.3, 1.2)), oOut = eio(p(t, 5.9, 6.4));
  show(open, t < 6.45 ? Math.min(oIn, 1 - oOut) : 0);
  open.style.transform = 'translateY(' + lerp(50, 0, oIn) + 'px) scale(' + lerp(1, 0.94, oOut) + ')';
  open.style.filter = 'blur(' + (lerp(12, 0, oIn) + lerp(0, 14, oOut)) + 'px)';
  // the price draws left to right; the head is the latest price
  const drawX = 700 * eio(p(t, 0.9, 3.4));
  $('#revealr').setAttribute('width', drawX);
  let hx = 0, hy = PRICE[0][1];
  for (let i = 1; i < PRICE.length; i++) {
    const [x0, y0] = PRICE[i - 1], [x1, y1] = PRICE[i];
    if (drawX <= x1) { const f = (drawX - x0) / (x1 - x0); hx = drawX; hy = y0 + (y1 - y0) * Math.max(0, f); break; }
    hx = x1; hy = y1;
  }
  const head = $('#head'), hr = $('#headring');
  head.setAttribute('cx', hx); head.setAttribute('cy', hy);
  hr.setAttribute('cx', hx); hr.setAttribute('cy', hy);
  const out = hy < BAND[0];
  const pill = $('#pill');
  pill.className = 'pill ' + (out ? 'out' : 'in');
  $('#pilltxt').textContent = out ? 'Out of range \u00b7 earning nothing' : 'In range \u00b7 earning fees';
  head.setAttribute('fill', out ? '#E5484D' : '#EDEEF1');
  hr.setAttribute('stroke', out ? '#E5484D' : '#EDEEF1');
  hr.setAttribute('r', 12 + 6 * Math.sin(t * 6));
  $('#band').setAttribute('fill-opacity', out ? 0.55 : 1);
  // the question, typed
  const Q = 'Why is my position earning nothing?';
  const typed = Math.floor(Q.length * p(t, 3.8, 5.3));
  $('#typed').textContent = Q.slice(0, typed);
  $('#caret').style.opacity = t < 5.3 ? (Math.floor(t * 2.4) % 2 ? 0.2 : 1) : 0;
  const press = p(t, 5.45, 5.75);
  $('#send').style.transform = 'scale(' + (press > 0 && press < 1 ? lerp(0.92, 1, press) : 1) + ')';
  $('#send').style.filter = press > 0 && press < 1 ? 'brightness(1.35)' : 'none';

  kinetic('#k2', t, 6.35, 7.4, 0.08);

  placeWindow('port', t);
  const product = Math.min(eo(p(t, 7.9, 8.6)), 1 - eo(p(t, 25.6, 26.4)));
  show($('#scrim'), product);
  show($('#tscrim'), product);
  show($('#brand'), product);
  show($('#foot'), product);
  captions(t);

  // trio
  const trio = $('#trio');
  const tOut = eio(p(t, 29.9, 30.45));
  show(trio, t >= 26.2 && t <= 30.5 ? 1 - tOut : 0);
  trio.querySelectorAll('.row').forEach((r, i) => {
    const x = expo(p(t, 26.4 + i * 0.5, 27.2 + i * 0.5));
    r.style.opacity = x; r.style.transform = 'translateY(' + lerp(40, 0, x) + 'px)'; r.style.filter = 'blur(' + lerp(10, 0, x) + 'px)';
  });
  const sub = trio.querySelector('.sub'), sv = eo(p(t, 28.2, 28.9));
  sub.style.opacity = sv; sub.style.transform = 'translateY(' + lerp(14, 0, sv) + 'px)';

  // end card
  const end = $('#end');
  show(end, t >= 30.4 ? 1 : 0);
  const lock = end.querySelector('.lock'), lv = expo(p(t, 30.5, 31.4));
  lock.style.opacity = lv; lock.style.transform = 'scale(' + lerp(0.9, 1, lv) + ')'; lock.style.filter = 'blur(' + lerp(12, 0, lv) + 'px)';
  const h1 = end.querySelector('h1'), hv = expo(p(t, 31.0, 31.9));
  h1.style.opacity = hv; h1.style.transform = 'translateY(' + lerp(30, 0, hv) + 'px)';
  const cta = end.querySelector('.cta'), cv = eo(p(t, 31.7, 32.4));
  cta.style.opacity = cv; cta.style.transform = 'translateY(' + lerp(20, 0, cv) + 'px)';
  end.querySelector('.small').style.opacity = eo(p(t, 32.1, 32.8));

  $('#black').style.opacity = Math.max(1 - p(t, 0, 0.35), p(t, 33.3, 34));
};
window.render(0);
</script></body></html>`;

// ── What happens inside each window, per frame ────────────────────────────────
// Seeks every CSS animation to the film's clock, blurs yield figures, hides
// scrollbars, and draws the cursor.
const STEP = (s) => {
  if (!window.__ad) {
    const st = document.createElement('style');
    st.textContent = 'html,body{scrollbar-width:none}::-webkit-scrollbar{display:none}';
    document.head.appendChild(st);
    const c = document.createElement('div');
    c.id = 'ad-cur';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:26px;height:26px;filter:drop-shadow(0 4px 10px rgba(0,0,0,.6))';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2.5l15 8.6-6.4 1.6 3.8 7.2-2.9 1.5-3.8-7.3L4 18.8z" fill="#fff" stroke="#0A0B0D" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const r = document.createElement('div');
    r.id = 'ad-ring';
    r.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;width:60px;height:60px;border-radius:50%;border:2px solid rgba(147,197,253,.9);background:rgba(59,130,246,.18)';
    document.body.append(r, c);
    window.__ad = true;
  }
  for (const a of document.getAnimations()) {
    if (a.__b === undefined) a.__b = s.t;
    a.pause();
    a.currentTime = Math.max(0, s.t - a.__b);
  }
  // A yield on screen reads as a promise; blur every one.
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!/%/.test(n.nodeValue)) continue;
    const el = n.parentElement;
    let up = el;
    for (let i = 0; i < 4 && up; i++, up = up.parentElement) {
      if (/yield/i.test(up.textContent) && up.textContent.length < 260) {
        el.style.filter = 'blur(8px)';
        break;
      }
    }
  }
  // The simulator still carries the old vault's "stake · streaming" rows,
  // a feature LockFi does not have. They stay out of the film.
  for (const row of document.querySelectorAll('.pnl-row')) {
    if (/Streaming/.test(row.textContent)) row.style.display = 'none';
  }
  // An answer arrives whole; it is revealed top to bottom, as a reply is read.
  for (const a of document.querySelectorAll('.ask-a:not(.ask-wait)')) {
    if (!a.dataset.seen) a.dataset.seen = String(s.t);
    const x = Math.min(1, (s.t - Number(a.dataset.seen)) / 2600);
    const edge = x >= 1 ? 200 : -12 + x * 124;
    a.style.webkitMaskImage = a.style.maskImage =
      'linear-gradient(180deg,#000 ' + edge + '%,transparent ' + (edge + 12) + '%)';
  }
  if (s.scroll) {
    const b = document.querySelector(s.scroll.sel);
    if (b && s.scroll.follow) {
      const max = b.scrollHeight - b.clientHeight;
      b.scrollTop = b.scrollTop + (max - b.scrollTop) * 0.16;
    } else if (b) b.scrollTop = s.scroll.top;
  }
  const c = document.getElementById('ad-cur'), r = document.getElementById('ad-ring');
  c.style.display = s.cur ? 'block' : 'none';
  r.style.display = s.cur && s.cur.ring >= 0 ? 'block' : 'none';
  if (s.cur) {
    c.style.transform = `translate(${s.cur.x - 5}px,${s.cur.y - 3}px) scale(${s.cur.press ? 0.86 : 1})`;
    if (s.cur.ring >= 0) {
      r.style.transform = `translate(${s.cur.x - 30}px,${s.cur.y - 30}px) scale(${0.3 + s.cur.ring * 1.1})`;
      r.style.opacity = String(1 - s.cur.ring);
    }
  }
};

// ── The script: cursor paths and clicks, in iframe coordinates ────────────────
// Each cursor stop names an element; its centre is measured when the cursor
// first heads for it, because the board reorders while the film runs.
const OUT_ROW = '.pnl-row:has-text("out of range") >> [data-testid=ask-position]';
const CURSOR = {
  port: [
    { t: 10.8, pt: [520, 760] },
    { t: 12.5, sel: OUT_ROW },
    // measured only once the panel has opened under the row
    { t: 13.5, pt: [860, 800] },
    { t: 14.3, sel: '.pnl-ask .ask-chip >> nth=0' },
    { t: 25.4, pt: [960, 1020] },
  ],
};
const CLICKS = [
  { t: 12.6, win: 'port', kind: 'click', at: 1 },
  { t: 14.4, win: 'port', kind: 'click', at: 3 },
];
// No drawer in this film.
const DRAWER_SCROLL = { win: 'none', sel: '', t0: 0, t1: 1, target: '', offset: 0 };
const ANSWERS = [
  {
    match: /./,
    at: 15.7,
    text: 'This position is out of range: the price has moved outside the range you chose, so it earns nothing right now and holds only one of the two tokens.\n\nWhat each option does:\n- Wait: it starts earning again if the price comes back into the range. Nothing to sign, but it may not come back.\n- Rebalance: withdraws it, then opens the builder around today\u2019s price for a new position. Two transactions.\n- Withdraw: closes it; everything returns to your wallet.\n\nThe choice is yours.',
  },
];

const eio = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp = (x) => Math.max(0, Math.min(1, x));

// ── Film it ───────────────────────────────────────────────────────────────────
const PREINSTALLED = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(
  (p) => existsSync(p),
);
const browser = await chromium.launch(PREINSTALLED ? { executablePath: PREINSTALLED } : {});
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
// The simulator has no API: switch the assistant on, and answer it here.
await context.addInitScript(() => {
  try {
    window.localStorage.setItem('lockfi:ask', 'on');
  } catch {}
});
const releases = [];
await context.route('**/api/ask', async (route) => {
  if (route.request().method() === 'GET') return route.fulfill({ json: { enabled: true, provider: 'OpenRouter' } });
  const q = String(route.request().postDataJSON()?.question ?? '');
  const a = ANSWERS.find((x) => x.match.test(q)) ?? ANSWERS[0];
  await new Promise((ok) => releases.push({ at: a.at, ok }));
  return route.fulfill({ json: { answer: a.text, poolFound: true } });
});
const page = await context.newPage();
await page.clock.install({ time: new Date('2026-09-26T12:00:00Z') });
// Served from the site's own origin, so the windows are same-site frames:
// a third-party frame is refused localStorage, and the switch above lives there.
await context.route(`${SITE}/__ad-stage`, (r) => r.fulfill({ contentType: 'text/html', body: STAGE }));
await page.goto(`${SITE}/__ad-stage`, { waitUntil: 'load' });
const frames = {};
for (const w of WINDOWS) {
  const f = page.frame({ name: w.id });
  if (!f) throw new Error(`window ${w.id} did not load`);
  await f.waitForLoadState('load');
  frames[w.id] = f;
}
await page.waitForTimeout(2500); // hydration runs on real time
await page.clock.runFor(4000);
await page.waitForTimeout(800);
for (const w of WINDOWS) {
  const text = await frames[w.id].evaluate(() => document.body.innerText.length);
  if (text < 200) throw new Error(`${w.path} rendered nothing: is the site running on ${SITE} with DATA_SOURCE=sim?`);
}

const centre = async (win, stop) => {
  if (stop.pt) return { x: stop.pt[0], y: stop.pt[1] };
  const box = await frames[win].locator(stop.sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  return { x: box.x + box.w * (stop.dx ?? 0.5), y: box.y + box.h * (stop.dy ?? 0.5) };
};
const resolved = new Map();
async function cursorAt(win, t) {
  const path = CURSOR[win];
  if (t < path[0].t - 0.35 || t > path[path.length - 1].t + 0.15) return null;
  let i = path.findIndex((s) => s.t >= t);
  if (i < 0) i = path.length - 1;
  const b = path[i], a = path[Math.max(0, i - 1)];
  for (const s of [a, b]) {
    const key = win + ':' + path.indexOf(s);
    if (!resolved.has(key)) resolved.set(key, await centre(win, s));
  }
  const pa = resolved.get(win + ':' + path.indexOf(a)), pb = resolved.get(win + ':' + path.indexOf(b));
  const x = a === b ? 1 : eio(clamp((t - a.t) / (b.t - a.t)));
  const click = CLICKS.find((c) => c.win === win && t >= c.t && t < c.t + 0.45 && c.kind === 'click');
  return {
    x: pa.x + (pb.x - pa.x) * x,
    y: pa.y + (pb.y - pa.y) * x,
    press: !!click && t < click.t + 0.12,
    ring: click ? (t - click.t) / 0.45 : -1,
  };
}

const TOTAL = ONLY ?? DURATION * FPS;
const silent = join(OUT, 'lockfi-portfolio-ai-ad-silent.mp4');
const ff = STILLS ? null : spawn(
  FFMPEG,
  ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);
const done = new Set();
let clock = 0;
let drawerScrollTop = null;
const started = Date.now();
for (let f = 0; f < TOTAL; f++) {
  const t = f / FPS;
  const ms = Math.round(t * 1000);
  if (ms > clock) {
    await page.clock.runFor(ms - clock);
    clock = ms;
  }
  await page.evaluate((tt) => window.render(tt), t);
  // real mouse, for the site's own hover and click handling
  for (const c of CLICKS) {
    if (done.has(c) || t < c.t) continue;
    done.add(c);
    const cur = await cursorAt(c.win, t);
    const pt = await page.evaluate(([w, x, y]) => window.mapPoint(w, x, y), [c.win, cur.x, cur.y]);
    if (c.kind === 'hover') await page.mouse.move(pt.x, pt.y, { steps: 4 });
    else if (c.kind === 'select') {
      // A native menu is not drawn in a screenshot; the choice is made directly.
      const f = frames[c.win];
      const value = await f.locator('#ask-about option', { hasText: /0\.3%/ }).first().getAttribute('value');
      await f.locator('#ask-about').selectOption(value);
    } else await page.mouse.click(pt.x, pt.y);
  }
  for (const r of releases) {
    if (!r.done && t >= r.at) {
      r.done = true;
      r.ok();
    }
  }
  for (const w of WINDOWS) {
    const s = { t: ms, cur: await cursorAt(w.id, t) };
    if (w.id === DRAWER_SCROLL.win && t >= DRAWER_SCROLL.t0) {
      if (drawerScrollTop === null) {
        drawerScrollTop = await frames[w.id].evaluate(([sel, want, offset]) => {
          const body = document.querySelector(sel);
          const target = body.querySelector(want) ?? body.lastElementChild;
          return Math.max(0, target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - offset);
        }, [DRAWER_SCROLL.sel, DRAWER_SCROLL.target, DRAWER_SCROLL.offset]);
      }
      const x = eio(clamp((t - DRAWER_SCROLL.t0) / (DRAWER_SCROLL.t1 - DRAWER_SCROLL.t0)));
      // After the ramp it follows the bottom, so a growing answer stays in view.
      s.scroll = { sel: DRAWER_SCROLL.sel, top: drawerScrollTop * x, follow: x >= 1 };
    }
    await frames[w.id].evaluate(STEP, s);
  }
  if (STILLS) {
    if (f % FPS === 0) await page.screenshot({ path: join(STILLS, `s${String(f / FPS).padStart(2, '0')}.jpg`), type: 'jpeg', quality: 80 });
  } else ff.stdin.write(await page.screenshot({ type: 'jpeg', quality: 94 }));
  if (f % 150 === 0) console.log(`  frame ${f}/${TOTAL}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
await browser.close();
if (STILLS) process.exit(0);
ff.stdin.end();
await new Promise((ok, no) => ff.on('close', (code) => (code === 0 ? ok() : no(new Error('ffmpeg ' + code)))));
console.log(`  ${silent.replace(ROOT + '/', '')}`);

// ── Score it ──────────────────────────────────────────────────────────────────
if (!ONLY) {
  const wav = join(OUT, 'lockfi-portfolio-ai-ad-music.wav');
  execFileSync('python3', [join(ROOT, 'scripts', 'build-lockfi-ad-audio.py'), wav, String(DURATION)], {
    stdio: 'inherit',
    env: { ...process.env, AD_PULSE: '7.8,30.4', AD_RISERS: '7.8,26.2', AD_BOOMS: '0.3,30.45' },
  });
  const final = join(OUT, 'lockfi-portfolio-ai-ad.mp4');
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', silent, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-shortest', '-movflags', '+faststart', final]);
  console.log(`  ${final.replace(ROOT + '/', '')}`);
}
