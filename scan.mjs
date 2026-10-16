// Base Watch v4 (setup detector in setup4.mjs, rebuilt after v3 caught only 3 of 14 of his own example breakouts).
// Base Watch v3: Qullamaggie-style breakout scanner. Runs on GitHub Actions (Node 20+, no dependencies).
// Rules come from his blog, FAQ, Swing Trading School streams (Aug 2020) and the setups compilation.
// v3 adds: big prior move required, flat base (no run-ups), 10-day must have caught up, tightness right before
// the break, breakout volume, ATR rules measured at the trigger price, deeper bases allowed after huge runs,
// brief MA undercuts allowed, $10M liquidity, a new 5-star grade, and intraday opening-range levels.
import { readFile, writeFile } from 'node:fs/promises';
import { detect4 } from './setup4.mjs';

const OUT = 'results.json';
const STATE = 'alerted.json';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const APP_URL = process.env.APP_URL || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- settings ----------------
export const S = {
  minPrice: 1,
  minDollarVol: Number(process.env.MIN_DOLLAR_VOL || 10_000_000), // he prefers $10M+ (compilation 11:36)
  minADR: Number(process.env.MIN_ADR || 0.04),
  rankTopPct: 0.07, maxPerScan: 50,
  minBase: 5, maxBase: 60,
  maxDepth: 0.30, maxDepthBigMove: 0.40, // 35-40% pullbacks are normal after huge runs
  minPriorMove: 0.30,                   // "big move first": 30-100%+
  maxDrift: 0.12,                       // base must be sideways: close change across the base window
  maxExt10: 1.5,                        // yesterday's close no more than 1.5x ADR above the 10-day ("10-day caught up")
  surfClose: 0.97, surfShare: 0.75,     // closes >= 97% of the MA on 75% of days (brief undercuts allowed)
  nearPct: 0.03,
  minVolBreakout: 1.5,                  // breakout volume pace vs 20-day average (my number; he says "big volume")
  earningsDays: 5,
  minStarsAlert: 3,
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
  const sec = {}; for (const { r } of pick.values()) sec[r.sector || 'Other'] = (sec[r.sector || 'Other'] || 0) + 1;
  const hot = Object.entries(sec).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  return { allUS: all.length, tradeable: U.length, perScan: keep, scans, hot, list: [...pick.values()] };
}

// ---------------- 2. price history (Yahoo) ----------------
let yahooErrors = 0; const codes = {};
export async function history(sym, q = 'range=1y&interval=1d') {
  const y = sym.replace(/\./g, '-');
  for (let a = 0; a < 4; a++) {
    const host = a % 2 ? 'query2' : 'query1';
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?${q}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (r.ok) { const j = await r.json(); return j.chart?.result?.[0] || null; }
      codes[r.status] = (codes[r.status] || 0) + 1;
      if (r.status === 404) return null;
    } catch { codes.net = (codes.net || 0) + 1; }
    await sleep(4000 * (a + 1));
  }
  yahooErrors++; return null;
}
export function clean(res) {
  const t = res.timestamp || [], q = res.indicators?.quote?.[0] || {}; const k = [];
  for (let i = 0; i < t.length; i++) if (q.close?.[i] != null && q.high?.[i] != null && q.low?.[i] != null && q.open?.[i] != null && q.low[i] > 0) k.push(i);
  const f = a => k.map(i => a[i]);
  return { t: f(t), o: f(q.open), h: f(q.high), l: f(q.low), c: f(q.close), v: f(q.volume || []).map(x => x || 0) };
}
function sessionFraction(res) {
  const p = res.meta?.currentTradingPeriod?.regular, now = Date.now() / 1000, lastT = res.timestamp?.at(-1) || 0;
  if (p && now > p.start && now < p.end && lastT >= p.start - 3600) return Math.max(0.08, (now - p.start) / (p.end - p.start));
  return 1;
}

// ---------------- helpers ----------------
export const sma = (a, n) => { const o = new Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const mx = (a, s, e) => { let m = -Infinity; for (let i = s; i <= e; i++) if (a[i] > m) m = a[i]; return m; };
const mn = (a, s, e) => { let m = Infinity; for (let i = s; i <= e; i++) if (a[i] < m) m = a[i]; return m; };
const avg = (a, s, e) => { let x = 0; for (let i = s; i <= e; i++) x += a[i]; return x / (e - s + 1); };
export const r2 = x => x == null ? null : Math.round(x * 100) / 100;
const r3 = x => x == null ? null : Math.round(x * 1000) / 1000;
export const dstr = t => new Date(t * 1000).toISOString().slice(0, 10);

// ---------------- 3. market light (Nasdaq) ----------------
export function marketLight(d) {
  const n = d.c.length, i = n - 1, s10 = sma(d.c, 10), s20 = sma(d.c, 20);
  const up10 = s10[i] > s10[i - 3], up20 = s20[i] > s20[i - 3], above = s10[i] > s20[i];
  const light = up10 && up20 && above ? 'green' : (above && (up10 || up20)) ? 'yellow' : 'red';
  const text = { green: 'Momentum market: Nasdaq 10 & 20-day rising, 10 above 20. Breakouts have the best odds.',
    yellow: 'Mixed market: only one Nasdaq average rising. Be picky and trade smaller.',
    red: 'Weak market: Nasdaq averages falling or 10 below 20. Most breakouts fail. He sits in cash.' }[light];
  return { light, text, close: r2(d.c[i]), sma10: r2(s10[i]), sma20: r2(s20[i]), up10, up20, above };
}

// ---------------- 4. setup analysis ----------------
// d = daily bars INCLUDING today (last bar may be partial). opts.backtest: return the setup even if today's close
// is far from the base, so the backtest can decide entries from the intraday high.
export function analyze(d, info, ctx, frac = 1, opts = {}) {
  const n = d.c.length, i = n - 1; if (n < 140) return null;
  const S10 = sma(d.c, 10), S20 = sma(d.c, 20), S50 = sma(d.c, 50);
  const tr = d.c.map((c, k) => k ? Math.max(d.h[k] - d.l[k], Math.abs(d.h[k] - d.c[k - 1]), Math.abs(d.l[k] - d.c[k - 1])) : d.h[k] - d.l[k]);
  const atr = avg(tr, i - 14, i - 1);
  let adr = 0; for (let k = i - 20; k < i; k++) adr += d.h[k] / d.l[k] - 1; adr /= 20;           // his ADR: 20-day avg of high/low - 1
  if (adr < S.minADR) return null;
  const vAvg = avg(d.v, i - 20, i - 1); if (!(vAvg > 0)) return null;
  const j = i - 1;
  const rising = { 10: S10[j] > S10[j - 5], 20: S20[j] > S20[j - 5], 50: S50[j] > S50[j - 5] };
  const slope20 = S20[j] / S20[j - 20] - 1;
  const ext10 = d.c[j] / S10[j] - 1;
  // v4 base: 3-40 day consolidation on a rising 10/20/50-day after a 30%+ leg, depth/drift scaled to ADR (setup4.mjs)
  const adrArr = []; adrArr[j] = adr;
  const b4 = detect4(d, i, { S10, S20, S50, adr: adrArr });
  if (b4.fail) return null;
  const { L, s, top, bot, depth, prior, surf } = b4;

  // tightness right before the breakout
  const last3 = (mx(d.h, j - 2, j) - mn(d.l, j - 2, j)) / d.c[j];
  const nr = (d.h[j] - d.l[j]) / d.c[j] <= 0.6 * adr;
  const inside = d.h[j] <= d.h[j - 1] && d.l[j] >= d.l[j - 1];
  const tight = last3 <= 2 * adr && (nr || inside || last3 <= 1.4 * adr);
  const dry = avg(d.v, j - 4, j) / avg(d.v, Math.max(0, s - 20), Math.max(1, s - 1));

  let rsNearHigh = false;
  if (ctx.ndx) { const m = ctx.ndxMap || new Map(ctx.ndx.t.map((t, k) => [Math.floor(t / 86400), ctx.ndx.c[k]]));
    let hiRS = -Infinity, cnt = 0, rsi = null;
    for (let k = Math.max(0, n - 63); k < n; k++) { const q = m.get(Math.floor(d.t[k] / 86400)); if (!q) continue; const v = d.c[k] / q; cnt++; if (v > hiRS) hiRS = v; if (k === i) rsi = v; }
    if (cnt > 40 && rsi != null) rsNearHigh = rsi >= 0.95 * hiRS; }

  const er = info.r.earnings_release_next_date ? info.r.earnings_release_next_date * 1000 : null;
  const now = opts.now || Date.now();
  const daysToEarnings = er ? Math.round((er - now) / 864e5) : null;
  const earningsSoon = daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= S.earningsDays;

  // today
  const c = d.c[i], prev = d.c[j], vr = d.v[i] / vAvg / frac;
  let st;
  if (opts.backtest) st = d.h[i] > top ? 'breakout' : c >= top * (1 - S.nearPct) ? 'near' : 'forming';
  else if (c > top) st = 'breakout';
  else if (c >= top * (1 - S.nearPct)) st = 'near';
  else if (c >= bot) st = 'forming';
  else return null;
  // ATR rules measured at the price you would actually buy (the trigger, or the open if it gapped above)
  const entryRef = Math.max(d.o[i], top);
  const chased = entryRef - prev > atr;
  const stop = d.l[i];
  const risk = entryRef - stop;
  const stopTooWide = st === 'breakout' && risk > atr;
  const volOK = vr >= S.minVolBreakout;

  // grade: his A+ traits (0-5 stars)
  let pts = 0;
  pts += prior >= 1 ? 1 : prior >= 0.5 ? 0.5 : 0;            // big move into the base
  pts += surf === 50 ? 0.5 : 1;                               // best ones surf the 10/20
  pts += tight ? 1 : last3 <= 2 * adr ? 0.5 : 0;              // tight, narrow day before the break
  pts += slope20 >= 0.15 ? 1 : slope20 >= 0.08 ? 0.5 : 0;     // steep (45 degrees+) trend
  pts += rsNearHigh ? 0.5 : 0;
  pts += ctx.hot.includes(info.r.sector) ? 0.5 : 0;           // leading sector
  pts += dry < 0.8 ? 0.5 : 0;                                 // volume drying up in the base
  pts += adr >= 0.06 ? 0.5 : 0;                               // "high ADR is gold"
  const stars = Math.max(1, Math.min(5, Math.round(pts / 6 * 5 * 2) / 2));
  const grade = { prior: r3(prior), surf, tight, nr, inside, slope20: r3(slope20), rsNearHigh, hot: ctx.hot.includes(info.r.sector), dry: r2(dry), adr: r3(adr) };

  return {
    t: info.r.name, nm: (info.r.description || '').slice(0, 40), mc: Math.round((info.r.market_cap_basic || 0) / 1e6), sec: info.r.sector || '',
    ind: info.r.industry || '', hotSector: grade.hot, scans: info.scans,
    st, date: dstr(d.t[i]), p: r2(c), chg: r3(c / prev - 1), open: r2(d.o[i]), high: r2(d.h[i]), low: r2(d.l[i]),
    top: r2(top), bot: r2(bot), L, depth: r3(depth), prior: r3(prior), adr: r3(adr), atr: r2(atr), vr: r2(vr), volOK, live: frac < 1,
    surf, slope20: r3(slope20), ext10: r3(ext10), tight, nr, inside, rsNearHigh, dry: r2(dry),
    sma10: r2(S10[i]), sma20: r2(S20[i]), sma50: r2(S50[i]),
    earningsDays: daysToEarnings, earningsSoon,
    trigger: r2(top), tooLate: r2(prev + atr),
    entry: st === 'breakout' ? r2(entryRef) : null, stop: st === 'breakout' ? r2(stop) : null, risk: st === 'breakout' ? r2(risk) : null, stopTooWide, chased,
    stars, grade, i,
    cl: d.c.slice(-60).map(r2), s10: S10.slice(-60).map(r2), s20: S20.slice(-60).map(r2), s50: S50.slice(-60).map(r2), bs: 60 - (i - s) - 1,
  };
}

// ---------------- 5. intraday opening range (Yahoo 5-minute bars, today only) ----------------
async function intraday(sym) {
  const res = await history(sym, 'range=1d&interval=5m'); if (!res?.timestamp) return null;
  const p = res.meta?.currentTradingPeriod?.regular; const d = clean(res);
  const k = d.t.map((t, i) => i).filter(i => !p || (d.t[i] >= p.start && d.t[i] < p.end)); if (!k.length) return null;
  const H = k.map(i => d.h[i]), Lw = k.map(i => d.l[i]);
  const first12 = Math.min(12, k.length);
  return { orh5: r2(H[0]), orl5: r2(Lw[0]), orh60: k.length >= 12 ? r2(Math.max(...H.slice(0, 12))) : null, orl60: k.length >= 12 ? r2(Math.min(...Lw.slice(0, 12))) : null,
    hod: r2(Math.max(...H)), lod: r2(Math.min(...Lw)), last: r2(d.c[k.at(-1)]), bars: k.length, firstHourDone: first12 >= 12, asOf: new Date(d.t[k.at(-1)] * 1000).toISOString() };
}

// ---------------- 6. paper-trade tracker ----------------
function simulate(tr, d) {
  const dates = d.t.map(dstr); const e = dates.indexOf(tr.entryDate);
  if (e < 0) return tr;
  const S10 = sma(d.c, 10); const R = tr.entry - tr.stop0;
  let stop = tr.stop0, left = 1, realized = 0, half = false; const ev = [];
  const exitAll = (px, k, why) => { realized += left * (px - tr.entry); left = 0; ev.push({ d: dates[k], what: why, px: r2(px) }); };
  if (d.l[e] < tr.stop0 - 0.006) exitAll(tr.stop0, e, 'Stopped out on entry day');
  for (let k = e + 1; k < d.c.length && left > 0; k++) {
    const day = k - e;
    if (d.o[k] <= stop) { exitAll(d.o[k], k, stop > tr.stop0 ? 'Gapped below break-even stop' : 'Gapped below stop'); break; }
    if (d.l[k] <= stop) { exitAll(stop, k, stop > tr.stop0 ? 'Break-even stop hit' : 'Stopped out (day low)'); break; }
    if (!half && day >= 3) { realized += 0.5 * (d.c[k] - tr.entry); left = 0.5; half = true; stop = Math.max(stop, tr.entry);
      ev.push({ d: dates[k], what: 'Sold half (day 3), stop to break-even', px: r2(d.c[k]) }); continue; }
    if (half && S10[k] != null && d.c[k] < S10[k]) { exitAll(d.c[k], k, 'Closed below 10-day SMA'); break; }
  }
  const last = d.c.at(-1);
  const pnl = realized + left * (last - tr.entry);
  return { ...tr, status: left > 0 ? 'open' : 'closed', half, stopNow: r2(stop), last: r2(last), lastDate: dates.at(-1),
    days: d.c.length - 1 - e, events: ev, rMult: R > 0 ? Math.round(pnl / R * 100) / 100 : null, pct: Math.round(pnl / tr.entry * 10000) / 100,
    exitDate: left > 0 ? null : ev.at(-1).d };
}
const followsRules = (r, light) => !r.stopTooWide && !r.earningsSoon && light !== 'red';   // v4: no gap ('chased') or volume rule; you judge volume
async function updateTracker(prev, breakouts, bars, market) {
  const tk = prev?.trades ? prev : { startedAt: new Date().toISOString(), trades: [] };
  const trades = tk.trades.map(t => ({ ...t }));
  const today = new Date().toISOString().slice(0, 10);
  for (const r of breakouts) {
    if (r.date !== today && Date.now() - Date.parse(r.date) > 4 * 864e5) continue;
    if (trades.some(t => t.t === r.t && (t.status === 'open' || t.entryDate === r.date))) continue;
    const entry = r.plan?.entry ?? r.entry, stop0 = r.plan?.stop ?? r.stop;
    if (!(stop0 > 0) || !(entry > stop0)) continue;
    trades.push({ id: r.t + '|' + r.date, t: r.t, nm: r.nm, entryDate: r.date, entry, stop0, stars: r.stars, surf: r.surf,
      market: market.light, followedRules: followsRules(r, market.light),
      flags: [r.chased && 'chased', r.stopTooWide && 'wide stop', r.earningsSoon && 'earnings', !r.volOK && 'low volume', !r.tight && 'not tight', market.light === 'red' && 'red market'].filter(Boolean),
      status: 'open', rMult: 0, pct: 0, days: 0, events: [] });
  }
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]; if (t.status === 'closed') continue;
    let d = bars.get(t.t);
    if (!d) { const res = await history(t.t); d = res?.timestamp ? clean(res) : null; await sleep(250); }
    if (d) trades[i] = simulate(t, d);
  }
  return { startedAt: tk.startedAt, updatedAt: new Date().toISOString(),
    rules: 'Entry at the trigger (or the open if it gapped above), stop = day low; day 3: sell half at close, stop to break-even; rest: first close below the 10-day SMA. Daily bars, no costs.',
    trades };
}

// ---------------- 7. push ----------------
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
const packBars = (d, n = 130) => { const s = Math.max(0, d.c.length - n); const f = a => a.slice(s).map(r2);
  return { t: d.t.slice(s).map(t => Math.floor(t / 86400)), o: f(d.o), h: f(d.h), l: f(d.l), c: f(d.c), v: d.v.slice(s).map(v => Math.round(v / 1000)) }; };

// ---------------- run ----------------
async function main() {
  const t0 = Date.now();
  const U = await universe();
  console.log(`US stocks ${U.allUS}, pass $vol+ADR ${U.tradeable}, ${U.perScan}/scan, candidates ${U.list.length}, hot ${U.hot}`);
  const ndxRes = await history('^IXIC'); const ndx = ndxRes ? clean(ndxRes) : null;
  const market = ndx ? marketLight(ndx) : { light: 'unknown', text: 'Could not load Nasdaq data.' };
  const ctx = { ndx, hot: U.hot };
  const out = []; const bars = new Map(); let k = 0, done = 0;
  const worker = async () => {
    while (k < U.list.length) {
      const info = U.list[k++]; const res = await history(info.r.name, 'range=2y&interval=1d'); done++;
      if (res?.timestamp) { try { const cd = clean(res); bars.set(info.r.name, cd); const x = analyze(cd, info, ctx, sessionFraction(res)); if (x) out.push(x); } catch (e) { console.log('analyze', info.r.name, e.message); } }
      await sleep(250);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const rank = (a, b) => b.stars - a.stars || (a.top - a.p) / a.top - (b.top - b.p) / b.top;
  const by = st => out.filter(x => x.st === st).sort(rank);
  const rows = [...by('breakout'), ...by('near'), ...by('forming')];

  // intraday opening range + chart bars for the names you might act on
  const focus = [...by('breakout'), ...by('near')].slice(0, 25);
  for (const r of focus) {
    try { r.intra = await intraday(r.t); } catch { r.intra = null; } await sleep(250);
    if (r.st === 'breakout' && r.intra) {
      const orh = r.intra.orh5 ?? r.trigger;
      const entry = Math.max(r.trigger, orh, r.open ?? 0);
      r.plan = { entry: r2(entry), stop: r.intra.lod, risk: r2(entry - r.intra.lod), wide: entry - r.intra.lod > r.atr, basis: 'max(trigger, 5-min ORH, open); stop = low of day so far' };
    }
  }
  for (const r of rows.slice(0, 30)) { const d = bars.get(r.t); if (d) r.bars = packBars(d); }
  rows.forEach(r => { delete r.i; });

  let prevKeys = [], prevTracker = null;
  try { const prev = JSON.parse(await readFile(OUT, 'utf8')); prevKeys = prev.keys || []; prevTracker = prev.tracker || null; } catch {}
  const tracker = await updateTracker(prevTracker, by('breakout'), bars, market);
  const result = {
    version: 4, ranAt: new Date().toISOString(), market, settings: { minDollarVol: S.minDollarVol, minADR: S.minADR, perScan: U.perScan, minVolBreakout: S.minVolBreakout },
    allUS: U.allUS, tradeable: U.tradeable, candidates: U.list.length, scans: U.scans, hotSectors: U.hot,
    scanned: done, errors: yahooErrors, codes, seconds: Math.round((Date.now() - t0) / 1000),
    counts: { breakout: by('breakout').length, near: by('near').length, forming: by('forming').length },
    keys: rows.map(r => r.t + '|' + r.st), prevKeys, rows, tracker,
  };
  await writeFile(OUT, JSON.stringify(result));
  console.log(`Done in ${result.seconds}s: ${JSON.stringify(result.counts)}, market ${market.light}, Yahoo errors ${yahooErrors} ${JSON.stringify(codes)}`);

  // alerts: once per ticker+stage per day. Backtest (Oct 2026): breakout volume >= 1.5x and a non-red market were the
  // only filters that clearly helped; tightness and stars did not, so they are shown but not required for breakouts.
  const today = new Date().toISOString().slice(0, 10);
  let state = { day: today, sent: [] };
  try { const s = JSON.parse(await readFile(STATE, 'utf8')); if (s.day === today) state = s; } catch {}
  const fresh = r => !r.earningsSoon && !state.sent.includes(r.t + '|' + r.st);
  const bo = by('breakout').filter(r => fresh(r) && !r.stopTooWide && !(r.plan?.wide) && market.light !== 'red').slice(0, 6);
  const nr = by('near').filter(r => fresh(r) && r.stars >= S.minStarsAlert).slice(0, 8);
  const mk = market.light === 'green' ? '🟢' : market.light === 'yellow' ? '🟡' : '🔴';
  let ok = true;
  if (bo.length) {
    ok = await notify(`${mk} ${bo.length} breakout${bo.length > 1 ? 's' : ''}: ${bo.slice(0, 4).map(r => r.t).join(', ')}`,
      bo.map(r => `${r.t} ${star(r.stars)} buy > ${r.plan?.entry ?? r.entry} · stop ${r.plan?.stop ?? r.stop} (ATR ${r.atr}) · vol ×${r.vr}`).join('\n') +
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
