"""Direction sketches for /pools. Same live data, 1280x900 frames, static."""
import json

ROWS = [
  ("ETH","Ether","—",False,"-1.9%","$5.1K","—","$10.15M","4d",48,[3,4,3,5,4,6,5,7,6,8,7,9,8,9]),
  ("CASHCAT","Cash Cat","$116.47M",True,"—","$67.7K","—","$2.9M","3d",350,[1,1,2,1,2,3,2,4,5,6,8,9,9,9]),
  ("GUH","GUH","$1.91M",True,"—","$73.4K","—","$1.1M","2d",290,[1,1,1,1,2,2,3,4,5,7,8,9,9,9]),
  ("Index","The Index","$2.78M",True,"—","$5.9K","—","$0.6M","3d",220,[2,2,3,2,3,4,3,5,4,6,7,8,8,9]),
  ("VIRTUAL","Virtuals Protocol","$4.40M",True,"-3.1%","$3.1K","—","$0.4M","4d",140,[6,7,5,8,6,5,7,4,6,5,7,8,6,9]),
  ("SPCX","Space Exploration","$12.11M",True,"—","$1.2K","—","$0.2M","3d",30,[1,1,2,2,2,3,3,3,4,5,6,7,8,9]),
  ("AMD","AMD · Robinhood","$2.08M",True,"—","$1.0K","—","$0.1M","3d",200,[2,1,2,2,3,2,3,4,4,5,6,7,8,9]),
]
NAV = [("Pools","pools"),("Stakes","stakes"),("Positions","positions"),("Router","router"),("Portfolio","portfolio")]

def spark(vals, color, w=88, h=28, fill=None, stroke=1.5):
    n=len(vals); mx=max(vals); mn=min(vals); rng=(mx-mn) or 1
    pts=[f"{round(i*(w/(n-1)),1)},{round(h-2-((v-mn)/rng)*(h-4),1)}" for i,v in enumerate(vals)]
    poly=" ".join(pts)
    area=f'<polygon points="0,{h} {poly} {w},{h}" fill="{fill}" opacity="0.14"></polygon>' if fill else ""
    return (f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="display:block">{area}'
            f'<polyline points="{poly}" fill="none" stroke="{color}" stroke-width="{stroke}" stroke-linejoin="round" stroke-linecap="round"></polyline></svg>')

def bigchart(vals, color, w, h):
    n=len(vals); mx=max(vals); mn=min(vals); rng=(mx-mn) or 1
    pts=[(round(i*(w/(n-1)),1), round(h-6-((v-mn)/rng)*(h-30),1)) for i,v in enumerate(vals)]
    poly=" ".join(f"{x},{y}" for x,y in pts)
    grid="".join(f'<line x1="0" x2="{w}" y1="{round(h*k/4,1)}" y2="{round(h*k/4,1)}" stroke="rgba(20,32,27,.07)" stroke-width="1"></line>' for k in range(1,4))
    return (f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="display:block;width:100%;height:{h}px">{grid}'
            f'<polygon points="0,{h} {poly} {w},{h}" fill="{color}" opacity="0.10"></polygon>'
            f'<polyline points="{poly}" fill="none" stroke="{color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>'
            f'<circle cx="{pts[-1][0]}" cy="{pts[-1][1]}" r="4" fill="{color}"></circle></svg>')

def icon(name, color="currentColor", size=18):
    paths={
      "pools":'<path d="M3 15l5-6 4 4 4-6 5 6"></path>',
      "stakes":'<path d="M12 3l9 5-9 5-9-5 9-5z"></path><path d="M3 13l9 5 9-5"></path>',
      "positions":'<path d="M5 20V10M10 20V4M15 20v-8M20 20v-4"></path>',
      "router":'<path d="M4 7h9a4 4 0 010 8H4"></path><path d="M14 17l3 3 3-3"></path>',
      "portfolio":'<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2"></path>',
      "search":'<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>',
      "arrow":'<path d="M7 17L17 7M9 7h8v8"></path>',
    }
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" '
            f'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex:none">{paths[name]}</svg>')

def mark(sym, hue, size, light=False):
    bg=f"oklch(72% 0.13 {hue})" if not light else f"oklch(88% 0.09 {hue})"
    ink="oklch(20% 0.03 160)" if not light else f"oklch(32% 0.09 {hue})"
    return (f'<div style="width:{size}px;height:{size}px;border-radius:999px;background-color:{bg};'
            f'background-image:linear-gradient(155deg,rgba(255,255,255,.35),rgba(255,255,255,0) 55%);'
            f'box-shadow:inset 0 1px 0 rgba(255,255,255,.35),inset 0 -3px 6px rgba(0,0,0,.22),0 2px 6px rgba(0,0,0,.25);'
            f'display:flex;align-items:center;justify-content:center;flex:none;color:{ink};font-weight:700;'
            f'font-size:{max(10,int(size*0.3))}px;letter-spacing:.04em">{sym[:2].upper()}</div>')

HEAD = '''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@500;600;700&family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap">
  <style>
    body { margin: 0; }
    a { color: inherit; text-decoration: none; } a:hover { color: inherit; }
    * { box-sizing: border-box; }
  </style>
</helmet>
'''
TAIL = '''
</x-dc>
</body>
</html>
'''

# ------------------------------------------------------------ light palette --
L = dict(bg="oklch(96.5% 0.006 85)", panel="#FFFFFF", line="rgba(20,32,27,.10)", fg="oklch(22% 0.02 165)",
         fg2="oklch(45% 0.02 165)", fg3="oklch(60% 0.015 165)", ac="oklch(52% 0.13 158)", red="oklch(55% 0.17 25)",
         mono="'IBM Plex Mono', ui-monospace, Menlo, monospace", sans="'DM Sans', 'Segoe UI', system-ui, sans-serif",
         serif="'Instrument Serif', Georgia, serif",
         shadow="0 1px 2px rgba(20,32,27,.05),0 16px 40px -28px rgba(20,32,27,.28)")

def light_topnav(active="Pools"):
    p=L
    items="".join(f'<a href="#" style="padding:8px 14px;border-radius:999px;font-size:14px;font-weight:{600 if n==active else 500};color:{p["fg"] if n==active else p["fg2"]};background:{"rgba(20,32,27,.07)" if n==active else "transparent"}">{n}</a>' for n,_ in NAV)
    return f'''
    <header style="display:flex;align-items:center;gap:18px;height:72px;padding:0 40px;border-bottom:1px solid {p["line"]};background:{p["panel"]}">
      <div style="display:flex;align-items:center;gap:10px;margin-right:12px"><svg width="22" height="22" viewBox="0 0 24 24" fill="{p["fg"]}" style="display:block"><path d="M4 20V6l6 9 4-6 6 11z"></path></svg><span style="font-family:{p["serif"]};font-size:24px">Balast</span></div>
      <nav style="display:flex;gap:2px">{items}</nav>
      <div style="flex:1"></div>
      <div style="display:flex;align-items:center;gap:10px;width:260px;height:40px;padding:0 14px;border:1px solid {p["line"]};border-radius:999px;background:{p["bg"]};color:{p["fg3"]};font-size:13.5px">{icon("search",p["fg3"],16)}Search tokens</div>
      <div style="display:flex;align-items:center;gap:8px;height:40px;padding:0 14px;border:1px solid {p["line"]};border-radius:999px;color:{p["fg2"]};font-size:12.5px;white-space:nowrap"><span style="width:7px;height:7px;border-radius:99px;background:{p["fg3"]}"></span>Indexer 67d 20h behind</div>
      <div style="display:flex;align-items:center;height:40px;padding:0 18px;border-radius:999px;background:{p["fg"]};color:#FFFFFF;font-weight:600;font-size:13.5px;white-space:nowrap">Connect wallet</div>
    </header>'''

def light_sidebar():
    p=L
    nav="".join(f'<a href="#" style="display:flex;align-items:center;gap:10px;height:38px;padding:0 12px;border-radius:8px;color:{p["fg"] if i==0 else p["fg2"]};background:{"rgba(20,32,27,.06)" if i==0 else "transparent"};font-weight:{600 if i==0 else 500};font-size:14px">{icon(k, p["fg"] if i==0 else p["fg2"], 17)}<span>{n}</span></a>' for i,(n,k) in enumerate(NAV))
    return f'''
  <aside style="width:220px;flex:none;padding:26px 16px;display:flex;flex-direction:column;gap:4px;border-right:1px solid {p["line"]}">
    <div style="display:flex;align-items:center;gap:10px;padding:0 12px 28px">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="{p["fg"]}" style="display:block"><path d="M4 20V6l6 9 4-6 6 11z"></path></svg>
      <span style="font-family:{p["serif"]};font-size:24px;letter-spacing:.01em">Balast</span>
    </div>
    {nav}
  </aside>'''

def chg_pill(chg):
    p=L; neg=chg.startswith("-")
    if chg=="—": return f'<span style="color:{p["fg3"]};font-family:{p["mono"]}">—</span>'
    return f'<span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;background:{"oklch(95% 0.03 25)" if neg else "oklch(94% 0.05 158)"};color:{p["red"] if neg else p["ac"]};font-family:{p["mono"]};font-weight:600;font-size:12px">{chg}</span>'

# --------------------------------------------------------------- B · Ledger --
def ledger():
    p=L
    rows=""
    for i,(sym,name,mc,fdv,chg,fees,yld,vol,age,hue,sp) in enumerate(ROWS):
        neg=chg.startswith("-")
        mc_html=(f'<span style="font-family:{p["mono"]};font-weight:600;font-size:14px;color:{p["fg"]}">{mc}</span>'+(f'<span style="margin-left:6px;font-size:10px;font-weight:600;letter-spacing:.08em;color:{p["fg3"]}">FDV</span>' if fdv else "")) if mc!="—" else f'<span style="color:{p["fg3"]};font-family:{p["mono"]}">—</span>'
        rows += f'''
      <div style="display:grid;grid-template-columns:1fr 160px 110px 120px 110px 120px;align-items:center;gap:16px;height:64px;padding:0 24px;border-top:1px solid {p["line"]}">
        <div style="display:flex;align-items:center;gap:14px;min-width:0">
          <span style="font-family:{p["mono"]};font-size:12px;color:{p["fg3"]};width:18px">{i+1}</span>
          {mark(sym,hue,36,light=True)}
          <div style="display:flex;flex-direction:column;gap:1px;min-width:0">
            <span style="font-weight:700;font-size:15px;color:{p["fg"]}">{sym}</span>
            <span style="font-size:12.5px;color:{p["fg3"]};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{name}</span>
          </div>
        </div>
        <div style="text-align:right">{mc_html}</div>
        <div style="text-align:right">{chg_pill(chg)}</div>
        <div style="text-align:right;font-family:{p["mono"]};font-weight:600;font-size:14px;color:{p["fg"]}">{fees}</div>
        <div style="text-align:right;font-family:{p["mono"]};font-size:13px;color:{p["fg3"]}">{yld}</div>
        <div style="display:flex;justify-content:flex-end">{spark(sp, p["red"] if neg else p["ac"], 100, 30, None, 1.6)}</div>
      </div>'''
    kpi=lambda k,v,sub: (f'<div style="display:flex;flex-direction:column;gap:8px;padding:22px 24px;background:{p["panel"]};border:1px solid {p["line"]};border-radius:16px;box-shadow:{p["shadow"]}">'
                         f'<span style="font-size:12px;font-weight:600;color:{p["fg3"]}">{k}</span><span style="font-family:{p["serif"]};font-size:38px;line-height:1;letter-spacing:-.01em;color:{p["fg"]}">{v}</span><span style="font-size:12.5px;color:{p["fg2"]}">{sub}</span></div>')
    return HEAD + f'''
<div style="width:1280px;min-height:900px;background:{p["bg"]};color:{p["fg"]};font-family:{p["sans"]};display:flex">
  {light_sidebar()}
  <main style="flex:1;min-width:0;padding:26px 36px 36px;display:flex;flex-direction:column;gap:26px">
    <header style="display:flex;align-items:center;gap:14px">
      <div style="display:flex;align-items:center;gap:10px;flex:1;height:44px;padding:0 16px;border:1px solid {p["line"]};border-radius:12px;background:{p["panel"]};color:{p["fg3"]};font-size:14px">{icon("search",p["fg3"],17)}Search tokens</div>
      <div style="display:flex;align-items:center;gap:8px;height:44px;padding:0 14px;border:1px solid {p["line"]};border-radius:12px;background:{p["panel"]};color:{p["fg2"]};font-size:12.5px;font-weight:500"><span style="width:7px;height:7px;border-radius:99px;background:{p["fg3"]}"></span>Indexer 67d 20h behind</div>
      <div style="display:flex;align-items:center;height:44px;padding:0 20px;border-radius:12px;background:{p["fg"]};color:#FFFFFF;font-weight:600;font-size:14px">Connect wallet</div>
    </header>
    <div style="display:flex;flex-direction:column;gap:6px">
      <h1 style="margin:0;font-family:{p["serif"]};font-weight:400;font-size:46px;line-height:1.05;letter-spacing:-.01em">Every pool on Robinhood Chain, priced from its own fees.</h1>
      <p style="margin:0;font-size:15px;color:{p["fg2"]};max-width:62ch">Deposit one token, collect a share of swap fees in WETH. Nothing here is projected — the yield you see is what LPs earned, trailing seven days.</p>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px">
      {kpi("Total value locked","$3.78M","across 7 listed markets")}{kpi("Fees paid to LPs","$387,569","since the chain launched")}{kpi("ETH price","$2,521","from the ETH/USDG pool, one path")}
    </div>
    <section style="background:{p["panel"]};border:1px solid {p["line"]};border-radius:18px;box-shadow:{p["shadow"]};overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 24px 14px">
        <div style="display:flex;align-items:baseline;gap:12px"><span style="font-family:{p["serif"]};font-size:26px">Markets</span><span style="font-size:13px;color:{p["fg3"]}">Tokens above $1M · sorted by volume</span></div>
        <div style="display:flex;padding:3px;border:1px solid {p["line"]};border-radius:10px;background:{p["bg"]}"><span style="padding:6px 14px;border-radius:7px;background:{p["panel"]};font-size:13px;font-weight:600;box-shadow:0 1px 2px rgba(20,32,27,.08)">All</span><span style="padding:6px 14px;font-size:13px;color:{p["fg3"]}">ETH</span><span style="padding:6px 14px;font-size:13px;color:{p["fg3"]}">USDG</span></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 160px 110px 120px 110px 120px;gap:16px;padding:0 24px 10px;font-size:11.5px;font-weight:600;color:{p["fg3"]}">
        <span>Token</span><span style="text-align:right">Market cap</span><span style="text-align:right">24h</span><span style="text-align:right">Fees 24h</span><span style="text-align:right">Yield · 7d</span><span style="text-align:right">Last 24h</span>
      </div>
      {rows}
    </section>
  </main>
</div>''' + TAIL

# ---------------------------------------------------------------- B1 · Atlas --
def atlas():
    """Top navigation, no sidebar; markets as a grid of cards."""
    p=L
    cards=""
    for i,(sym,name,mc,fdv,chg,fees,yld,vol,age,hue,sp) in enumerate(ROWS):
        neg=chg.startswith("-")
        mc_line = f'{mc} <span style="font-size:10px;letter-spacing:.08em;color:{p["fg3"]}">FDV</span>' if mc!="—" else f'<span style="color:{p["fg3"]}">no supply read</span>'
        cards += f'''
      <div style="display:flex;flex-direction:column;gap:14px;padding:20px 20px 16px;background:{p["panel"]};border:1px solid {p["line"]};border-radius:18px;box-shadow:{p["shadow"]}">
        <div style="display:flex;align-items:center;gap:12px">
          {mark(sym,hue,40,light=True)}
          <div style="display:flex;flex-direction:column;min-width:0;gap:1px"><span style="font-weight:700;font-size:16px">{sym}</span><span style="font-size:12.5px;color:{p["fg3"]};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{name}</span></div>
          <div style="margin-left:auto">{chg_pill(chg)}</div>
        </div>
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px">
          <div style="display:flex;flex-direction:column;gap:2px"><span style="font-size:11.5px;font-weight:600;color:{p["fg3"]}">Fees · 24h</span><span style="font-family:{p["serif"]};font-size:34px;line-height:1;letter-spacing:-.01em">{fees}</span></div>
          <div style="display:flex;flex-direction:column;gap:2px;text-align:right"><span style="font-size:11.5px;font-weight:600;color:{p["fg3"]}">Market cap</span><span style="font-family:{p["mono"]};font-size:13px;font-weight:600">{mc_line}</span></div>
        </div>
        <div style="margin:0 -20px -16px;padding:0 20px 14px;border-top:1px solid {p["line"]};padding-top:12px">{spark(sp, p["red"] if neg else p["ac"], 246, 34, p["red"] if neg else p["ac"], 1.8)}</div>
      </div>'''
    stake_card = f'''
      <div style="display:flex;flex-direction:column;justify-content:space-between;gap:14px;padding:22px;background:{p["fg"]};color:#FFFFFF;border-radius:18px;box-shadow:{p["shadow"]}">
        <div style="display:flex;flex-direction:column;gap:8px"><span style="font-family:{p["serif"]};font-size:26px;line-height:1.1">Own a share of the depth.</span><span style="font-size:13px;color:rgba(255,255,255,.7);line-height:1.5">Deposit one token, collect swap fees in WETH. No lockups, no emissions.</span></div>
        <div style="display:flex;align-items:center;justify-content:space-between;height:42px;padding:0 16px;border-radius:999px;background:#FFFFFF;color:{p["fg"]};font-weight:700;font-size:13.5px">Start earning {icon("arrow",p["fg"],16)}</div>
      </div>'''
    stat=lambda k,v: f'<div style="display:flex;flex-direction:column;gap:4px"><span style="font-size:12px;font-weight:600;color:{p["fg3"]}">{k}</span><span style="font-family:{p["mono"]};font-size:18px;font-weight:600;letter-spacing:-.01em">{v}</span></div>'
    return HEAD + f'''
<div style="width:1280px;min-height:900px;background:{p["bg"]};color:{p["fg"]};font-family:{p["sans"]};display:flex;flex-direction:column">
  {light_topnav()}
  <main style="padding:34px 40px 40px;display:flex;flex-direction:column;gap:28px">
    <section style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:40px;align-items:end">
      <div style="display:flex;flex-direction:column;gap:10px">
        <span style="font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:{p["fg3"]}">Paid to liquidity providers · Robinhood Chain</span>
        <span style="font-family:{p["serif"]};font-size:72px;line-height:.95;letter-spacing:-.02em">$387,569</span>
        <span style="font-size:15px;color:{p["fg2"]}">in swap fees, since the chain launched. Every figure below is trailing, never projected.</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;padding:18px 22px;background:{p["panel"]};border:1px solid {p["line"]};border-radius:16px;box-shadow:{p["shadow"]}">
        {stat("Value locked","$3.78M")}{stat("Fees · 24h","$155K")}{stat("ETH","$2,521")}
      </div>
    </section>
    <section style="display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:baseline;gap:12px"><span style="font-family:{p["serif"]};font-size:28px">Markets</span><span style="font-size:13px;color:{p["fg3"]}">7 tokens above $1M · by volume</span></div>
        <div style="display:flex;padding:3px;border:1px solid {p["line"]};border-radius:999px;background:{p["panel"]}"><span style="padding:6px 16px;border-radius:999px;background:{p["fg"]};color:#fff;font-size:13px;font-weight:600">Trending</span><span style="padding:6px 16px;font-size:13px;color:{p["fg3"]}">Established · 7d+</span></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px">
        {cards}{stake_card}
      </div>
    </section>
  </main>
</div>''' + TAIL

# ------------------------------------------------------------- B2 · Explorer --
def explorer():
    """Sidebar; a featured-market chart pane beside a compact ranked list."""
    p=L
    lst=""
    for i,(sym,name,mc,fdv,chg,fees,yld,vol,age,hue,sp) in enumerate(ROWS):
        neg=chg.startswith("-"); on=i==0
        lst += f'''
        <div style="display:flex;align-items:center;gap:12px;height:58px;padding:0 16px;border-top:1px solid {p["line"]};{'background:'+p["bg"]+';' if on else ''}">
          <span style="font-family:{p["mono"]};font-size:11px;color:{p["fg3"]};width:14px">{i+1}</span>
          {mark(sym,hue,32,light=True)}
          <div style="display:flex;flex-direction:column;min-width:0;flex:1"><span style="font-weight:700;font-size:14px">{sym}</span><span style="font-size:11.5px;color:{p["fg3"]};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{name}</span></div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px"><span style="font-family:{p["mono"]};font-weight:600;font-size:13.5px">{fees}</span><span style="font-size:10.5px;color:{p["fg3"]}">fees 24h</span></div>
          {spark(sp, p["red"] if neg else p["ac"], 64, 26, None, 1.5)}
        </div>'''
    eth=[2580,2572,2590,2601,2588,2570,2555,2566,2549,2538,2530,2544,2528,2521]
    stat=lambda k,v,c=None: f'<div style="display:flex;flex-direction:column;gap:4px;padding:14px 16px;border:1px solid {p["line"]};border-radius:12px;background:{p["bg"]}"><span style="font-size:11.5px;font-weight:600;color:{p["fg3"]}">{k}</span><span style="font-family:{p["mono"]};font-size:17px;font-weight:600;color:{c or p["fg"]}">{v}</span></div>'
    return HEAD + f'''
<div style="width:1280px;min-height:900px;background:{p["bg"]};color:{p["fg"]};font-family:{p["sans"]};display:flex">
  {light_sidebar()}
  <main style="flex:1;min-width:0;padding:26px 32px 32px;display:flex;flex-direction:column;gap:20px">
    <header style="display:flex;align-items:center;gap:14px">
      <div style="display:flex;align-items:center;gap:10px;flex:1;height:44px;padding:0 16px;border:1px solid {p["line"]};border-radius:12px;background:{p["panel"]};color:{p["fg3"]};font-size:14px">{icon("search",p["fg3"],17)}Search tokens</div>
      <div style="display:flex;align-items:center;gap:8px;height:44px;padding:0 14px;border:1px solid {p["line"]};border-radius:12px;background:{p["panel"]};color:{p["fg2"]};font-size:12.5px"><span style="width:7px;height:7px;border-radius:99px;background:{p["fg3"]}"></span>Indexer 67d 20h behind</div>
      <div style="display:flex;align-items:center;height:44px;padding:0 20px;border-radius:12px;background:{p["fg"]};color:#FFFFFF;font-weight:600;font-size:14px">Connect wallet</div>
    </header>
    <div style="display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:18px;align-items:start">
      <section style="display:flex;flex-direction:column;gap:18px;padding:24px;background:{p["panel"]};border:1px solid {p["line"]};border-radius:18px;box-shadow:{p["shadow"]}">
        <div style="display:flex;align-items:center;gap:14px">
          {mark("ETH",48,48,light=True)}
          <div style="display:flex;flex-direction:column;gap:2px"><span style="font-size:12px;font-weight:600;color:{p["fg3"]}">Most traded · ETH / USDG · 0.05%</span><div style="display:flex;align-items:baseline;gap:12px"><span style="font-family:{p["serif"]};font-size:44px;line-height:1;letter-spacing:-.01em">$2,521.08</span>{chg_pill("-1.9%")}</div></div>
          <div style="margin-left:auto;display:flex;padding:3px;border:1px solid {p["line"]};border-radius:999px;background:{p["bg"]}"><span style="padding:5px 12px;border-radius:999px;background:{p["panel"]};font-size:12px;font-weight:600;box-shadow:0 1px 2px rgba(20,32,27,.08)">24h</span><span style="padding:5px 12px;font-size:12px;color:{p["fg3"]}">7d</span><span style="padding:5px 12px;font-size:12px;color:{p["fg3"]}">30d</span></div>
        </div>
        {bigchart(eth, p["red"], 700, 240)}
        <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px">
          {stat("Depth","$1.42M")}{stat("Fees · 24h","$5.1K")}{stat("Volume · 24h","$10.15M")}{stat("Fee yield · 7d","— · 4d old",p["fg3"])}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-radius:12px;background:{p["bg"]};border:1px solid {p["line"]}">
          <span style="font-size:13px;color:{p["fg2"]}">Stake into this pool and collect 90% of its swap fees, streamed over 7 days.</span>
          <span style="display:flex;align-items:center;height:36px;padding:0 16px;border-radius:999px;background:{p["ac"]};color:#fff;font-weight:700;font-size:13px">Stake ETH</span>
        </div>
      </section>
      <section style="background:{p["panel"]};border:1px solid {p["line"]};border-radius:18px;box-shadow:{p["shadow"]};overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px">
          <span style="font-family:{p["serif"]};font-size:22px">Markets</span>
          <div style="display:flex;padding:3px;border:1px solid {p["line"]};border-radius:999px;background:{p["bg"]}"><span style="padding:5px 12px;border-radius:999px;background:{p["panel"]};font-size:12px;font-weight:600;box-shadow:0 1px 2px rgba(20,32,27,.08)">Volume</span><span style="padding:5px 12px;font-size:12px;color:{p["fg3"]}">Fee yield</span></div>
        </div>
        {lst}
      </section>
    </div>
  </main>
</div>''' + TAIL

# -------------------------------------------------------------- B3 · Journal --
def journal():
    """Top navigation; a typographic hero and a leaderboard with large numerals."""
    p=L
    rows=""
    for i,(sym,name,mc,fdv,chg,fees,yld,vol,age,hue,sp) in enumerate(ROWS[:6]):
        neg=chg.startswith("-")
        rows += f'''
        <div style="display:grid;grid-template-columns:64px 1fr 150px 150px 260px;align-items:center;gap:20px;height:76px;border-top:1px solid {p["line"]}">
          <span style="font-family:{p["serif"]};font-size:36px;line-height:1;color:{p["fg3"]}">{i+1:02d}</span>
          <div style="display:flex;align-items:center;gap:14px;min-width:0">{mark(sym,hue,40,light=True)}<div style="display:flex;flex-direction:column;gap:1px;min-width:0"><span style="font-weight:700;font-size:17px">{sym}</span><span style="font-size:13px;color:{p["fg3"]}">{name} · {("FDV "+mc) if mc!="—" else "no supply read"}</span></div></div>
          <div style="display:flex;flex-direction:column;gap:2px;text-align:right"><span style="font-family:{p["mono"]};font-weight:600;font-size:18px">{fees}</span><span style="font-size:11px;color:{p["fg3"]}">fees · 24h</span></div>
          <div style="text-align:right">{chg_pill(chg)}</div>
          <div style="display:flex;justify-content:flex-end">{spark(sp, p["red"] if neg else p["ac"], 240, 36, p["red"] if neg else p["ac"], 1.8)}</div>
        </div>'''
    return HEAD + f'''
<div style="width:1280px;min-height:900px;background:{p["bg"]};color:{p["fg"]};font-family:{p["sans"]};display:flex;flex-direction:column">
  {light_topnav()}
  <main style="width:1060px;margin:0 auto;padding:44px 0 40px;display:flex;flex-direction:column;gap:36px">
    <section style="display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:40px;align-items:end;padding-bottom:28px;border-bottom:1px solid {p["fg"]}">
      <div style="display:flex;flex-direction:column;gap:14px">
        <span style="font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:{p["fg3"]}">The Balast ledger · Sunday 14 September</span>
        <h1 style="margin:0;font-family:{p["serif"]};font-weight:400;font-size:58px;line-height:1.02;letter-spacing:-.02em">Seven markets above a million. <em style="font-style:italic;color:{p["ac"]}">$155K</em> in fees yesterday.</h1>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;font-size:13.5px;color:{p["fg2"]};line-height:1.55">
        <div style="display:flex;justify-content:space-between;border-bottom:1px solid {p["line"]};padding-bottom:8px"><span>Value locked</span><span style="font-family:{p["mono"]};font-weight:600;color:{p["fg"]}">$3.78M</span></div>
        <div style="display:flex;justify-content:space-between;border-bottom:1px solid {p["line"]};padding-bottom:8px"><span>Paid to LPs, all time</span><span style="font-family:{p["mono"]};font-weight:600;color:{p["fg"]}">$387,569</span></div>
        <div style="display:flex;justify-content:space-between"><span>ETH</span><span style="font-family:{p["mono"]};font-weight:600;color:{p["fg"]}">$2,521</span></div>
      </div>
    </section>
    <section style="display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;padding-bottom:10px">
        <span style="font-family:{p["serif"]};font-size:30px">Leaderboard</span>
        <span style="font-size:13px;color:{p["fg3"]}">by volume · fee yield appears at seven days of history</span>
      </div>
      {rows}
    </section>
  </main>
</div>''' + TAIL

# ---------------------------------------------------------------- A · Vault --
def vault():
    bg="oklch(12% 0.008 170)"; panel="oklch(15.5% 0.008 170)"; panel2="oklch(18% 0.009 170)"
    line="rgba(255,255,255,.07)"; fg="oklch(94% 0.01 160)"; fg2="oklch(68% 0.02 160)"; fg3="oklch(50% 0.015 160)"
    ac="#3DD68C"; red="#E5484D"; mono="'JetBrains Mono', ui-monospace, Menlo, monospace"
    sans="Manrope, 'Segoe UI', system-ui, sans-serif"; serif="'Instrument Serif', Georgia, serif"
    nav="".join(f'<a href="#" style="display:flex;align-items:center;gap:12px;height:40px;padding:0 12px;border-radius:10px;color:{fg if i==0 else fg3};background:{"rgba(61,214,140,.08)" if i==0 else "transparent"};font-weight:600;font-size:13px">{icon(k, ac if i==0 else fg3, 17)}<span>{n}</span></a>' for i,(n,k) in enumerate(NAV))
    rows=""
    for i,(sym,name,mc,fdv,chg,fees,yld,vol,age,hue,sp) in enumerate(ROWS):
        neg=chg.startswith("-")
        chg_html=(f'<span style="color:{red if neg else ac};font-family:{mono};font-weight:600;font-size:13px">{"▼ " if neg else ""}{chg}</span>' if chg!="—" else f'<span style="color:{fg3};font-family:{mono}">—</span>')
        mc_html=(f'<span style="font-family:{mono};font-weight:600;font-size:13.5px;color:{fg}">{mc}</span>'+(f'<span style="margin-left:6px;font-size:9px;font-weight:700;letter-spacing:.12em;color:{fg3}">FDV</span>' if fdv else "")) if mc!="—" else f'<span style="color:{fg3};font-family:{mono}">—</span>'
        rows += f'''
      <div style="display:grid;grid-template-columns:28px 1fr 150px 110px 120px 110px 110px;align-items:center;gap:16px;height:66px;padding:0 24px;border-top:1px solid {line};{'background:linear-gradient(90deg,rgba(61,214,140,.06),transparent 45%);' if i==0 else ''}">
        <span style="font-family:{mono};font-size:11px;color:{fg3}">{i+1}</span>
        <div style="display:flex;align-items:center;gap:14px;min-width:0">{mark(sym,hue,40)}<div style="display:flex;flex-direction:column;gap:2px;min-width:0"><span style="font-family:{sans};font-weight:800;font-size:15px;color:{fg};letter-spacing:-.01em">{sym}</span><span style="font-family:{sans};font-size:12px;color:{fg3};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{name}</span></div></div>
        <div style="text-align:right">{mc_html}</div><div style="text-align:right">{chg_html}</div>
        <div style="text-align:right;font-family:{mono};font-weight:600;font-size:13.5px;color:{fg}">{fees}</div>
        <div style="text-align:right;font-family:{mono};font-size:13px;color:{fg3}">{yld}</div>
        <div style="display:flex;justify-content:flex-end">{spark(sp, red if neg else ac, 96, 30, red if neg else ac)}</div>
      </div>'''
    stat=lambda k,v,first=False: (f'<div style="display:flex;flex-direction:column;gap:3px;padding:0 22px;border-left:{"0" if first else "1px solid "+line}"><span style="font-family:{sans};font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:{fg3}">{k}</span><span style="font-family:{mono};font-size:14px;font-weight:600;color:{fg}">{v}</span></div>')
    hm=lambda k,v,c=fg: f'<div style="display:flex;flex-direction:column;gap:6px"><span style="font-family:{sans};font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:{fg3}">{k}</span><span style="font-family:{mono};font-size:22px;font-weight:600;letter-spacing:-.02em;color:{c}">{v}</span></div>'
    mini=lambda lab,sym,hue,b,rest: f'<div style="padding:18px 20px;border:1px solid {line};border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.03),transparent 40%),{panel};box-shadow:0 30px 60px -40px rgba(0,0,0,.9);display:flex;flex-direction:column;gap:14px"><span style="font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:{fg3}">{lab}</span><div style="display:flex;align-items:center;gap:12px">{mark(sym,hue,40)}<div style="display:flex;flex-direction:column"><span style="font-weight:800;font-size:19px;letter-spacing:-.01em">{sym}</span><span style="font-family:{mono};font-size:12px;color:{fg2}"><b style="color:{ac};font-weight:600">{b}</b> · {rest}</span></div></div></div>'
    return HEAD + f'''
<div style="width:1280px;min-height:900px;background:radial-gradient(900px 480px at 22% -10%,rgba(61,214,140,.09),transparent 60%),{bg};color:{fg};font-family:{sans};display:flex">
  <aside style="width:232px;flex:none;border-right:1px solid {line};padding:22px 14px;display:flex;flex-direction:column;gap:4px;background:{panel}">
    <div style="display:flex;align-items:center;gap:10px;padding:4px 12px 26px"><svg width="24" height="24" viewBox="0 0 24 24" fill="{ac}" style="display:block;filter:drop-shadow(0 0 10px rgba(61,214,140,.5))"><path d="M4 20V6l6 9 4-6 6 11z"></path></svg><span style="font-family:{serif};font-size:22px;letter-spacing:.02em">Balast</span></div>
    {nav}
  </aside>
  <main style="flex:1;min-width:0;display:flex;flex-direction:column">
    <header style="display:flex;align-items:center;gap:14px;height:72px;padding:0 28px;border-bottom:1px solid {line}">
      <div style="display:flex;align-items:center;gap:10px;flex:1;height:42px;padding:0 16px;border:1px solid {line};border-radius:999px;background:{panel};color:{fg3};font-size:13px">{icon("search",fg3,16)}Search tokens</div>
      <div style="display:flex;align-items:center;height:42px;border:1px solid {line};border-radius:999px;background:{panel};padding:0 4px">{stat("Total fees","$387,569",True)}{stat("TVL","$3.78M")}{stat("ETH","$2,521")}</div>
      <div style="display:flex;align-items:center;gap:8px;height:42px;padding:0 14px;border:1px solid {line};border-radius:999px;color:{fg3};font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase"><span style="width:6px;height:6px;border-radius:99px;background:{fg3}"></span>Indexer · 67d 20h behind</div>
      <div style="display:flex;align-items:center;height:42px;padding:0 20px;border-radius:999px;background:linear-gradient(180deg,#6FE8AC,{ac});color:#04140C;font-weight:800;font-size:12.5px;letter-spacing:.04em;box-shadow:0 10px 26px -12px rgba(61,214,140,.6)">Connect wallet</div>
    </header>
    <section style="padding:34px 28px 26px;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:20px;align-items:end">
      <div style="display:flex;flex-direction:column;gap:22px">
        <div style="display:flex;flex-direction:column;gap:6px"><span style="font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:{fg3}">Robinhood Chain · liquidity layer</span><h1 style="margin:0;font-family:{serif};font-weight:400;font-size:44px;line-height:1.05;letter-spacing:-.01em;color:{fg}">Depth that pays in <em style="font-style:italic;color:{ac}">fees</em>, not promises.</h1></div>
        <div style="display:flex;gap:40px">{hm("Total value locked","$3.78M")}{hm("Fees paid · 24h","$155K")}{hm("Fee yield · trailing 7d","—",fg3)}</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px">{mini("Most traded · 24h","ETH",48,"25,435 trades","$10.15M vol")}{mini("Top fees · 24h","GUH",290,"$73.4K fees","$1.1M vol")}</div>
    </section>
    <section style="margin:0 28px 28px;border:1px solid {line};border-radius:20px;background:linear-gradient(180deg,rgba(255,255,255,.025),transparent 30%),{panel};box-shadow:0 40px 80px -50px rgba(0,0,0,.95);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 24px 16px"><div style="display:flex;align-items:baseline;gap:14px"><span style="font-family:{serif};font-size:24px">Markets</span><span style="font-size:12px;color:{fg3}">7 tokens above $1M · one row per token</span></div><div style="display:flex;padding:3px;border:1px solid {line};border-radius:10px;background:{panel2}"><span style="padding:6px 14px;border-radius:7px;background:{panel};font-size:12px;font-weight:700">All</span><span style="padding:6px 14px;font-size:12px;color:{fg3}">ETH</span><span style="padding:6px 14px;font-size:12px;color:{fg3}">USDG</span></div></div>
      <div style="display:grid;grid-template-columns:28px 1fr 150px 110px 120px 110px 110px;gap:16px;padding:0 24px 10px;font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:{fg3}"><span></span><span>Token</span><span style="text-align:right">Market cap</span><span style="text-align:right">24h</span><span style="text-align:right">Fees 24h</span><span style="text-align:right">Yield 7d</span><span style="text-align:right">Last 24h</span></div>
      {rows}
    </section>
  </main>
</div>''' + TAIL

# --------------------------------------------------------- C · Terminal Pro --
def terminal():
    bg="#050807"; panel="#080D0B"; raise_="#0E1714"; line="rgba(255,255,255,.07)"; bd="rgba(61,214,140,.16)"
    fg="#E6F2EC"; fg2="#8FA79B"; fg3="#5E7268"; fg4="#3D4D45"; ac="#3DD68C"; red="#E5484D"; mono="'JetBrains Mono', ui-monospace, Menlo, monospace"
    nav="".join(f'<a href="#" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;color:{ac if i==0 else fg3};background:{"rgba(61,214,140,.10)" if i==0 else "transparent"}" title="{n}">{icon(k, ac if i==0 else fg3, 18)}</a>' for i,(n,k) in enumerate(NAV))
    def board(title, sub, sort_rows, yield_col=False):
        rows=""
        for i,(sym,name,mc,fdv,chg,fees,yld,vol,age,hue,sp) in enumerate(sort_rows):
            neg=chg.startswith("-")
            chg_html=(f'<span style="color:{red if neg else ac};font-weight:600">{"▼" if neg else "▲"} {chg}</span>' if chg!="—" else f'<span style="color:{fg3}">—</span>')
            mc_html=(f'{mc}<span style="margin-left:4px;font-size:8.5px;font-weight:700;letter-spacing:.1em;color:{fg4}">FDV</span>' if fdv else mc) if mc!="—" else f'<span style="color:{fg3}">—</span>'
            rows += f'''
        <div style="display:grid;grid-template-columns:18px 1fr 96px 72px 76px 62px 64px;align-items:center;gap:10px;height:46px;padding:0 14px;border-top:1px solid {line};font-size:12.5px;{'background:linear-gradient(90deg,rgba(61,214,140,.08),transparent 40%);box-shadow:inset 2px 0 0 '+ac+';' if i==0 else ''}">
          <span style="font-size:10px;color:{fg4}">{i+1}</span>
          <div style="display:flex;align-items:center;gap:10px;min-width:0">{mark(sym,hue,26)}<div style="display:flex;flex-direction:column;min-width:0;line-height:1.2"><span style="font-weight:700;font-size:13px">{sym}</span><span style="font-size:10.5px;color:{fg3};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{name}</span></div></div>
          <div style="text-align:right;font-weight:600">{mc_html}</div><div style="text-align:right;font-size:12px">{chg_html}</div>
          <div style="text-align:right;font-weight:600">{fees if not yield_col else yld}</div>
          <div style="text-align:right;color:{fg3};font-size:11.5px">{age}</div>
          <div style="display:flex;justify-content:flex-end">{spark(sp, red if neg else ac, 60, 24, None, 1.3)}</div>
        </div>'''
        return f'''
      <section style="border:1px solid {line};border-radius:12px;background:{panel};overflow:hidden;min-width:0">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid {line}"><div style="display:flex;align-items:center;gap:8px;font-size:10.5px;font-weight:700;letter-spacing:.2em;text-transform:uppercase"><span style="width:5px;height:5px;border-radius:99px;background:{ac};box-shadow:0 0 8px {ac}"></span>{title}<span style="color:{fg4};font-weight:600;margin-left:6px">{sub}</span></div><div style="display:flex;border:1px solid {line};border-radius:6px;overflow:hidden;font-size:10.5px;font-weight:600"><span style="padding:4px 10px;background:{raise_};color:{fg}">All</span><span style="padding:4px 10px;color:{fg3}">ETH</span><span style="padding:4px 10px;color:{fg3}">USDG</span></div></div>
        <div style="display:grid;grid-template-columns:18px 1fr 96px 72px 76px 62px 64px;gap:10px;padding:10px 14px 8px;font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:{fg4}"><span></span><span>Token</span><span style="text-align:right">MC</span><span style="text-align:right">24h</span><span style="text-align:right">{"Yield 7d" if yield_col else "Fees 24h"}</span><span style="text-align:right">Age</span><span style="text-align:right">24h</span></div>
        {rows}
      </section>'''
    stat=lambda k,v,last=False: f'<div style="display:flex;flex-direction:column;gap:2px;padding:0 16px;border-right:{"0" if last else "1px solid "+bd}"><span style="font-size:9px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:{fg3}">{k}</span><span style="font-size:13px;font-weight:700">{v}</span></div>'
    tick=" ".join(f'<span style="color:{fg2}">{s}</span> <span style="color:{red if c.startswith("-") else ac}">{c}</span><span style="color:{fg4};margin:0 14px">·</span>' for s,c in [("ETH","-1.9%"),("VIRTUAL","-3.1%"),("CASHCAT","+0.4%"),("GUH","+12.8%"),("SPCX","+0.9%"),("AMD","+0.2%"),("USDe","+0.0%"),("Index","+2.1%")])
    by_fees=sorted(ROWS, key=lambda r: -float(r[5].replace("$","").replace("K","")))
    kpis="".join(f'<div style="padding:14px 16px;border:1px solid {line};border-radius:12px;background:{panel};display:flex;flex-direction:column;gap:6px"><span style="font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:{fg3}">{k}</span><span style="font-size:22px;font-weight:700;letter-spacing:-.01em;color:{c}">{v}</span><span style="font-size:10.5px;color:{fg3}">{s}</span></div>' for k,v,s,c in [("Total value locked","$3.78M","7 listed markets",fg),("Fees · 24h","$155K","all listed pools",fg),("Fee yield · 7d","—","no pool at 7d yet",fg3),("Swaps indexed","172,076","block 4,408,287",fg)])
    return HEAD + f'''
<div style="width:1280px;min-height:900px;background:{bg};color:{fg};font-family:{mono};font-variant-numeric:tabular-nums;display:flex">
  <aside style="width:64px;flex:none;border-right:1px solid {line};padding:14px 10px;display:flex;flex-direction:column;align-items:center;gap:6px;background:{panel}"><svg width="26" height="26" viewBox="0 0 24 24" fill="{ac}" style="display:block;margin-bottom:14px;filter:drop-shadow(0 0 10px rgba(61,214,140,.45))"><path d="M4 20V6l6 9 4-6 6 11z"></path></svg>{nav}</aside>
  <main style="flex:1;min-width:0;display:flex;flex-direction:column">
    <div style="display:flex;align-items:center;height:30px;padding:0 18px;border-bottom:1px solid {line};background:{panel};font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden">{tick}</div>
    <header style="display:flex;align-items:center;gap:10px;height:60px;padding:0 18px;border-bottom:1px solid {line}">
      <div style="display:flex;align-items:center;gap:8px;width:280px;height:38px;padding:0 14px;border:1px solid {bd};border-radius:8px;background:{panel};color:{fg4};font-size:11.5px;letter-spacing:.08em;text-transform:uppercase">{icon("search",fg3,14)}Search</div>
      <div style="display:flex;align-items:center;height:38px;border:1px solid {bd};border-radius:8px;background:{panel}">{stat("Fees","$387,569")}{stat("TVL","$3.78M")}{stat("ETH","$2,521.08")}{stat("Positions","0",True)}</div>
      <div style="flex:1"></div>
      <div style="display:flex;align-items:center;gap:7px;height:38px;padding:0 12px;border:1px solid {line};border-radius:8px;font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:{fg2}"><span style="width:5px;height:5px;border-radius:99px;background:{fg3}"></span>Indexer 67d 20h behind</div>
      <div style="display:flex;align-items:center;height:38px;padding:0 16px;border-radius:8px;border:1px solid {bd};color:{ac};font-weight:700;font-size:11px;letter-spacing:.12em;text-transform:uppercase">Connect wallet</div>
    </header>
    <div style="padding:14px 18px;display:flex;flex-direction:column;gap:12px">
      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px">{kpis}</div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">{board("Trending","by volume · 24h", ROWS)}{board("Established","7d+ · by fee yield", by_fees, yield_col=True)}</div>
    </div>
  </main>
</div>''' + TAIL

if __name__ == "__main__":
    files = {"Main.dc.html": atlas(), "LedgerB.dc.html": ledger(), "ExplorerB2.dc.html": explorer(),
             "JournalB3.dc.html": journal(), "VaultA.dc.html": vault(), "TerminalC.dc.html": terminal()}
    for name, html in files.items():
        open(name, "w").write(html)
    json.dump({
      "pages":[{"id":"page-1","name":"Light layouts"},{"id":"page-2","name":"Other directions"}],
      "artboards":[
        {"file":"Main.dc.html","title":"B1 · Atlas — cards, top nav","x":0,"y":0,"w":1280,"h":900,"page":"page-1"},
        {"file":"ExplorerB2.dc.html","title":"B2 · Explorer — chart + list","x":1380,"y":0,"w":1280,"h":900,"page":"page-1"},
        {"file":"JournalB3.dc.html","title":"B3 · Journal — leaderboard","x":0,"y":1040,"w":1280,"h":900,"page":"page-1"},
        {"file":"LedgerB.dc.html","title":"B · Ledger — the table you saw","x":1380,"y":1040,"w":1280,"h":900,"page":"page-1"},
        {"file":"VaultA.dc.html","title":"A · Vault — dark luxury","x":0,"y":0,"w":1280,"h":900,"page":"page-2"},
        {"file":"TerminalC.dc.html","title":"C · Terminal Pro — dense","x":1380,"y":0,"w":1280,"h":900,"page":"page-2"},
      ],
      "annotations":[
        {"id":"light-brief","x":0,"y":-170,"w":460,"page":"page-1","text":"Light palette (from B), three different structures. Same live data, 1280 CSS px.\nB1 Atlas: no sidebar, markets as cards — reads as a product. Trade-off: fewer numbers per token at a glance.\nB2 Explorer: featured market with a real chart beside a ranked list — reads as an exchange. Trade-off: one token dominates the page.\nB3 Journal: typographic hero and a leaderboard with big numerals — reads as a publication. Trade-off: six rows per screen.\nToken marks are placeholders — real logos slot into the same discs."},
        {"id":"other-brief","x":0,"y":-120,"w":380,"page":"page-2","text":"The dark directions from the first round, kept for reference."}
      ],
      "launch":{"view":"canvas","page":"page-1"}
    }, open("canvas.json","w"), indent=2)
    print("ok", {k: len(v) for k,v in files.items()})
