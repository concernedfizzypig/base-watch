// Base Watch v2: Qullamaggie-style breakout scanner. Runs on GitHub Actions (Node 20+, no dependencies).
// Rules come from his "Swing Trading School" streams (Jul-Aug 2020) and his blog post on the 3 timeless setups.
// 1) Universe: all US stocks over $1 with enough dollar volume and ADR (his liquidity + volatility filters).
// 2) His momentum scans: rank by 1/3/6-month gain (close-to-close AND from the lowest low), keep the top few %.
// 3) Daily prices from Yahoo -> look for the setup: surfing rising 10/20/50-day SMAs, higher lows, tight range, breakout.
// 4) Nasdaq "market light" (10 & 20-day SMAs rising, 10 above 20). Earnings dates from TradingView.
// 5) Writes results.json for the app and pushes alerts to ntfy.
import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'results.json';
const STATE = 'alerted.json';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const APP_URL = process.env.APP_URL || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- settings (his numbers; change to suit your account) ----------------
const S = {
  minPrice: 1,
  minDollarVol: Number(process.env.MIN_DOLLAR_VOL || 5_000_000), // he says ~30-50x your account size
  minADR: Number(process.env.MIN_ADR || 0.05),                     // he says 5-6% for most people (he uses 3.5-4%)
  rankTopPct: 0.07,     // keep the top 7% of each momentum scan ("rank 93%")
  maxPerScan: 50,       // he wants no more than ~50 results per scan
  minBase: 5, maxBase: 60,  // "2 weeks to 2 months", but tight flags can be shorter
  maxDepth: 0.30,       // deepest pullback allowed inside the base
  nearPct: 0.03,        // within 3% of the breakout level = near breakout
  maxExtended: 0.10,    // ignore if already >10% above the breakout level
  earningsDays: 5,      // calendar days; he won't buy within ~3 trading days of earnings
};

// ---------------- 1. universe + momentum scans (TradingView) ----------------
async function tv(body) {
  const r = await fetch('https://scanner.tradingview.com/america/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://www.tradingview.com', referer: 'https://www.tradingview.com/', 'user-agent': UA },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('TradingView screener ' + r.status);
  return r.json();
}
async function universe() {
  const base = [
    { left: 'type', operation: 'in_range', right: ['stock', 'dr'] },
    { left: 'exchange', operation: 'in_range', right: ['NASDAQ', 'NYSE', 'AMEX'] },
  ];
  const cols = ['name', 'description', 'close', 'market_cap_basic', 'sector', 'industry', 'average_volume_30d_calc', 'ADR', 'ATR',
    'Perf.1M', 'Perf.3M', 'Perf.6M', 'Low.1M', 'Low.3M', 'Low.6M', 'earnings_release_next_date'];
  const j = await tv({ filter: [...base, { left: 'close', operation: 'greater', right: S.minPrice }], markets: ['america'], columns: cols, range: [0, 12000] });
  const all = j.data.map(x => Object.fromEntries(cols.map((c, i) => [c, x.d[i]])));
  const U = all.filter(r => r.close * r.average_volume_30d_calc >= S.minDollarVol && r.ADR / r.close >= S.minADR);
  // his six momentum measures: C/C21, C/C63, C/C126 (close-to-close) and C/MinL22, C/MinL67, C/MinL126 (from the low)
  const measures = {
    m1: r => r['Perf.1M'], m3: r => r['Perf.3M'], m6: r => r['Perf.6M'],
    l1: r => r.close / r['Low.1M'] - 1, l3: r => r.close / r['Low.3M'] - 1, l6: r => r.close / r['Low.6M'] - 1,
  };
  const keep = Math.min(S.maxPerScan, Math.max(10, Math.round(U.length * S.rankTopPct)));
  const scans = {}; const pick = new Map();
  for (const [k, f] of Object.entries(measures)) {
    const top = U.filter(r => Number.isFinite(f(r))).sort((a, b) => f(b) - f(a)).slice(0, keep);
    scans[k] = top.length;
    for (const r of top) { const p = pick.get(r.name) || { r, scans: [] }; p.scans.push(k); pick.set(r.name, p); }
  }
  // sector heat: which sectors have the most momentum leaders right now
  const sec = {}; for (const { r } of pick.values()) sec[r.sector || 'Other'] = (sec[r.sector || 'Other'] || 0) + 1;
  const hot = Object.entries(sec).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  return { allUS: all.length, tradeable: U.length, perScan: keep, scans, hot, list: [...pick.values()] };
}

// ---------------- 2. price history (Yahoo) ----------------
let yahooErrors = 0; const codes = {};
async function history(sym) {
  const y = sym.replace(/\./g, '-');
  for (let a = 0; a < 4; a++) {
    const host = a % 2 ? 'query2' : 'query1';
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=1y&interval=1d`, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (r.ok) { const j = await r.json(); return j.chart?.result?.[0] || null; }
      codes[r.status] = (codes[r.status] || 0) + 1;
      if (r.status === 404) return null;
    } catch { codes.net = (codes.net || 0) + 1; }
    await sleep(4000 * (a + 1));
  }
  yahooErrors++; return null;
}
function clean(res) {
  const t = res.timestamp || [], q = res.indicators?.quote?.[0] || {}; const k = [];
  for (let i = 0; i < t.length; i++) if (q.close?.[i] != null && q.high?.[i] != null && q.low?.[i] != null && q.open?.[i] != null) k.push(i);
  const f = a => k.map(i => a[i]);
  return { t: f(t), o: f(q.open), h: f(q.high), l: f(q.low), c: f(q.close), v: f(q.volume || []).map(x => x || 0) };
}
function sessionFraction(res) {
  const p = res.meta?.currentTradingPeriod?.regular, now = Date.now() / 1000, lastT = res.timestamp?.at(-1) || 0;
  if (p && now > p.start && now < p.end && lastT >= p.start - 3600) return Math.max(0.08, (now - p.start) / (p.end - p.start));
  return 1;
}

// ---------------- helpers ----------------
const sma = (a, n) => a.map((_, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; });
const mx = (a, s, e) => { let m = -Infinity; for (let i = s; i <= e; i++) if (a[i] > m) m = a[i]; return m; };
const mn = (a, s, e) => { let m = Infinity; for (let i = s; i <= e; i++) if (a[i] < m) m = a[i]; return m; };
const avg = (a, s, e) => { let x = 0; for (let i = s; i <= e; i++) x += a[i]; return x / (e - s + 1); };
const r2 = x => x == null ? null : Math.round(x * 100) / 100, r3 = x => x == null ? null : Math.round(x * 1000) / 1000;

// ---------------- 3. market light (Nasdaq) ----------------
function marketLight(d) {
  const n = d.c.length, i = n - 1, s10 = sma(d.c, 10), s20 = sma(d.c, 20);
  const up10 = s10[i] > s10[i - 3], up20 = s20[i] > s20[i - 3], above = s10[i] > s20[i];
  const light = up10 && up20 && above ? 'green' : (above && (up10 || up20)) ? 'yellow' : 'red';
  const text = { green: 'Momentum market: Nasdaq 10 & 20-day rising, 10 above 20. Breakouts have the best odds.',
    yellow: 'Mixed market: only one Nasdaq average rising. Be picky and trade smaller.',
    red: 'Weak market: Nasdaq averages falling or 10 below 20. Most breakouts fail. He sits in cash.' }[light];
  return { light, text, close: r2(d.c[i]), sma10: r2(s10[i]), sma20: r2(s20[i]), up10, up20, above, cl: d.c.slice(-60).map(r2), s10: s10.slice(-60).map(r2), s20: s20.slice(-60).map(r2) };
}

// ---------------- 4. setup analysis ----------------
export function analyze(d, info, ctx, frac = 1) {
  const n = d.c.length, i = n - 1; if (n < 130) return null;
  const S10 = sma(d.c, 10), S20 = sma(d.c, 20), S50 = sma(d.c, 50);
  const tr = d.c.map((c, k) => k ? Math.max(d.h[k] - d.l[k], Math.abs(d.h[k] - d.c[k - 1]), Math.abs(d.l[k] - d.c[k - 1])) : d.h[k] - d.l[k]);
  const atr = avg(tr, i - 14, i - 1);                     // average true range (14d, excluding today)
  let adr = 0; for (let k = i - 20; k < i; k++) adr += d.h[k] / d.l[k] - 1; adr /= 20;   // ADR % (20d)
  if (adr < S.minADR) return null;
  const vAvg = avg(d.v, i - 20, i - 1); if (!(vAvg > 0)) return null;

  // moving averages rising (vs 5 days ago) and steepness of the 20-day (his "45 degrees")
  const j = i - 1;
  const rising = { 10: S10[j] > S10[j - 5], 20: S20[j] > S20[j - 5], 50: S50[j] > S50[j - 5] };
  if (!(rising[20] && rising[50])) return null;           // trend must be up
  const slope20 = S20[j] / S20[j - 20] - 1;               // % the 20-day rose over the last 20 days

  // base: best window ending yesterday with higher lows and a contracting range, near the highs
  const hi120 = mx(d.h, Math.max(0, i - 120), j); let best = null;
  for (let L = S.minBase; L <= S.maxBase; L++) {
    const s = i - L; if (s < 60) break;
    const top = mx(d.h, s, j), bot = mn(d.l, s, j), depth = (top - bot) / top; if (depth > S.maxDepth) continue;
    if (top < 0.85 * hi120) continue;
    const hf = Math.floor(L / 2);
    const ra = mx(d.h, s, s + hf - 1) - mn(d.l, s, s + hf - 1), rb = mx(d.h, s + hf, j) - mn(d.l, s + hf, j);
    if (rb > ra) continue;                                            // range not widening
    if (mn(d.l, s + hf, j) < mn(d.l, s, s + hf - 1)) continue;       // higher lows
    best = { L, s, top, bot, depth };
  }
  if (!best) return null;
  const { L, s, top, bot, depth } = best;

  // which moving average is it "surfing"? (closes hold above it, lows come back to it)
  let surf = null;
  for (const [nm, A] of [[10, S10], [20, S20], [50, S50]]) {
    if (!rising[nm]) continue;
    const w0 = Math.max(s, j - 15); let above = 0, touch = false;
    for (let k = w0; k <= j; k++) { if (d.c[k] >= A[k] * 0.98) above++; if (d.l[k] <= A[k] * 1.03) touch = true; }
    if (above / (j - w0 + 1) >= 0.8 && touch) { surf = nm; break; }
  }
  if (!surf) return null;                                   // he only buys stocks surfing the 10, 20 or 50

  // tightness: last 3 days' range vs ADR, and a narrow-range day just before
  const last3 = (mx(d.h, j - 2, j) - mn(d.l, j - 2, j)) / d.c[j];
  const tight = last3 <= 2 * adr;
  const nr = (d.h[j] - d.l[j]) / d.c[j] <= 0.6 * adr;       // yesterday was a narrow candle
  const dry = avg(d.v, j - 4, j) / avg(d.v, Math.max(0, s - 20), Math.max(1, s - 1)); // volume drying up in the base

  // relative strength vs Nasdaq: RS line near its 3-month high
  let rsNearHigh = false;
  if (ctx.ndx) { const m = new Map(ctx.ndx.t.map((t, k) => [Math.floor(t / 86400), ctx.ndx.c[k]])); const rs = d.t.map((t, k) => { const q = m.get(Math.floor(t / 86400)); return q ? d.c[k] / q : null; });
    const win = rs.slice(-63).filter(x => x != null); if (win.length > 40) rsNearHigh = rs[i] != null && rs[i] >= 0.95 * Math.max(...win); }

  // earnings
  const er = info.r.earnings_release_next_date ? info.r.earnings_release_next_date * 1000 : null;
  const daysToEarnings = er ? Math.round((er - Date.now()) / 864e5) : null;
  const earningsSoon = daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= S.earningsDays;

  // stage
  const c = d.c[i], prev = d.c[j], vr = d.v[i] / vAvg / frac, upToday = c - prev;
  let st;
  if (c > top) { if (c > top * (1 + S.maxExtended)) return null; st = 'breakout'; }
  else if (c >= top * (1 - S.nearPct)) st = 'near';
  else if (c >= bot) st = 'forming';
  else return null;
  const chased = upToday > atr;                              // "don't buy if it's up more than its ATR today"
  const stop = st === 'breakout' ? d.l[i] : null;
  const risk = stop != null ? c - stop : null;
  const stopTooWide = risk != null && risk > atr;            // stop must not be wider than ATR

  // star rating (my scoring of his checklist, 1-5)
  let pts = 0;
  pts += surf === 10 ? 2 : surf === 20 ? 2 : 1;              // best ones surf the 10/20
  pts += tight ? 1 : 0; pts += nr ? 1 : 0;
  pts += slope20 >= 0.10 ? 1 : slope20 >= 0.05 ? 0.5 : 0;     // steep trend
  pts += rsNearHigh ? 1 : 0; pts += ctx.hot.includes(info.r.sector) ? 0.5 : 0;
  pts += dry < 0.8 ? 0.5 : 0; pts += info.scans.length >= 3 ? 0.5 : 0;
  const stars = Math.max(1, Math.min(5, Math.round(pts * 5 / 7.5 * 2) / 2));

  return {
    t: info.r.name, nm: (info.r.description || '').slice(0, 40), mc: Math.round((info.r.market_cap_basic || 0) / 1e6), sec: info.r.sector || '',
    ind: info.r.industry || '', hotSector: ctx.hot.includes(info.r.sector), scans: info.scans,
    st, date: new Date(d.t[i] * 1000).toISOString().slice(0, 10), p: r2(c), chg: r3(c / prev - 1),
    top: r2(top), bot: r2(bot), L, depth: r3(depth), adr: r3(adr), atr: r2(atr), vr: r2(vr), live: frac < 1,
    surf, slope20: r3(slope20), tight, nr, rsNearHigh, dry: r2(dry),
    sma10: r2(S10[i]), sma20: r2(S20[i]), sma50: r2(S50[i]),
    earningsDays: daysToEarnings, earningsSoon,
    trigger: r2(top), tooLate: r2(prev + atr),               // above this today = chasing
    entry: st === 'breakout' ? r2(c) : null, stop: r2(stop), risk: r2(risk), stopTooWide, chased,
    stars,
    cl: d.c.slice(-60).map(r2), s10: S10.slice(-60).map(r2), s20: S20.slice(-60).map(r2), s50: S50.slice(-60).map(r2), bs: 60 - (i - s) - 1,
  };
}

// ---------------- 5. push ----------------
async function notify(title, body, tags, priority) {
  if (!NTFY_TOPIC) { console.log('NTFY_TOPIC secret is not set - no push sent'); return false; }
  try {
    const r = await fetch('https://ntfy.sh/' + encodeURIComponent(NTFY_TOPIC), {
      method: 'POST', body,
      headers: { Title: title, Tags: tags, Priority: String(priority), ...(APP_URL ? { Click: APP_URL } : {}) },
    });
    console.log('ntfy', r.status, title);
    return r.ok;
  } catch (e) { console.log('ntfy failed', e.message); return false; }
}
const star = n => '★'.repeat(Math.floor(n)) + (n % 1 ? '½' : '');

// ---------------- run ----------------
async function main() {
  const t0 = Date.now();
  const U = await universe();
  console.log(`US stocks ${U.allUS}, pass $vol+ADR ${U.tradeable}, ${U.perScan}/scan, candidates ${U.list.length}, hot ${U.hot}`);
  const ndxRes = await history('^IXIC'); const ndx = ndxRes ? clean(ndxRes) : null;
  const market = ndx ? marketLight(ndx) : { light: 'unknown', text: 'Could not load Nasdaq data.' };
  const ctx = { ndx, hot: U.hot };
  const out = []; let k = 0, done = 0;
  const worker = async () => {
    while (k < U.list.length) {
      const info = U.list[k++]; const res = await history(info.r.name); done++;
      if (res?.timestamp) { try { const x = analyze(clean(res), info, ctx, sessionFraction(res)); if (x) out.push(x); } catch (e) { console.log('analyze', info.r.name, e.message); } }
      await sleep(250);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const rank = (a, b) => b.stars - a.stars || (a.top - a.p) / a.top - (b.top - b.p) / b.top;
  const by = st => out.filter(x => x.st === st).sort(rank);
  const rows = [...by('breakout'), ...by('near'), ...by('forming')];

  let prevKeys = [];
  try { prevKeys = JSON.parse(await readFile(OUT, 'utf8')).keys || []; } catch {}
  const result = {
    version: 2, ranAt: new Date().toISOString(), market, settings: { minDollarVol: S.minDollarVol, minADR: S.minADR, perScan: U.perScan },
    allUS: U.allUS, tradeable: U.tradeable, candidates: U.list.length, scans: U.scans, hotSectors: U.hot,
    scanned: done, errors: yahooErrors, codes, seconds: Math.round((Date.now() - t0) / 1000),
    counts: { breakout: by('breakout').length, near: by('near').length, forming: by('forming').length },
    keys: rows.map(r => r.t + '|' + r.st), prevKeys, rows,
  };
  await writeFile(OUT, JSON.stringify(result));
  console.log(`Done in ${result.seconds}s: ${JSON.stringify(result.counts)}, market ${market.light}, Yahoo errors ${yahooErrors} ${JSON.stringify(codes)}`);

  // alerts: once per ticker+stage per day; skip earnings-soon; breakouts only pushed loudly in a green/yellow market
  const today = new Date().toISOString().slice(0, 10);
  let state = { day: today, sent: [] };
  try { const s = JSON.parse(await readFile(STATE, 'utf8')); if (s.day === today) state = s; } catch {}
  const ok4 = r => !r.earningsSoon && !state.sent.includes(r.t + '|' + r.st);
  const bo = by('breakout').filter(r => ok4(r) && !r.stopTooWide && !r.chased).slice(0, 6);
  const nr = by('near').filter(r => ok4(r) && r.stars >= 3).slice(0, 8);
  const mk = market.light === 'green' ? '🟢' : market.light === 'yellow' ? '🟡' : '🔴';
  let ok = true;
  if (bo.length) {
    ok = await notify(`${mk} ${bo.length} breakout${bo.length > 1 ? 's' : ''}: ${bo.slice(0, 4).map(r => r.t).join(', ')}`,
      bo.map(r => `${r.t} ${star(r.stars)} ${r.p} > ${r.trigger} · stop ${r.stop} (ATR ${r.atr}) · surfing ${r.surf}d`).join('\n') +
      (market.light === 'red' ? '\nMarket is red: most breakouts fail now.' : ''), 'rocket', market.light === 'red' ? 3 : 4) && ok;
  }
  if (nr.length) {
    ok = await notify(`${mk} Watchlist: ${nr.slice(0, 4).map(r => r.t).join(', ')}`,
      nr.map(r => `${r.t} ${star(r.stars)} trigger ${r.trigger} (${((r.top - r.p) / r.top * 100).toFixed(1)}% away) · too late > ${r.tooLate}`).join('\n'), 'eyes', 3) && ok;
  }
  if (U.list.length > 30 && yahooErrors > U.list.length * 0.5) {
    await notify('Base Watch scan problem', `Price data failed for ${yahooErrors} of ${U.list.length} stocks ${JSON.stringify(codes)}.`, 'warning', 3);
  }
  if (ok) state.sent.push(...[...bo, ...nr].map(r => r.t + '|' + r.st));
  await writeFile(STATE, JSON.stringify(state));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async e => { console.error(e); await notify('Base Watch scan failed', String(e.message || e), 'warning', 3); process.exit(1); });
}
