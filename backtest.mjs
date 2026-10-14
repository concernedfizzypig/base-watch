// Base Watch backtest: replays the last ~2 years day by day using the SAME analyze() rules as scan.mjs,
// then manages every breakout with the tracker rules (stop = day low; day 3 sell half + stop to break-even;
// rest on first close below the 10-day SMA). Writes backtest.json. Run with: node backtest.mjs
import { writeFile } from 'node:fs/promises';
import { analyze } from './scan.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const YEARS = Number(process.env.BT_YEARS || 2);
const MIN_DOLLAR_VOL = Number(process.env.MIN_DOLLAR_VOL || 5_000_000);
const MIN_ADR = Number(process.env.MIN_ADR || 0.04);
const FETCH_MIN_DV = Number(process.env.FETCH_MIN_DV || 2_000_000); // today's liquidity needed to be downloaded at all
const RISK = 0.005;      // 0.5% of account risked per trade (for the account % figures)
const CAP = 0.25;        // max 25% of account in one stock

// ---------- data ----------
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
let errors = 0;
async function history(sym, range) {
  const y = sym.replace(/\./g, '-');
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(`https://${a % 2 ? 'query2' : 'query1'}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=${range}&interval=1d`, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (r.ok) { const j = await r.json(); return j.chart?.result?.[0] || null; }
      if (r.status === 404) return null;
    } catch {}
    await sleep(3000 * (a + 1));
  }
  errors++; return null;
}
function clean(res) {
  const t = res.timestamp || [], q = res.indicators?.quote?.[0] || {}; const k = [];
  for (let i = 0; i < t.length; i++) if (q.close?.[i] != null && q.high?.[i] != null && q.low?.[i] != null && q.open?.[i] != null && q.low[i] > 0) k.push(i);
  const f = a => k.map(i => a[i]);
  return { t: f(t), o: f(q.open), h: f(q.high), l: f(q.low), c: f(q.close), v: f(q.volume || []).map(x => x || 0) };
}

// ---------- helpers (same as scan.mjs) ----------
const sma = (a, n) => a.map((_, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; });
const r2 = x => x == null ? null : Math.round(x * 100) / 100;
const dstr = t => new Date(t * 1000).toISOString().slice(0, 10);
const slice = (d, a, b) => ({ t: d.t.slice(a, b), o: d.o.slice(a, b), h: d.h.slice(a, b), l: d.l.slice(a, b), c: d.c.slice(a, b), v: d.v.slice(a, b) });
function marketLight(d) {
  const i = d.c.length - 1, s10 = sma(d.c, 10), s20 = sma(d.c, 20);
  const up10 = s10[i] > s10[i - 3], up20 = s20[i] > s20[i - 3], above = s10[i] > s20[i];
  return up10 && up20 && above ? 'green' : (above && (up10 || up20)) ? 'yellow' : 'red';
}
function simulate(tr, d) {               // identical to the tracker in scan.mjs
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
      ev.push({ d: dates[k], what: 'Sold half (day 3)', px: r2(d.c[k]) }); continue; }
    if (half && S10[k] != null && d.c[k] < S10[k]) { exitAll(d.c[k], k, 'Closed below 10-day SMA'); break; }
  }
  const last = d.c.at(-1), pnl = realized + left * (last - tr.entry);
  return { ...tr, status: left > 0 ? 'open' : 'closed', rMult: R > 0 ? Math.round(pnl / R * 100) / 100 : null,
    pct: Math.round(pnl / tr.entry * 10000) / 100, days: (left > 0 ? d.c.length - 1 : dates.indexOf(ev.at(-1).d)) - e,
    exitDate: left > 0 ? null : ev.at(-1).d, exitWhy: left > 0 ? 'still open' : ev.at(-1).what };
}

// ---------- stats ----------
function stats(trades) {
  const T = trades.filter(t => t.rMult != null), n = T.length;
  if (!n) return { n: 0 };
  const R = T.map(t => t.rMult).sort((a, b) => a - b), sum = R.reduce((a, b) => a + b, 0);
  // account % if each trade risks 0.5% of a fixed account, position capped at 25% (simple, not compounded)
  const acct = T.reduce((a, t) => { const riskFrac = Math.min(RISK, CAP * (t.entry - t.stop0) / t.entry); return a + t.rMult * riskFrac; }, 0);
  // drawdown in R, trades ordered by exit (open trades at the end)
  const byExit = [...T].sort((a, b) => (a.exitDate || '9999') .localeCompare(b.exitDate || '9999'));
  let cum = 0, peak = 0, dd = 0; for (const t of byExit) { cum += t.rMult; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  // most positions open at once
  const ev = []; for (const t of T) { ev.push([t.entryDate, 1]); ev.push([t.exitDate || '9999', -1]); }
  ev.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]); let o = 0, maxOpen = 0; for (const [, x] of ev) { o += x; maxOpen = Math.max(maxOpen, o); }
  const year = {}; for (const t of T) { const y = t.entryDate.slice(0, 7); const q = y.slice(0, 4) + '-Q' + (Math.floor((+y.slice(5) - 1) / 3) + 1); year[q] = year[q] || { n: 0, R: 0, wins: 0 }; year[q].n++; year[q].R += t.rMult; if (t.rMult > 0) year[q].wins++; }
  for (const q in year) year[q].R = r2(year[q].R);
  return { n, wins: T.filter(t => t.rMult > 0).length, winRate: r2(T.filter(t => t.rMult > 0).length / n), bigWins5R: T.filter(t => t.rMult >= 5).length,
    fullLosses: T.filter(t => t.rMult <= -0.9).length, avgR: r2(sum / n), medianR: R[Math.floor(n / 2)], totalR: r2(sum), bestR: R.at(-1), worstR: R[0],
    avgPct: r2(T.reduce((a, t) => a + t.pct, 0) / n), avgDaysWin: r2(avgOf(T.filter(t => t.rMult > 0).map(t => t.days))), avgDaysLoss: r2(avgOf(T.filter(t => t.rMult <= 0).map(t => t.days))),
    acctPct: r2(acct * 100), maxDrawdownR: r2(dd), maxOpen, open: T.filter(t => t.status === 'open').length, byQuarter: year };
}
const avgOf = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

// ---------- run ----------
async function main() {
  const t0 = Date.now();
  const list = await tvList(); console.log('downloading', list.length, 'stocks');
  const ndxRes = await history('^IXIC', '5y'); if (!ndxRes) throw new Error('no Nasdaq data');
  const ndx = clean(ndxRes);
  const range = YEARS <= 2 ? '3y' : '5y';
  const S = []; let k = 0;
  const worker = async () => { while (k < list.length) { const r = list[k++]; const res = await history(r.name, range);
    if (res?.timestamp) { const d = clean(res); if (d.c.length > 150) { d.idx = new Map(d.t.map((t, i) => [dstr(t), i])); S.push({ r, d }); } }
    if (k % 250 === 0) console.log(k, 'fetched', Math.round((Date.now() - t0) / 1000) + 's'); await sleep(200); } };
  await Promise.all(Array.from({ length: 5 }, worker));
  console.log('have', S.length, 'stocks, errors', errors);

  // precompute per-stock rolling filters + momentum measures
  for (const s of S) {
    const { h, l, c, v } = s.d, n = c.length; s.dv = new Array(n).fill(null); s.adr = new Array(n).fill(null);
    let dvs = 0, ads = 0;
    for (let i = 0; i < n; i++) {
      dvs += c[i] * v[i]; if (i >= 30) dvs -= c[i - 30] * v[i - 30];
      ads += h[i] / l[i] - 1; if (i >= 20) ads -= h[i - 20] / l[i - 20] - 1;
      if (i >= 29) s.dv[i] = dvs / 30; if (i >= 19) s.adr[i] = ads / 20;
    }
  }
  const lowMin = (l, s, e) => { let m = Infinity; for (let i = s; i <= e; i++) if (l[i] < m) m = l[i]; return m; };
  const measures = { m1: (d, i) => d.c[i] / d.c[i - 21] - 1, m3: (d, i) => d.c[i] / d.c[i - 63] - 1, m6: (d, i) => d.c[i] / d.c[i - 126] - 1,
    l1: (d, i) => d.c[i] / lowMin(d.l, i - 21, i) - 1, l3: (d, i) => d.c[i] / lowMin(d.l, i - 66, i) - 1, l6: (d, i) => d.c[i] / lowMin(d.l, i - 125, i) - 1 };

  const startT = Date.now() / 1000 - YEARS * 365.25 * 86400;
  const days = ndx.t.map((t, i) => ({ t, i, ds: dstr(t) })).filter(x => x.t >= startT);
  const blockedUntil = { A: new Map(), B: new Map() };
  const trades = { A: [], B: [] }; let signalsSeen = 0, candDays = 0;
  for (const D of days) {
    const ndxCut = slice(ndx, Math.max(0, D.i - 299), D.i + 1); const light = marketLight(ndxCut);
    const U = [];
    for (const s of S) { const i = s.d.idx.get(D.ds); if (i == null || i < 130) continue;
      if (s.d.c[i] < 1 || !(s.dv[i] >= MIN_DOLLAR_VOL) || !(s.adr[i] >= MIN_ADR)) continue; U.push({ s, i }); }
    const keep = Math.min(50, Math.max(10, Math.round(U.length * 0.07)));
    const pick = new Map();
    for (const [mk, f] of Object.entries(measures)) {
      const top = U.map(u => ({ u, x: f(u.s.d, u.i) })).filter(z => Number.isFinite(z.x)).sort((a, b) => b.x - a.x).slice(0, keep);
      for (const { u } of top) { const p = pick.get(u.s.r.name) || { u, scans: [] }; p.scans.push(mk); pick.set(u.s.r.name, p); }
    }
    const sec = {}; for (const { u } of pick.values()) sec[u.s.r.sector || 'Other'] = (sec[u.s.r.sector || 'Other'] || 0) + 1;
    const hot = Object.entries(sec).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
    const ctx = { ndx: ndxCut, hot };
    for (const { u, scans } of pick.values()) {
      candDays++;
      const { s, i } = u, d = s.d; const cut = slice(d, Math.max(0, i - 249), i + 1);
      let x; try { x = analyze(cut, { r: s.r, scans }, ctx, 1); } catch { x = null; } if (!x) continue;
      const prev = d.c[i - 1], atr = x.atr, base = { t: s.r.name, entryDate: D.ds, stars: x.stars, surf: x.surf, market: light, top: x.top, mc: Math.round((s.r.market_cap_basic || 0) / 1e6) };
      // A: what the 21:30 after-close scan shows - closed above the base top; "bought" at the close, stop = day low
      if (x.st === 'breakout') {
        signalsSeen++;
        if (!((blockedUntil.A.get(s.r.name) || '') >= D.ds) && x.stop > 0 && x.p > x.stop) {
          const tr = simulate({ ...base, entry: x.p, stop0: x.stop, chased: x.chased, wide: x.stopTooWide }, d);
          tr.rules = !tr.chased && !tr.wide && light !== 'red'; trades.A.push(tr); blockedUntil.A.set(s.r.name, tr.exitDate || '9999');
        }
      }
      // B: buy-stop at the base top during the day (how you would trade it): traded above the top today
      if (d.h[i] > x.top && d.o[i] <= x.top * 1.10) {
        const entry = Math.max(d.o[i], x.top + 0.01), stop0 = d.l[i];
        if (!((blockedUntil.B.get(s.r.name) || '') >= D.ds) && entry > stop0) {
          const tr = simulate({ ...base, entry: r2(entry), stop0: r2(stop0), chased: entry - prev > atr, wide: entry - stop0 > atr, closedAbove: d.c[i] > x.top }, d);
          tr.rules = !tr.chased && !tr.wide && light !== 'red'; trades.B.push(tr); blockedUntil.B.set(s.r.name, tr.exitDate || '9999');
        }
      }
    }
  }
  const pack = arr => arr.map(t => [t.t, t.entryDate, t.entry, t.stop0, t.rMult, t.pct, t.days, t.exitDate, t.exitWhy, t.market, t.rules ? 1 : 0, t.chased ? 1 : 0, t.wide ? 1 : 0, t.stars, t.surf, t.mc]);
  const out = {
    ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), from: days[0]?.ds, to: days.at(-1)?.ds, tradingDays: days.length,
    stocksDownloaded: S.length, yahooErrors: errors, candidateDays: candDays,
    settings: { minDollarVol: MIN_DOLLAR_VOL, minADR: MIN_ADR, fetchMinDV: FETCH_MIN_DV, riskPerTrade: RISK, cap: CAP },
    notes: ['Universe = stocks listed today (delisted stocks missing: survivorship bias).', 'No earnings filter (past earnings dates not available).',
      'Daily bars: stop = full day low, order of moves inside a day unknown.', 'No commissions or slippage.'],
    stats: { A_all: stats(trades.A), A_rules: stats(trades.A.filter(t => t.rules)), B_all: stats(trades.B), B_rules: stats(trades.B.filter(t => t.rules)),
      B_rules_green: stats(trades.B.filter(t => t.rules && t.market === 'green')), B_rules_4stars: stats(trades.B.filter(t => t.rules && t.stars >= 4)) },
    cols: ['t', 'entryDate', 'entry', 'stop', 'R', 'pct', 'days', 'exitDate', 'exitWhy', 'market', 'rules', 'chased', 'wide', 'stars', 'surf', 'mcapM'],
    A: pack(trades.A), B: pack(trades.B),
  };
  await writeFile('backtest.json', JSON.stringify(out));
  console.log('done', out.seconds + 's', JSON.stringify(out.stats.B_rules).slice(0, 400));
}
main().catch(e => { console.error(e); process.exit(1); });
