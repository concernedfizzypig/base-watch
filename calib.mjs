// CALIBRATION for the 2021-2026 daily backtest. Same v4 signals over the last ~2 years (where Yahoo has hourly bars),
// each traded four ways: daily-neutral, daily-pessimistic, hourly buy-at-trigger, hourly buy-above-60-min-high.
// Tells us which daily version matches what really happens intraday. Original header:
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
function portfolio(sigs, maxOpen = 20, risk = 0.005) {
  const days = [...new Set(sigs.map(s => s.date))].sort(); const byDay = new Map(); for (const s of sigs) (byDay.get(s.date) || byDay.set(s.date, []).get(s.date)).push(s);
  let eq = 1, peak = 1, dd = 0; const open = []; const yearly = {}; let taken = 0; const curve = [];
  const allDates = [...new Set([...sigs.map(s => s.date), ...sigs.map(s => s.exit).filter(Boolean)])].sort();
  for (const day of allDates) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exit && open[k].exit <= day) { const o = open[k]; eq += o.size * o.R; open.splice(k, 1); const y = day.slice(0, 4); yearly[y] = (yearly[y] || 0) + o.size * o.R; }
    peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
    const today = (byDay.get(day) || []).sort((a, b) => b.vr - a.vr);
    for (const s of today) { if (open.length >= maxOpen || open.some(o => o.t === s.t)) continue;
      const size = Math.min(risk, 0.25 * s.riskPct) * eq; open.push({ ...s, size }); taken++; }
    if (day.endsWith('-01') || day.endsWith('-15')) curve.push([day, r2(eq)]);
  }
  for (const o of open) eq += o.size * o.R;   // still-open trades marked at the last close
  return { trades: taken, finalEquity: r2(eq), totalReturnPct: r2((eq - 1) * 100), maxDrawdownPct: r2(dd * 100), yearlyR_inAccountUnits: Object.fromEntries(Object.entries(yearly).map(([y, v]) => [y, r2(v * 100) + '%'])), curve };
}


// hourly entry models on day i. mode 'trig' = buy the first hourly bar that trades above the trigger (incl. the first hour);
// 'orh60' = buy above max(trigger, first-hour high) from the second hour on. Stop = low of day so far (incl. the entry bar),
// stopped the same day if a later hour trades through it. Then the same daily exits.
function hourly(d, i, hb, trigger, atr, mode) {
  const ds = dstr(d.t[i]); const idx = []; for (let k = 0; k < hb.t.length; k++) if (dstr(hb.t[k] - 4 * 3600) === ds) idx.push(k);
  if (idx.length < 2) return null;
  const level = (mode === 'orh60' ? Math.max(trigger, hb.h[idx[0]]) : trigger) + 0.01; let eb = null, entry = null;
  for (let z = mode === 'orh60' ? 1 : 0; z < idx.length; z++) if (hb.h[idx[z]] >= level) { eb = z; entry = Math.max(hb.o[idx[z]], level) * (1 + COST); break; }
  if (eb == null) return null;
  let lod = Infinity; for (let z = 0; z <= eb; z++) lod = Math.min(lod, hb.l[idx[z]]);
  if (!(entry > lod) || entry - lod > atr) return null;
  let res = null;
  for (let z = eb + 1; z < idx.length; z++) if (hb.l[idx[z]] <= lod) { res = { pnl: Math.min(lod, hb.o[idx[z]]) * (1 - COST) - entry, exitK: i, why: 'stopped same day' }; break; }
  if (!res) res = manage(d, i, entry, lod, 3, 1 / 3);
  return { entry, stop: lod, R: res.pnl / (entry - lod), pct: res.pnl / entry * 100, riskPct: (entry - lod) / entry, exitK: res.exitK, why: res.why, days: (res.exitK ?? d.c.length - 1) - i };
}

async function main() {
  const t0 = Date.now(), now = Math.floor(Date.now() / 1000), hStart = now - 725 * 86400, p1 = hStart - 450 * 86400;
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
  const meas = [(d, i) => d.c[i] / d.c[i - 21] - 1, (d, i) => d.c[i] / d.c[i - 63] - 1, (d, i) => d.c[i] / d.c[i - 126] - 1,
    (d, i) => d.c[i] / mn(d.l, i - 21, i) - 1, (d, i) => d.c[i] / mn(d.l, i - 66, i) - 1, (d, i) => d.c[i] / mn(d.l, i - 125, i) - 1];
  const days = ndx.t.map((t, i) => ({ t, i, ds: dstr(t) })).filter(x => x.t >= hStart);
  const sigs = [];
  for (const D of days) {
    const light = marketLight({ c: ndx.c.slice(Math.max(0, D.i - 299), D.i + 1) }).light;
    const U = []; for (const s of Sx) { const i = s.d.idx.get(D.ds); if (i == null || i < 140) continue; const d = s.d;
      if (d.c[i - 1] < 1 || !(d.dv[i - 1] >= MIN_DV) || !(d.adr[i - 1] >= MIN_ADR)) continue; U.push({ s, i }); }
    const keep = Math.min(50, Math.max(10, Math.round(U.length * 0.07)));
    const pick = new Set(); for (const f of meas) U.map(u => ({ u, x: f(u.s.d, u.i - 1) })).filter(z => Number.isFinite(z.x)).sort((a, b) => b.x - a.x).slice(0, keep).forEach(z => pick.add(z.u));
    for (const { s, i } of pick) { const d = s.d; const x = detect4(d, i, d); if (x.fail || !(d.h[i] > x.top) || d.o[i] > x.top * 1.10) continue;
      sigs.push({ s, i, t: s.r.name, date: D.ds, mkt: light, top: x.top, vr: d.v[i] / d.v20[i] }); }
  }
  console.log('signals', sigs.length, Math.round((Date.now() - t0) / 1000) + 's');
  const need = [...new Set(sigs.map(z => z.t))]; const H = new Map(); let qn = 0;
  const hw = async () => { while (qn < need.length) { const sym = need[qn++]; const res = await history(sym, 'range=730d&interval=60m'); if (res?.timestamp) H.set(sym, clean(res)); if (qn % 300 === 0) console.log('hourly', qn, '/', need.length); await sleep(100); } };
  await Promise.all(Array.from({ length: 6 }, hw));
  const M = { dailyNeutral: [], dailyPess: [], hourlyTrigger: [], hourlyORH60: [] }; const both = [];
  for (const z of sigs) { const d = z.s.d, i = z.i, atr = d.atr[i], hb = H.get(z.t); if (!hb) continue;
    const r = { dailyNeutral: trade(d, i, z.top, atr, 'neutral'), dailyPess: trade(d, i, z.top, atr, 'pess'), hourlyTrigger: hourly(d, i, hb, z.top, atr, 'trig'), hourlyORH60: hourly(d, i, hb, z.top, atr, 'orh60') };
    const meta = { t: z.t, date: z.date, mkt: z.mkt, vr: z.vr };
    for (const [m, v] of Object.entries(r)) if (v) M[m].push({ ...meta, ...v, exit: v.exitK != null ? dstr(d.t[v.exitK]) : null });
    if (r.dailyNeutral && r.hourlyTrigger) both.push({ ...meta, dn: r.dailyNeutral, dp: r.dailyPess, ht: r.hourlyTrigger, ho: r.hourlyORH60 });
  }
  const split = dstr(hStart + 362 * 86400);
  const out = { ranAt: new Date().toISOString(), from: dstr(hStart), split, signals: sigs.length, hourlySeries: H.size, models: {} };
  for (const [m, A] of Object.entries(M)) { const T = oneAtATime(A), nr = T.filter(t => t.mkt !== 'red');
    out.models[m] = { all: stats(T), notRed: stats(nr), notRed_firstYear: stats(nr.filter(t => t.date < split)), notRed_secondYear: stats(nr.filter(t => t.date >= split)) }; }
  // same signal, side by side: where does the daily model differ from the hourly one?
  const pairs = both.filter(b => b.mkt !== 'red');
  const mean = f => r2(pairs.reduce((a, b) => a + f(b), 0) / Math.max(1, pairs.length));
  out.sameSignal_notRed = { n: pairs.length, dailyNeutralR: mean(b => b.dn.R), dailyPessR: mean(b => b.dp ? b.dp.R : -1), hourlyTriggerR: mean(b => b.ht.R), hourlyORH60R: mean(b => b.ho ? b.ho.R : 0),
    entryDiffPct: mean(b => (b.ht.entry / b.dn.entry - 1) * 100), riskDailyPct: mean(b => b.dn.riskPct * 100), riskHourlyPct: mean(b => b.ht.riskPct * 100),
    dailyNeutralPct: mean(b => b.dn.pct), hourlyTriggerPct: mean(b => b.ht.pct),
    hourlyStoppedSameDay: r2(pairs.filter(b => b.ht.why === 'stopped same day').length / Math.max(1, pairs.length)),
    dailyClosedBelowEntry: r2(pairs.filter(b => b.dp && b.dp.why === 'closed below entry').length / Math.max(1, pairs.length)) };
  out.seconds = Math.round((Date.now() - t0) / 1000);
  await writeFile('calib.json', JSON.stringify(out));
  console.log('done', out.seconds + 's', JSON.stringify(out.sameSignal_notRed));
}
main().catch(e => { console.error(e); process.exit(1); });
