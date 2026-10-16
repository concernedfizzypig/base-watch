// Base Watch 2021-2026 backtest of the live v4 setups (daily bars; Yahoo has hourly bars for the last 2 years only).
// Entry: buy when the day's high crosses the trigger, at max(open, trigger). Stop: low of the breakout day, must be within 1 ATR.
// Exit (his rule as you described it): sell 1/3 at the close of day 3, stop to break-even, sell the rest on the first close
// below the 10-day. Gap through a stop = filled at the open. 0.1% cost each side.
// Two versions of the breakout day: NEUTRAL (stop is the day's low, so it can't be hit that day) and PESSIMISTIC (if the
// breakout day closes below the entry, count a full -1R loss that day). The truth is between the two.
// Also: a plain "any 20-day-high breakout" baseline with the same exits (does the setup filter add anything?) and a
// portfolio run (max 20 positions, 0.5% risk each) so the account result is something one person could actually trade.
import { writeFile } from 'node:fs/promises';
import { history, clean, sma, dstr, marketLight } from './scan.mjs';
import { detect4 } from './setup4.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const START = process.env.BT_START || '2021-01-01', COST = 0.001, MIN_DV = 10e6, MIN_ADR = 0.04;
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const mx = (a, s, e) => { let m = -Infinity; for (let i = s; i <= e; i++) if (a[i] > m) m = a[i]; return m; };
const mn = (a, s, e) => { let m = Infinity; for (let i = s; i <= e; i++) if (a[i] < m) m = a[i]; return m; };
const avg = (a, s, e) => { let x = 0; for (let i = s; i <= e; i++) x += a[i]; return x / (e - s + 1); };

async function tvList() {
  const cols = ['name', 'close', 'average_volume_30d_calc', 'sector'];
  const r = await fetch('https://scanner.tradingview.com/america/scan', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://www.tradingview.com', referer: 'https://www.tradingview.com/', 'user-agent': UA },
    body: JSON.stringify({ filter: [{ left: 'type', operation: 'in_range', right: ['stock', 'dr'] }, { left: 'exchange', operation: 'in_range', right: ['NASDAQ', 'NYSE', 'AMEX'] },
      { left: 'close', operation: 'greater', right: 1 }], markets: ['america'], columns: cols, range: [0, 12000] }) });
  if (!r.ok) throw new Error('TradingView ' + r.status);
  return (await r.json()).data.map(x => Object.fromEntries(cols.map((c, i) => [c, x.d[i]]))).filter(r => r.close * r.average_volume_30d_calc >= 3e6);
}

// trade management after entry on bar e. thirdDay = bar count after which 1/3 is sold. Returns pnl per share and exit bar.
function manage(d, e, entry, stop0, thirdDay, frac) {
  let stop = stop0, left = 1, realized = 0, sold = false, exitK = null, why = 'open';
  const out = (px, k, w) => { realized += left * (px * (1 - COST) - entry); left = 0; exitK = k; why = w; };
  for (let k = e + 1; k < d.c.length && left > 0; k++) {
    if (d.o[k] <= stop) { out(d.o[k], k, sold ? 'break-even (gap)' : 'stop (gap)'); break; }
    if (d.l[k] <= stop) { out(stop, k, sold ? 'break-even' : 'stop'); break; }
    if (!sold && k - e >= thirdDay) { realized += frac * (d.c[k] * (1 - COST) - entry); left = 1 - frac; sold = true; stop = Math.max(stop, entry); }
    if (sold && d.c[k] < d.S10[k]) { out(d.c[k], k, '10-day'); break; }
  }
  return { pnl: realized + left * (d.c.at(-1) * (1 - COST) - entry), exitK, why, open: left > 0 };
}
function trade(d, i, trigger, atr, mode, thirdDay = 3, frac = 1 / 3) {
  if (d.o[i] > trigger * 1.10) return null;                       // gapped >10% over the trigger: that is an EP, not this setup
  const entry = Math.max(d.o[i], trigger + 0.01) * (1 + COST), stop = d.l[i];
  if (!(entry > stop) || entry - stop > atr) return null;        // his rule: low-of-day stop no wider than 1 ATR
  let res;
  if (mode === 'pess' && d.c[i] < entry) res = { pnl: stop * (1 - COST) - entry, exitK: i, why: 'closed below entry' };
  else res = manage(d, i, entry, stop, thirdDay, frac);
  const R = res.pnl / (entry - stop);
  return { entry, stop, R, pct: res.pnl / entry * 100, riskPct: (entry - stop) / entry, exitK: res.exitK, why: res.why, days: (res.exitK ?? d.c.length - 1) - i, open: !!res.open };
}

function stats(T) {
  const n = T.length; if (!n) return { n: 0 };
  const W = T.filter(t => t.R > 0), L = T.filter(t => t.R <= 0), sum = T.reduce((a, t) => a + t.R, 0);
  const sorted = [...T].sort((a, b) => b.R - a.R), top10 = sorted.slice(0, Math.max(1, Math.round(n * 0.1))).reduce((a, t) => a + t.R, 0);
  const why = {}; for (const t of T) why[t.why] = (why[t.why] || 0) + 1;
  const gw = W.reduce((a, t) => a + t.R, 0), gl = -L.reduce((a, t) => a + t.R, 0);
  return { n, win: r2(W.length / n), avgR: r2(sum / n), totR: Math.round(sum), avgWinR: r2(gw / Math.max(1, W.length)), avgLossR: r2(-gl / Math.max(1, L.length)),
    profitFactor: r2(gw / Math.max(1e-9, gl)), big5: T.filter(t => t.R >= 5).length, big10: T.filter(t => t.R >= 10).length, top10pctShareOfR: r2(top10 / sum),
    avgPct: r2(T.reduce((a, t) => a + t.pct, 0) / n), medDays: [...T].map(t => t.days).sort((a, b) => a - b)[Math.floor(n / 2)], exits: why };
}
const byKey = (T, f) => { const o = {}; for (const t of T) (o[f(t)] = o[f(t)] || []).push(t); return Object.fromEntries(Object.entries(o).sort().map(([k, A]) => [k, stats(A)])); };
// one open trade per stock; a new signal on a stock is taken only after the previous trade on it has exited
function oneAtATime(sigs) { const busy = new Map(), T = [];
  for (const s of [...sigs].sort((a, b) => a.date.localeCompare(b.date))) { const b = busy.get(s.t); if (b && s.date <= b) continue; T.push(s); busy.set(s.t, s.exit || '9999'); }
  return T; }
// portfolio: max open positions, risk % of current equity per trade (position capped at 25% of equity), same-day ties by volume
function portfolio(sigs, maxOpen = 20, risk = 0.005, eqw = 0) {   // eqw > 0: fixed position size (fraction of the starting account) instead of risk sizing
  const days = [...new Set(sigs.map(s => s.date))].sort(); const byDay = new Map(); for (const s of sigs) (byDay.get(s.date) || byDay.set(s.date, []).get(s.date)).push(s);
  let eq = 1, peak = 1, dd = 0; const open = []; const yearly = {}; let taken = 0; const curve = [];
  const allDates = [...new Set([...sigs.map(s => s.date), ...sigs.map(s => s.exit).filter(Boolean)])].sort();
  for (const day of allDates) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exit && open[k].exit <= day) { const o = open[k]; eq += o.size * o.R; open.splice(k, 1); const y = day.slice(0, 4); yearly[y] = (yearly[y] || 0) + o.size * o.R; }
    peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
    const today = (byDay.get(day) || []).sort((a, b) => b.vr - a.vr);
    for (const s of today) { if (open.length >= maxOpen || open.some(o => o.t === s.t)) continue;
      const size = eqw ? eqw * s.riskPct : Math.min(risk, 0.25 * s.riskPct); open.push({ ...s, size }); taken++; }   // no compounding: sized off the starting account
    if (day.endsWith('-01') || day.endsWith('-15')) curve.push([day, r2(eq)]);
  }
  for (const o of open) eq += o.size * o.R;   // still-open trades marked at the last close
  return { trades: taken, finalEquity: r2(eq), totalReturnPct: r2((eq - 1) * 100), maxDrawdownPct: r2(dd * 100), yearlyR_inAccountUnits: Object.fromEntries(Object.entries(yearly).map(([y, v]) => [y, r2(v * 100) + '%'])), curve };
}

async function main() {
  const t0 = Date.now(), now = Math.floor(Date.now() / 1000), p1 = Math.floor(Date.parse(START) / 1000) - 420 * 86400;
  const q = `period1=${p1}&period2=${now}&interval=1d`;
  const list = await tvList(); console.log('stocks', list.length);
  const ndx = clean(await history('^IXIC', q));
  const Sx = []; let k = 0;
  const w = async () => { while (k < list.length) { const r = list[k++]; const res = await history(r.name, q);
    if (res?.timestamp) { const d = clean(res); if (d.c.length > 200) Sx.push({ r, d }); } if (k % 500 === 0) console.log(k, Math.round((Date.now() - t0) / 1000) + 's'); await sleep(100); } };
  await Promise.all(Array.from({ length: 6 }, w));
  for (const { d } of Sx) {
    const n = d.c.length; d.idx = new Map(d.t.map((t, i) => [dstr(t), i])); d.S10 = sma(d.c, 10); d.S20 = sma(d.c, 20); d.S50 = sma(d.c, 50);
    const tr = d.c.map((c, k) => k ? Math.max(d.h[k] - d.l[k], Math.abs(d.h[k] - d.c[k - 1]), Math.abs(d.l[k] - d.c[k - 1])) : d.h[k] - d.l[k]);
    d.atr = new Array(n).fill(null); d.adr = new Array(n).fill(null); d.dv = new Array(n).fill(null); d.v20 = new Array(n).fill(null);
    for (let i = 30; i < n; i++) { d.atr[i] = avg(tr, i - 14, i - 1); let a = 0; for (let z = i - 19; z <= i; z++) a += d.h[z] / d.l[z] - 1; d.adr[i] = a / 20;
      let s = 0; for (let z = i - 29; z <= i; z++) s += d.c[z] * d.v[z]; d.dv[i] = s / 30; d.v20[i] = avg(d.v, i - 20, i - 1); }
  }
  console.log('prepared', Sx.length, Math.round((Date.now() - t0) / 1000) + 's');
  const meas = [(d, i) => d.c[i] / d.c[i - 21] - 1, (d, i) => d.c[i] / d.c[i - 63] - 1, (d, i) => d.c[i] / d.c[i - 126] - 1,
    (d, i) => d.c[i] / mn(d.l, i - 21, i) - 1, (d, i) => d.c[i] / mn(d.l, i - 66, i) - 1, (d, i) => d.c[i] / mn(d.l, i - 125, i) - 1];
  const days = ndx.t.map((t, i) => ({ t, i, ds: dstr(t) })).filter(x => x.ds >= START);
  const V = { neutral: [], pess: [], day2: [], half5: [], base20: [] }; const lights = {};
  const funnel = { days: 0, picks: 0, setups: 0, breakouts: 0, tooWide: 0, bigGap: 0 };
  for (const D of days) {
    const light = marketLight({ c: ndx.c.slice(Math.max(0, D.i - 299), D.i + 1) }).light; lights[light] = (lights[light] || 0) + 1;
    const U = []; for (const s of Sx) { const i = s.d.idx.get(D.ds); if (i == null || i < 140) continue; const d = s.d;
      if (d.c[i - 1] < 1 || !(d.dv[i - 1] >= MIN_DV) || !(d.adr[i - 1] >= MIN_ADR)) continue; U.push({ s, i }); }
    const keep = Math.min(50, Math.max(10, Math.round(U.length * 0.07)));
    const pick = new Set(); for (const f of meas) U.map(u => ({ u, x: f(u.s.d, u.i - 1) })).filter(z => Number.isFinite(z.x)).sort((a, b) => b.x - a.x).slice(0, keep).forEach(z => pick.add(z.u));
    funnel.days++;
    for (const { s, i } of pick) { const d = s.d; funnel.picks++;
      const meta = { t: s.r.name, date: D.ds, mkt: light, vr: d.v[i] / d.v20[i], year: D.ds.slice(0, 4) };
      // baseline: any break of the 20-day high, same entry/stop/exit rules
      const hi20 = mx(d.h, i - 20, i - 1); if (d.h[i] > hi20) { const b = trade(d, i, hi20, d.atr[i], 'neutral'); if (b) V.base20.push({ ...meta, ...b, exit: b.exitK != null ? dstr(d.t[b.exitK]) : null }); }
      const x = detect4(d, i, d); if (x.fail) continue; funnel.setups++;
      if (!(d.h[i] > x.top)) continue; funnel.breakouts++;
      if (d.o[i] > x.top * 1.10) { funnel.bigGap++; continue; }
      const extra = { surf: x.surf, L: x.L, tight: x.tight, prior: x.prior, depthADR: x.depth / x.adr };
      for (const [vn, mode, td, fr] of [['neutral', 'neutral', 3, 1 / 3], ['pess', 'pess', 3, 1 / 3], ['day2', 'neutral', 2, 1 / 3], ['half5', 'neutral', 5, 0.5]]) {
        const tr = trade(d, i, x.top, d.atr[i], mode, td, fr); if (!tr) { if (vn === 'neutral') funnel.tooWide++; continue; }
        V[vn].push({ ...meta, ...extra, ...tr, exit: tr.exitK != null ? dstr(d.t[tr.exitK]) : null }); }
    }
  }
  console.log('signals', Object.fromEntries(Object.entries(V).map(([k, v]) => [k, v.length])), Math.round((Date.now() - t0) / 1000) + 's');
  const out = { ranAt: new Date().toISOString(), start: START, stocks: Sx.length, marketDays: lights, funnel: { ...funnel, setupsPerDay: r2(funnel.setups / funnel.days), breakoutsPerDay: r2(funnel.breakouts / funnel.days) }, results: {} };
  for (const [vn, sigs] of Object.entries(V)) {
    const T = oneAtATime(sigs), notRed = T.filter(t => t.mkt !== 'red');
    out.results[vn] = { all: stats(T), byYear: byKey(T, t => t.year), byMarket: byKey(T, t => t.mkt),
      notRed: { all: stats(notRed), byYear: byKey(notRed, t => t.year) },
      portfolio_notRed_max20: portfolio(notRed, 20, 0.005), portfolio_all_max20: portfolio(T, 20, 0.005), portfolio_notRed_10pctEach_max10: portfolio(notRed, 10, 0, 0.10) };
    if (vn === 'neutral') {
      out.results[vn].bySurf = byKey(notRed, t => 'surf' + t.surf);
      out.results[vn].byBaseLen = byKey(notRed, t => t.L <= 7 ? 'L03-07' : t.L <= 15 ? 'L08-15' : 'L16-40');
      out.results[vn].byTight = byKey(notRed, t => 'tight_' + t.tight);
      out.results[vn].byVolume = byKey(notRed, t => t.vr < 1 ? 'v<1' : t.vr < 1.5 ? 'v1-1.5' : t.vr < 2.5 ? 'v1.5-2.5' : 'v2.5+');
      out.results[vn].byPrior = byKey(notRed, t => t.prior < 0.6 ? 'prior<60%' : t.prior < 1 ? 'prior60-100%' : 'prior100%+');
      out.results[vn].byRisk = byKey(notRed, t => t.riskPct < 0.03 ? 'risk<3%' : t.riskPct < 0.06 ? 'risk3-6%' : 'risk6%+');
      out.results[vn].top20 = [...notRed].sort((a, b) => b.R - a.R).slice(0, 20).map(t => [t.t, t.date, r2(t.R), r2(t.pct), t.days]);
      out.results[vn].sample = notRed.filter((_, z) => z % 25 === 0).slice(0, 80).map(t => [t.t, t.date, r2(t.entry), r2(t.stop), r2(t.R), t.why, t.days]);
    }
  }
  out.seconds = Math.round((Date.now() - t0) / 1000);
  out.notes = ['Daily bars only (Yahoo keeps hourly for 2 years). Neutral and pessimistic bracket the real breakout-day result.',
    'Survivorship bias: only stocks listed today are tested; stocks that died since 2021 are missing (flatters results).',
    'One trade per stock at a time; all signals counted in "all"; the portfolio run caps at 20 open positions.'];
  await writeFile('bt5.json', JSON.stringify(out));
  console.log('done', out.seconds + 's');
}
main().catch(e => { console.error(e); process.exit(1); });
