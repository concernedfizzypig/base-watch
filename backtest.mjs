// Base Watch backtest v2 (realistic, not optimistic). Uses the SAME analyze() as scan.mjs (v3 rules).
// P = 5 years of daily bars, PESSIMISTIC: buy-stop at the trigger (or the open if it gapped above), stop = the day's
//     low (never tighter than 0.3 ATR), and if the stock closes below your entry that day it counts as a full loser
//     (assumed stopped out), even though many of those would have survived. 0.1% cost each side.
// H = last ~2 years with HOURLY bars, REALISTIC: wait for the first 60-minute candle, buy when a later hour trades
//     above max(trigger, 60-min opening range high), stop = low of the day up to that moment, stopped out if a later
//     hour that day touches it. Volume pace at entry is measured. 0.1% cost each side.
// Both: skip if entry is more than 1 ATR above yesterday's close or the stop is wider than 1 ATR; day 3 sell half at
// the close + stop to break-even; rest on the first close below the 10-day SMA. One open trade per stock.
import { writeFile } from 'node:fs/promises';
import { analyze, history, clean, sma, r2, dstr, marketLight, S } from './scan.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const YEARS = Number(process.env.BT_YEARS || 5);
const FETCH_MIN_DV = Number(process.env.FETCH_MIN_DV || 3_000_000);
const COST = 0.001, RISK = 0.005, CAP = 0.25;

async function tvList() {
  const cols = ['name', 'description', 'close', 'market_cap_basic', 'sector', 'industry', 'average_volume_30d_calc'];
  const r = await fetch('https://scanner.tradingview.com/america/scan', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.tradingview.com', referer: 'https://www.tradingview.com/', 'user-agent': UA },
    body: JSON.stringify({ filter: [{ left: 'type', operation: 'in_range', right: ['stock', 'dr'] }, { left: 'exchange', operation: 'in_range', right: ['NASDAQ', 'NYSE', 'AMEX'] },
      { left: 'close', operation: 'greater', right: 1 }], markets: ['america'], columns: cols, range: [0, 12000] }),
  });
  if (!r.ok) throw new Error('TradingView ' + r.status);
  const j = await r.json();
  return j.data.map(x => Object.fromEntries(cols.map((c, i) => [c, x.d[i]]))).filter(r => r.close * r.average_volume_30d_calc >= FETCH_MIN_DV);
}
const slice = (d, a, b) => ({ t: d.t.slice(a, b), o: d.o.slice(a, b), h: d.h.slice(a, b), l: d.l.slice(a, b), c: d.c.slice(a, b), v: d.v.slice(a, b) });

// manage an open position from day e+1 on daily bars (entry and stop already decided on day e)
function manage(d, e, entry, stop0, S10) {
  let stop = stop0, left = 1, realized = 0, half = false, exitK = null, why = 'still open';
  const out = (px, k, w) => { realized += left * (px * (1 - COST) - entry); left = 0; exitK = k; why = w; };
  for (let k = e + 1; k < d.c.length && left > 0; k++) {
    if (d.o[k] <= stop) { out(d.o[k], k, half ? 'gap below break-even' : 'gap below stop'); break; }
    if (d.l[k] <= stop) { out(stop, k, half ? 'break-even stop' : 'stopped'); break; }
    if (!half && k - e >= 3) { realized += 0.5 * (d.c[k] * (1 - COST) - entry); left = 0.5; half = true; stop = Math.max(stop, entry); continue; }
    if (half && S10[k] != null && d.c[k] < S10[k]) { out(d.c[k], k, 'close < 10-day'); break; }
  }
  const pnl = realized + left * (d.c.at(-1) - entry);
  return { pnl, exitK, why, open: left > 0 };
}

function stats(T) {
  const n = T.length; if (!n) return { n: 0 };
  const R = T.map(t => t.R).sort((a, b) => a - b), sum = R.reduce((a, b) => a + b, 0);
  const acct = T.reduce((a, t) => a + t.R * Math.min(RISK, CAP * t.riskPct), 0);
  const byExit = [...T].sort((a, b) => (a.exit || '9999').localeCompare(b.exit || '9999'));
  let cum = 0, peak = 0, dd = 0, cumA = 0, peakA = 0, ddA = 0;
  for (const t of byExit) { cum += t.R; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); cumA += t.R * Math.min(RISK, CAP * t.riskPct); peakA = Math.max(peakA, cumA); ddA = Math.min(ddA, cumA - peakA); }
  const yr = {}; for (const t of T) { const y = t.date.slice(0, 4); yr[y] = yr[y] || { n: 0, R: 0, w: 0 }; yr[y].n++; yr[y].R += t.R; if (t.R > 0) yr[y].w++; }
  for (const y in yr) { yr[y].R = r2(yr[y].R); yr[y].win = r2(yr[y].w / yr[y].n); delete yr[y].w; }
  return { n, win: r2(T.filter(t => t.R > 0).length / n), avgR: r2(sum / n), medR: R[Math.floor(n / 2)], totR: r2(sum), best: R.at(-1), worst: R[0],
    big5R: T.filter(t => t.R >= 5).length, avgPct: r2(T.reduce((a, t) => a + t.pct, 0) / n), acctPct: r2(acct * 100), maxDDR: r2(dd), maxDDacctPct: r2(ddA * 100), byYear: yr };
}
function groups(T) {
  const g = (f) => stats(T.filter(f));
  return { all: g(() => true), green: g(t => t.mkt === 'green'), yellow: g(t => t.mkt === 'yellow'), red: g(t => t.mkt === 'red'), notRed: g(t => t.mkt !== 'red'),
    stars45: g(t => t.stars >= 4), stars3: g(t => t.stars >= 3 && t.stars < 4), starsLow: g(t => t.stars < 3),
    tight: g(t => t.tight), notTight: g(t => !t.tight), vol15: g(t => t.vr >= 1.5), volLow: g(t => t.vr < 1.5),
    surf10: g(t => t.surf === 10), surf20: g(t => t.surf === 20), surf50: g(t => t.surf === 50),
    fullRules: g(t => t.mkt !== 'red' && t.tight && t.vr >= 1.5 && t.stars >= 3),
    fullRulesGreen4: g(t => t.mkt === 'green' && t.tight && t.vr >= 1.5 && t.stars >= 4) };
}

async function main() {
  const t0 = Date.now();
  const list = await tvList(); console.log('downloading', list.length, 'stocks');
  const now = Math.floor(Date.now() / 1000), p1 = now - Math.round((YEARS + 1.3) * 365.25 * 86400);
  const ndxRes = await history('^IXIC', `period1=${p1}&period2=${now}&interval=1d`); if (!ndxRes) throw new Error('no Nasdaq data');
  const ndx = clean(ndxRes);
  const Sx = []; let k = 0, errs = 0;
  const worker = async () => { while (k < list.length) { const r = list[k++]; const res = await history(r.name, `period1=${p1}&period2=${now}&interval=1d`);
    if (res?.timestamp) { const d = clean(res); if (d.c.length > 200) { d.idx = new Map(d.t.map((t, i) => [dstr(t), i])); d.S10 = sma(d.c, 10); Sx.push({ r, d }); } } else errs++;
    if (k % 250 === 0) console.log(k, 'fetched', Math.round((Date.now() - t0) / 1000) + 's'); await sleep(150); } };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log('have', Sx.length, 'stocks');
  for (const s of Sx) { const { h, l, c, v } = s.d, n = c.length; s.dv = new Array(n).fill(null); s.adr = new Array(n).fill(null); let dvs = 0, ads = 0;
    for (let i = 0; i < n; i++) { dvs += c[i] * v[i]; if (i >= 30) dvs -= c[i - 30] * v[i - 30]; ads += h[i] / l[i] - 1; if (i >= 20) ads -= h[i - 20] / l[i - 20] - 1;
      if (i >= 29) s.dv[i] = dvs / 30; if (i >= 19) s.adr[i] = ads / 20; } }
  const lowMin = (l, a, b) => { let m = Infinity; for (let i = a; i <= b; i++) if (l[i] < m) m = l[i]; return m; };
  const measures = { m1: (d, i) => d.c[i] / d.c[i - 21] - 1, m3: (d, i) => d.c[i] / d.c[i - 63] - 1, m6: (d, i) => d.c[i] / d.c[i - 126] - 1,
    l1: (d, i) => d.c[i] / lowMin(d.l, i - 21, i) - 1, l3: (d, i) => d.c[i] / lowMin(d.l, i - 66, i) - 1, l6: (d, i) => d.c[i] / lowMin(d.l, i - 125, i) - 1 };
  const startT = now - YEARS * 365.25 * 86400, hourlyStart = now - 725 * 86400;
  const days = ndx.t.map((t, i) => ({ t, i, ds: dstr(t) })).filter(x => x.t >= startT);
  const P = [], signals = []; const blockP = new Map();
  for (const D of days) {
    const ndxCut = slice(ndx, Math.max(0, D.i - 299), D.i + 1); const light = marketLight(ndxCut).light;
    const ndxMap = new Map(ndxCut.t.map((t, q) => [Math.floor(t / 86400), ndxCut.c[q]]));
    const U = [];
    for (const s of Sx) { const i = s.d.idx.get(D.ds); if (i == null || i < 140) continue; if (s.d.c[i - 1] < 1 || !(s.dv[i - 1] >= S.minDollarVol) || !(s.adr[i - 1] >= S.minADR)) continue; U.push({ s, i }); }
    const keep = Math.min(50, Math.max(10, Math.round(U.length * 0.07)));
    const pick = new Map();
    for (const [mk, f] of Object.entries(measures)) {             // ranks use YESTERDAY's close (known before the open)
      const top = U.map(u => ({ u, x: f(u.s.d, u.i - 1) })).filter(z => Number.isFinite(z.x)).sort((a, b) => b.x - a.x).slice(0, keep);
      for (const { u } of top) { const p = pick.get(u.s.r.name) || { u, scans: [] }; p.scans.push(mk); pick.set(u.s.r.name, p); }
    }
    const sec = {}; for (const { u } of pick.values()) sec[u.s.r.sector || 'Other'] = (sec[u.s.r.sector || 'Other'] || 0) + 1;
    const hot = Object.entries(sec).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
    const ctx = { ndx: ndxCut, ndxMap, hot };
    for (const { u, scans } of pick.values()) {
      const { s, i } = u, d = s.d;
      let x; try { x = analyze(slice(d, Math.max(0, i - 259), i + 1), { r: s.r, scans }, ctx, 1, { backtest: true, now: d.t[i] * 1000 }); } catch { x = null; }
      if (!x || x.st !== 'breakout' || d.o[i] > x.top * 1.10) continue;
      const prev = d.c[i - 1], meta = { t: s.r.name, date: D.ds, mkt: light, stars: x.stars, tight: x.tight, vr: x.vr, surf: x.surf, prior: x.prior, top: x.top, atr: x.atr };
      if (d.t[i] >= hourlyStart) signals.push({ s, i, meta });
      // ----- P: pessimistic daily -----
      if ((blockP.get(s.r.name) || '') >= D.ds) continue;
      const entry = Math.max(d.o[i], x.top + 0.01) * (1 + COST);
      if (entry - prev > x.atr) continue;                      // chased
      if (entry - d.l[i] > x.atr) continue;                  // stop wider than ATR
      const stop0 = Math.min(d.l[i], entry - 0.3 * x.atr);   // low of day, never tighter than 0.3 ATR
      let res;                                               // pessimistic: a close below entry counts as stopped out that day
      if (d.c[i] < entry) res = { pnl: stop0 * (1 - COST) - entry, exitK: i, why: 'closed below entry (assumed stopped)', open: false };
      else res = manage(d, i, entry, stop0, d.S10);
      const R = res.pnl / (entry - stop0);
      P.push({ ...meta, entry: r2(entry), stop: r2(stop0), R: r2(R), pct: r2(res.pnl / entry * 100), riskPct: (entry - stop0) / entry, exit: res.exitK != null ? dstr(d.t[res.exitK]) : null, why: res.why, days: (res.exitK ?? d.c.length - 1) - i });
      blockP.set(s.r.name, res.exitK != null ? dstr(d.t[res.exitK]) : '9999');
    }
  }
  console.log('P trades', P.length, 'hourly candidates', signals.length, Math.round((Date.now() - t0) / 1000) + 's');

  // ----- H: realistic hourly (last ~2 years) -----
  const H = []; const hourly = new Map(); const need = [...new Set(signals.map(x => x.s.r.name))]; let q = 0;
  const hw = async () => { while (q < need.length) { const sym = need[q++]; const res = await history(sym, 'range=730d&interval=60m'); if (res?.timestamp) hourly.set(sym, clean(res)); await sleep(150); } };
  await Promise.all(Array.from({ length: 6 }, hw));
  console.log('hourly series', hourly.size, 'of', need.length);
  const blockH = new Map();
  for (const sg of signals.sort((a, b) => a.meta.date.localeCompare(b.meta.date))) {
    const { s, i, meta } = sg, d = s.d, hb = hourly.get(meta.t); if (!hb) continue;
    if ((blockH.get(meta.t) || '') >= meta.date) continue;
    const idx = hb.t.map((t, k) => k).filter(k => dstr(hb.t[k] - 4 * 3600) === meta.date);   // that session's hourly bars (UTC-4 shift keeps one session)
    if (idx.length < 2) continue;
    const orh60 = hb.h[idx[0]], level = Math.max(meta.top + 0.01, orh60 + 0.01);
    let entry = null, eb = null;
    for (let z = 1; z < idx.length; z++) { const b = idx[z]; if (hb.h[b] >= level) { entry = Math.max(hb.o[b], level) * (1 + COST); eb = z; break; } }
    if (entry == null) continue;
    let lod = Infinity, cumV = 0; for (let z = 0; z <= eb; z++) { lod = Math.min(lod, hb.l[idx[z]]); cumV += hb.v[idx[z]]; }
    const prev = d.c[i - 1];
    if (entry - prev > meta.atr || entry - lod > meta.atr || entry <= lod) continue;
    const vAvg = d.v.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20, pace = cumV / (vAvg * Math.min(1, (eb + 1) / 6.5));
    let res = null;
    for (let z = eb + 1; z < idx.length; z++) if (hb.l[idx[z]] <= lod) { res = { pnl: lod * (1 - COST) - entry, exitK: i, why: 'stopped same day', open: false }; break; }
    if (!res) res = manage(d, i, entry, lod, d.S10);
    const R = res.pnl / (entry - lod);
    H.push({ ...meta, vr: r2(pace), entry: r2(entry), stop: r2(lod), entryHour: eb, R: r2(R), pct: r2(res.pnl / entry * 100), riskPct: (entry - lod) / entry, exit: res.exitK != null ? dstr(d.t[res.exitK]) : null, why: res.why, days: (res.exitK ?? d.c.length - 1) - i });
    blockH.set(meta.t, res.exitK != null ? dstr(d.t[res.exitK]) : '9999');
  }
  const pack = T => T.map(t => [t.t, t.date, t.entry, t.stop, t.R, t.pct, t.days, t.exit, t.why, t.mkt, t.stars, t.tight ? 1 : 0, t.vr, t.surf]);
  const out = { ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), years: YEARS, from: days[0]?.ds, to: days.at(-1)?.ds,
    stocks: Sx.length, fetchErrors: errs, hourlySeries: hourly.size,
    settings: { ...S, costPerSide: COST, riskPerTrade: RISK, cap: CAP },
    notes: ['Universe = stocks listed today (delisted stocks missing: survivorship bias, makes results look better).', 'No earnings filter (past earnings dates not available).',
      'P is pessimistic: stop = day low (min 0.3 ATR), and any breakout day that closes below the entry counts as a full -1R loss.', 'H uses 60-minute bars: 60-min ORH entry, low-of-day stop at entry time.',
      'Breakout volume in P uses the full day (unknown at entry); in H it is the pace up to the entry hour.'],
    P: groups(P), H: groups(H), cols: ['t', 'date', 'entry', 'stop', 'R', 'pct', 'days', 'exit', 'why', 'mkt', 'stars', 'tight', 'vr', 'surf'], tradesP: pack(P), tradesH: pack(H) };
  await writeFile('backtest.json', JSON.stringify(out));
  console.log('done', out.seconds + 's', 'P', JSON.stringify(out.P.all).slice(0, 300), 'H', JSON.stringify(out.H.all).slice(0, 300));
}
main().catch(e => { console.error(e); process.exit(1); });
