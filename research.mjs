// Base Watch research run. Answers: which rule kills most setups (funnel), what happens when each rule is loosened,
// does his episodic pivot (EP) setup add trades and profit, and do re-entries help. Writes research.json.
// H = last ~2 years, hourly bars, realistic: buy above max(trigger, 60-min opening range high), stop = low of day so far,
//     stopped if a later hour that day touches it, 0.1% cost each side.
// P = 5 years daily, pessimistic: buy at the trigger (or open if gapped above), stop = day low (min 0.3 ATR), a close below
//     entry that day counts as a full loss. Volume in P is the full day (look-ahead), so P is only used to compare rules.
// Train = first half of each window, Test = second half (to check a rule that wins in train still wins out of sample).
import { writeFile } from 'node:fs/promises';
import { history, clean, sma, r2, dstr, marketLight } from './scan.mjs';
import { detect4 } from './setup4.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const YEARS = Number(process.env.BT_YEARS || 5), COST = 0.001, RISK = 0.005, CAP = 0.25, MIN_DV = 10e6, MIN_ADR = 0.04;
const mx = (a, s, e) => { let m = -Infinity; for (let i = s; i <= e; i++) if (a[i] > m) m = a[i]; return m; };
const mn = (a, s, e) => { let m = Infinity; for (let i = s; i <= e; i++) if (a[i] < m) m = a[i]; return m; };
const avg = (a, s, e) => { let x = 0; for (let i = s; i <= e; i++) x += a[i]; return x / (e - s + 1); };

async function tvList() {
  const cols = ['name', 'description', 'close', 'market_cap_basic', 'sector', 'industry', 'average_volume_30d_calc'];
  const r = await fetch('https://scanner.tradingview.com/america/scan', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://www.tradingview.com', referer: 'https://www.tradingview.com/', 'user-agent': UA },
    body: JSON.stringify({ filter: [{ left: 'type', operation: 'in_range', right: ['stock', 'dr'] }, { left: 'exchange', operation: 'in_range', right: ['NASDAQ', 'NYSE', 'AMEX'] },
      { left: 'close', operation: 'greater', right: 1 }], markets: ['america'], columns: cols, range: [0, 12000] }) });
  if (!r.ok) throw new Error('TradingView ' + r.status);
  return (await r.json()).data.map(x => Object.fromEntries(cols.map((c, i) => [c, x.d[i]]))).filter(r => r.close * r.average_volume_30d_calc >= 3e6);
}

// per stock-day setup metrics. Two base searches: strict (exactly the live v3 rules) and relaxed (loosest values tested).
function setup(d, i, P) {
  const j = i - 1, { S10, S20, S50, atr, adr } = P;
  if (!(adr[j] >= MIN_ADR)) return { fail: 'adr' };
  const rising = { 10: S10[j] > S10[j - 5], 20: S20[j] > S20[j - 5], 50: S50[j] > S50[j - 5] };
  if (!(rising[20] && rising[50])) return { fail: 'trend' };
  const a = adr[j], ext10 = d.c[j] / S10[j] - 1, hi120 = mx(d.h, Math.max(0, i - 120), j);
  const search = (prior0, depth0, depthBig, drift0, needHL) => { let best = null;
    for (let L = 5; L <= 60; L++) { const s = i - L; if (s < 130) break;
      const top = mx(d.h, s, j), bot = mn(d.l, s, j), depth = (top - bot) / top, prior = top / mn(d.l, Math.max(0, s - 126), s) - 1;
      if (prior < prior0 || depth > (prior >= 1 ? depthBig : depth0) || top < 0.85 * hi120) continue;
      const drift = Math.abs(d.c[j] / d.c[s] - 1); if (drift > drift0) continue;
      const hf = Math.floor(L / 2);
      if (mx(d.h, s + hf, j) - mn(d.l, s + hf, j) > mx(d.h, s, s + hf - 1) - mn(d.l, s, s + hf - 1)) continue;
      const hl = mn(d.l, s + hf, j) >= mn(d.l, s, s + hf - 1); if (needHL && !hl) continue;
      best = { L, s, top, bot, depth, prior, drift, hl }; }
    return best; };
  const strict = search(0.30, 0.30, 0.40, 0.12, true), relaxed = search(0.20, 0.45, 0.45, 0.25, false);
  if (!relaxed && !strict) return { fail: 'base', ext10: ext10 / a };
  const surfShare = (b) => { let best = 0; for (const [nm, A] of [[10, S10], [20, S20], [50, S50]]) { if (!rising[nm]) continue;
    const w0 = Math.max(b.s, j - 15); let ab = 0, touch = false; for (let k = w0; k <= j; k++) { if (d.c[k] >= A[k] * 0.97) ab++; if (d.l[k] <= A[k] * 1.03) touch = true; }
    if (touch) best = Math.max(best, ab / (j - w0 + 1)); } return best; };
  const last3 = (mx(d.h, j - 2, j) - mn(d.l, j - 2, j)) / d.c[j], nr = (d.h[j] - d.l[j]) / d.c[j] <= 0.6 * a, inside = d.h[j] <= d.h[j - 1] && d.l[j] >= d.l[j - 1];
  return { ext10: ext10 / a, atr: atr[i], adr: a, strict: strict && { ...strict, surf: surfShare(strict) }, relaxed: relaxed && { ...relaxed, surf: surfShare(relaxed) },
    tight: last3 <= 2 * a && (nr || inside || last3 <= 1.4 * a) };
}
// rule variants applied to the metrics above
const V = {
  v3_live:      m => m.strict && m.strict.surf >= 0.75 && m.ext10 <= 1.5 ? m.strict : null,
  relax_all:    m => m.relaxed && m.relaxed.surf >= 0.6 && m.ext10 <= 2.5 ? m.relaxed : null,
  relax_drift12:m => { const b = V.relax_all(m); return b && b.drift <= 0.12 ? b : null; },
};
// v4 variants (setup4.mjs). Each runs detect4 with these overrides; results keyed by name.
// v4 variants = extra gates on one detect4() result (the base search itself does not depend on them)
const V4G = {
  v4:             x => true,
  v4_strictTrend: x => x.rising[20] && x.rising[50],
  v4_ext15:       x => x.ext <= 1.5,
  v4_tightOnly:   x => x.tight,
  v4_no50:        x => x.surf !== 50,
};

function manage(d, e, entry, stop0, S10) {
  let stop = stop0, left = 1, realized = 0, half = false, exitK = null, why = 'open';
  const out = (px, k, w) => { realized += left * (px * (1 - COST) - entry); left = 0; exitK = k; why = w; };
  for (let k = e + 1; k < d.c.length && left > 0; k++) {
    if (d.o[k] <= stop) { out(d.o[k], k, 'gap stop'); break; }
    if (d.l[k] <= stop) { out(stop, k, half ? 'break-even' : 'stopped'); break; }
    if (!half && k - e >= 3) { realized += 0.5 * (d.c[k] * (1 - COST) - entry); left = 0.5; half = true; stop = Math.max(stop, entry); continue; }
    if (half && S10[k] != null && d.c[k] < S10[k]) { out(d.c[k], k, '10-day'); break; }
  }
  return { pnl: realized + left * (d.c.at(-1) - entry), exitK, why };
}
// hourly realistic entry. level0 = the daily trigger (null for EP). maxATR = widest stop allowed in ATRs.
function simH(d, i, hb, level0, atr, maxATR, vAvg, chase = true) {
  const ds = dstr(d.t[i]); const idx = []; for (let k = 0; k < hb.t.length; k++) if (dstr(hb.t[k] - 4 * 3600) === ds) idx.push(k);
  if (idx.length < 2) return null;
  const level = Math.max(level0 ?? 0, hb.h[idx[0]]) + 0.01; let eb = null, entry = null;
  for (let z = 1; z < idx.length; z++) if (hb.h[idx[z]] >= level) { eb = z; entry = Math.max(hb.o[idx[z]], level) * (1 + COST); break; }
  if (eb == null) return null;
  let lod = Infinity, cumV = 0; for (let z = 0; z <= eb; z++) { lod = Math.min(lod, hb.l[idx[z]]); cumV += hb.v[idx[z]]; }
  if ((chase && level0 != null && entry - d.c[i - 1] > atr) || entry - lod > maxATR * atr || entry <= lod) return null;
  const pace = cumV / (vAvg * Math.min(1, (eb + 1) / 6.5)), firstHourVol = hb.v[idx[0]] / vAvg;
  let res = null; for (let z = eb + 1; z < idx.length; z++) if (hb.l[idx[z]] <= lod) { res = { pnl: lod * (1 - COST) - entry, exitK: i, why: 'stopped same day' }; break; }
  if (!res) res = manage(d, i, entry, lod, d.S10);
  return { entry, stop: lod, pace, firstHourVol, R: res.pnl / (entry - lod), pct: res.pnl / entry * 100, riskPct: (entry - lod) / entry, exitK: res.exitK, why: res.why };
}
function simP(d, i, top, atr, chase = true) {
  const entry = Math.max(d.o[i], top + 0.01) * (1 + COST);
  if ((chase && entry - d.c[i - 1] > atr) || entry - d.l[i] > atr) return null;
  const stop = Math.min(d.l[i], entry - 0.3 * atr);
  const res = d.c[i] < entry ? { pnl: stop * (1 - COST) - entry, exitK: i, why: 'closed below entry' } : manage(d, i, entry, stop, d.S10);
  return { entry, stop, R: res.pnl / (entry - stop), pct: res.pnl / entry * 100, riskPct: (entry - stop) / entry, exitK: res.exitK, why: res.why };
}

// stats with one-open-trade-per-stock blocking (re-entry allowed the day after an exit, or not at all)
function run(sigs, reentry = true) {
  const block = new Map(), T = [];
  for (const s of sigs.sort((a, b) => a.date.localeCompare(b.date))) {
    const b = block.get(s.t); if (b && (reentry ? s.date <= b : true)) continue;
    T.push(s); block.set(s.t, s.exit || '9999');
  }
  return T;
}
function stats(T, split) {
  const one = A => { const n = A.length; if (!n) return { n: 0 };
    const sum = A.reduce((a, t) => a + t.R, 0), acct = A.reduce((a, t) => a + t.R * Math.min(RISK, CAP * t.riskPct), 0);
    const byExit = [...A].sort((a, b) => (a.exit || '9999').localeCompare(b.exit || '9999')); let c = 0, pk = 0, dd = 0;
    for (const t of byExit) { c += t.R * Math.min(RISK, CAP * t.riskPct); pk = Math.max(pk, c); dd = Math.min(dd, c - pk); }
    const ev = []; for (const t of A) { ev.push([t.date, 1]); ev.push([t.exit || '9999', -1]); } ev.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
    let o = 0, mo = 0; for (const [, x] of ev) { o += x; mo = Math.max(mo, o); }
    const days = new Set(A.map(t => t.date)).size;
    return { n, win: r2(A.filter(t => t.R > 0).length / n), avgR: r2(sum / n), totR: r2(sum), avgPct: r2(A.reduce((a, t) => a + t.pct, 0) / n), acct: r2(acct * 100), maxDD: r2(dd * 100), maxOpen: mo, big5: A.filter(t => t.R >= 5).length, tradeDays: days }; };
  return { all: one(T), train: one(T.filter(t => t.date < split)), test: one(T.filter(t => t.date >= split)) };
}

async function main() {
  const t0 = Date.now();
  const list = await tvList(); console.log('stocks', list.length);
  const now = Math.floor(Date.now() / 1000), p1 = now - Math.round((YEARS + 1.3) * 365.25 * 86400);
  const q = `period1=${p1}&period2=${now}&interval=1d`;
  const ndx = clean(await history('^IXIC', q));
  const Sx = []; let k = 0;
  const w = async () => { while (k < list.length) { const r = list[k++]; const res = await history(r.name, q);
    if (res?.timestamp) { const d = clean(res); if (d.c.length > 200) Sx.push({ r, d }); } if (k % 500 === 0) console.log(k, Math.round((Date.now() - t0) / 1000) + 's'); await sleep(120); } };
  await Promise.all(Array.from({ length: 6 }, w));
  for (const { d } of Sx) {     // precompute everything once
    const n = d.c.length; d.idx = new Map(d.t.map((t, i) => [dstr(t), i])); d.S10 = sma(d.c, 10); d.S20 = sma(d.c, 20); d.S50 = sma(d.c, 50);
    const tr = d.c.map((c, k) => k ? Math.max(d.h[k] - d.l[k], Math.abs(d.h[k] - d.c[k - 1]), Math.abs(d.l[k] - d.c[k - 1])) : d.h[k] - d.l[k]);
    d.atr = new Array(n).fill(null); d.adr = new Array(n).fill(null); d.dv = new Array(n).fill(null); d.v20 = new Array(n).fill(null);
    for (let i = 30; i < n; i++) { d.atr[i] = avg(tr, i - 14, i - 1); let a = 0; for (let q2 = i - 19; q2 <= i; q2++) a += d.h[q2] / d.l[q2] - 1; d.adr[i] = a / 20;
      let s = 0; for (let q2 = i - 29; q2 <= i; q2++) s += d.c[q2] * d.v[q2]; d.dv[i] = s / 30; d.v20[i] = avg(d.v, i - 20, i - 1); }
  }
  console.log('prepared', Sx.length, Math.round((Date.now() - t0) / 1000) + 's');
  const lowMin = (l, a, b) => mn(l, a, b);
  const meas = [(d, i) => d.c[i] / d.c[i - 21] - 1, (d, i) => d.c[i] / d.c[i - 63] - 1, (d, i) => d.c[i] / d.c[i - 126] - 1,
    (d, i) => d.c[i] / lowMin(d.l, i - 21, i) - 1, (d, i) => d.c[i] / lowMin(d.l, i - 66, i) - 1, (d, i) => d.c[i] / lowMin(d.l, i - 125, i) - 1];
  const startT = now - YEARS * 365.25 * 86400, hStart = now - 725 * 86400;
  const days = ndx.t.map((t, i) => ({ t, i, ds: dstr(t) })).filter(x => x.t >= startT);
  const funnel = { days: 0, momentum: 0, trend: 0, ext10ok: 0, baseStrict: 0, baseRelaxed: 0, v3setups: 0, relaxSetups: 0, v3near: 0, relaxNear: 0, v3breakout: 0, relaxBreakout: 0, fails: {} };
  const cand = [];                              // breakout candidates: {s,i,date,mkt,m}
  const cand4 = [];                             // v4 breakout candidates: {s,i,date,mkt,b:{variant:base}}
  const f4 = { setups: 0, breakouts: 0, fails: {} };
  const eps = [];                               // EP gap days in the hourly window
  for (const D of days) {
    const light = marketLight({ c: ndx.c.slice(Math.max(0, D.i - 299), D.i + 1) }).light;
    const U = []; for (const s of Sx) { const i = s.d.idx.get(D.ds); if (i == null || i < 140) continue; const d = s.d;
      if (d.c[i - 1] < 1 || !(d.dv[i - 1] >= MIN_DV)) continue; U.push({ s, i });
      if (D.t >= hStart && d.o[i] / d.c[i - 1] - 1 >= 0.10) eps.push({ s, i, date: D.ds, mkt: light, gap: d.o[i] / d.c[i - 1] - 1, prior63: d.c[i - 1] / d.c[i - 64] - 1 }); }
    const UA2 = U.filter(u => u.s.d.adr[u.i - 1] >= MIN_ADR), keep = Math.min(50, Math.max(10, Math.round(UA2.length * 0.07)));
    const pick = new Set(); for (const f of meas) UA2.map(u => ({ u, x: f(u.s.d, u.i - 1) })).filter(z => Number.isFinite(z.x)).sort((a, b) => b.x - a.x).slice(0, keep).forEach(z => pick.add(z.u));
    const green = light === 'green'; if (green) funnel.days++;
    for (const u of pick) { const { s, i } = u, d = s.d;
      const x = detect4(d, i, d);
      if (green) { if (x.fail) f4.fails[x.fail] = (f4.fails[x.fail] || 0) + 1; else { f4.setups++; if (d.h[i] > x.top) f4.breakouts++; } }
      if (!x.fail && d.h[i] > x.top) { const b4 = {}; for (const [vn, g] of Object.entries(V4G)) if (g(x)) b4[vn] = { top: x.top, L: x.L, surf: x.surf, tight: x.tight };
        cand4.push({ s, i, date: D.ds, mkt: light, b4 }); }
      const m = setup(d, i, d);
      if (green) { funnel.momentum++; if (m.fail) funnel.fails[m.fail] = (funnel.fails[m.fail] || 0) + 1;
        if (!m.fail || m.fail === 'base') funnel.trend++; if (!m.fail || m.fail === 'base') { if (m.ext10 <= 1.5) funnel.ext10ok++; }
        if (m.strict) funnel.baseStrict++; if (m.relaxed) funnel.baseRelaxed++; }
      if (m.fail) continue;
      const b3 = V.v3_live(m), br = V.relax_all(m);
      const stage = b => !b ? null : d.h[i] > b.top ? 'bo' : d.c[i - 1] >= b.top * 0.97 ? 'near' : 'form';
      if (green) { if (b3) { funnel.v3setups++; if (stage(b3) === 'near') funnel.v3near++; if (stage(b3) === 'bo') funnel.v3breakout++; }
        if (br) { funnel.relaxSetups++; if (stage(br) === 'near') funnel.relaxNear++; if (stage(br) === 'bo') funnel.relaxBreakout++; } }
      if ((b3 && stage(b3) === 'bo') || (br && stage(br) === 'bo') || Object.values(V).some(f => { const b = f(m); return b && d.h[i] > b.top; }))
        cand.push({ s, i, date: D.ds, mkt: light, m });
    }
  }
  console.log('v4 candidates', cand4.length);
  console.log('candidates', cand.length, 'eps', eps.length, Math.round((Date.now() - t0) / 1000) + 's');
  // hourly bars for every stock that has a candidate or an EP in the hourly window
  const need = [...new Set([...cand.filter(c => c.s.d.t[c.i] >= hStart), ...cand4.filter(c => c.s.d.t[c.i] >= hStart), ...eps].map(c => c.s.r.name))]; const H = new Map(); let qn = 0;
  const hw = async () => { while (qn < need.length) { const sym = need[qn++]; const res = await history(sym, 'range=730d&interval=60m'); if (res?.timestamp) H.set(sym, clean(res)); if (qn % 300 === 0) console.log('hourly', qn, '/', need.length); await sleep(120); } };
  await Promise.all(Array.from({ length: 6 }, hw));
  console.log('hourly series', H.size, 'of', need.length, Math.round((Date.now() - t0) / 1000) + 's');

  const hSplit = dstr(hStart + 362 * 86400), pSplit = dstr(startT + (YEARS / 2) * 365.25 * 86400);
  const results = {};
  const cacheH = new Map(), cacheP = new Map();
  for (const [vn, f] of Object.entries(V)) {
    const sigH = [], sigP = [];
    for (const c of cand) { const b = f(c.m); if (!b) continue; const d = c.s.d, i = c.i; if (!(d.h[i] > b.top) || d.o[i] > b.top * 1.10) continue;
      const kP = c.s.r.name + c.date + b.top; if (!cacheP.has(kP)) cacheP.set(kP, simP(d, i, b.top, c.m.atr));
      const p = cacheP.get(kP); if (p) sigP.push({ t: c.s.r.name, date: c.date, mkt: c.mkt, vr: d.v[i] / d.v20[i], tight: c.m.tight, ...p, exit: p.exitK != null ? dstr(d.t[p.exitK]) : null });
      if (d.t[i] < hStart) continue; const hb = H.get(c.s.r.name); if (!hb) continue;
      const kH = kP; if (!cacheH.has(kH)) cacheH.set(kH, simH(d, i, hb, b.top, c.m.atr, 1, d.v20[i]));
      const h = cacheH.get(kH); if (h) sigH.push({ t: c.s.r.name, date: c.date, mkt: c.mkt, vr: h.pace, tight: c.m.tight, ...h, exit: h.exitK != null ? dstr(d.t[h.exitK]) : null });
    }
    const out = {};
    for (const [mk, mf] of [['any', () => true], ['notRed', t => t.mkt !== 'red'], ['green', t => t.mkt === 'green']])
      for (const vol of [0, 1.0, 1.2, 1.5]) {
        const fH = sigH.filter(t => mf(t) && t.vr >= vol), fP = sigP.filter(t => mf(t) && t.vr >= vol);
        out[mk + '_v' + vol] = { H: stats(run(fH), hSplit), H_noReentry: stats(run(fH, false), hSplit).all, P: stats(run(fP), pSplit) };
      }
    results[vn] = out;
  }
  const vols = [0, 1.0];
  const tops4 = [];
  for (const vn of Object.keys(V4G)) for (const chase of (vn === 'v4' ? [false, true] : [false])) {
    const sigH = [], sigP = [];
    for (const c of cand4) { const b = c.b4[vn]; if (!b) continue; const d = c.s.d, i = c.i; if (d.o[i] > b.top * 1.10) continue; const atr = d.atr[i];
      const k = c.s.r.name + c.date + b.top + chase;
      if (!cacheP.has(k)) cacheP.set(k, simP(d, i, b.top, atr, chase));
      const p = cacheP.get(k); if (p) sigP.push({ t: c.s.r.name, date: c.date, mkt: c.mkt, vr: d.v[i] / d.v20[i], ...p, exit: p.exitK != null ? dstr(d.t[p.exitK]) : null });
      if (d.t[i] < hStart) continue; const hb = H.get(c.s.r.name); if (!hb) continue;
      if (!cacheH.has(k)) cacheH.set(k, simH(d, i, hb, b.top, atr, 1, d.v20[i], chase));
      const h = cacheH.get(k); if (h) sigH.push({ t: c.s.r.name, date: c.date, mkt: c.mkt, vr: h.pace, surf: b.surf, L: b.L, tight: b.tight, ...h, exit: h.exitK != null ? dstr(d.t[h.exitK]) : null });
    }
    const out = {};
    for (const [mk, mf] of [['any', () => true], ['notRed', t => t.mkt !== 'red'], ['green', t => t.mkt === 'green']])
      for (const vol of vols) {
        const fH = sigH.filter(t => mf(t) && t.vr >= vol), fP = sigP.filter(t => mf(t) && t.vr >= vol);
        out[mk + '_v' + vol] = { H: stats(run(fH), hSplit), H_noReentry: stats(run(fH, false), hSplit), P: stats(run(fP), pSplit) };
      }
    if (vn === 'v4' && !chase) {   // break the main v4 result down by which MA it surfs, base length, and tightness
      const g = sigH.filter(t => t.mkt !== 'red'), by = (f) => { const o = {}; for (const t of g) { const k = f(t); (o[k] = o[k] || []).push(t); } return Object.fromEntries(Object.entries(o).map(([k, A]) => [k, stats(run(A), hSplit).all])); };
      out.breakdown_notRed = { surf: by(t => t.surf), L: by(t => t.L <= 7 ? '3-7' : t.L <= 15 ? '8-15' : '16-40'), tight: by(t => String(t.tight)) };
      tops4.push(...run(g).sort((a, b) => b.R - a.R).slice(0, 15).map(t => [t.t, t.date, r2(t.R), r2(t.pct)]));
      out.top15_notRed = tops4;
    }
    results[vn + (chase ? '_withChaseRule' : '')] = out;
  }
  // EP: gap >= 10%, buy above the first-hour high, stop = low of day, stop up to 1.5 ATR
  const epSig = [];
  for (const e of eps) { const hb = H.get(e.s.r.name); if (!hb) continue; const d = e.s.d, i = e.i; const atr = d.atr[i]; if (!atr) continue;
    const h = simH(d, i, hb, null, atr, 1.5, d.v20[i]); if (!h) continue;
    epSig.push({ t: e.s.r.name, date: e.date, mkt: e.mkt, gap: e.gap, prior63: e.prior63, fhv: h.firstHourVol, ...h, exit: h.exitK != null ? dstr(d.t[h.exitK]) : null }); }
  const epOut = {};
  for (const [mk, mf] of [['any', () => true], ['notRed', t => t.mkt !== 'red'], ['green', t => t.mkt === 'green']])
    for (const fv of [0, 0.3, 0.5, 1.0]) for (const [pn, pf] of [['all', () => true], ['neglected', t => t.prior63 < 0.3]]) {
      epOut[mk + '_fhv' + fv + '_' + pn] = stats(run(epSig.filter(t => mf(t) && t.fhv >= fv && pf(t))), hSplit); }
  const out = { ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), years: YEARS, hourlyFrom: dstr(hStart), hSplit, pSplit,
    stocks: Sx.length, hourlySeries: H.size, funnel: { ...funnel, perGreenDay: Object.fromEntries(Object.entries(funnel).filter(([k]) => !['days', 'fails'].includes(k)).map(([k, v]) => [k, r2(v / Math.max(1, funnel.days))])) },
    funnel4: { ...f4, setupsPerGreenDay: r2(f4.setups / Math.max(1, funnel.days)), breakoutsPerGreenDay: r2(f4.breakouts / Math.max(1, funnel.days)) },
    variants: results, ep: epOut, epCount: epSig.length,
    epTop: epSig.sort((a, b) => b.R - a.R).slice(0, 15).map(t => [t.t, t.date, r2(t.gap), r2(t.fhv), r2(t.R), r2(t.pct)]),
    notes: ['Hourly window starts ' + dstr(hStart) + '. Train/test split at ' + hSplit + ' (hourly) and ' + pSplit + ' (5y daily).', 'Survivorship bias: only stocks listed today.', 'No earnings dates: EPs are any 10%+ gap.', 'Re-entry allowed the day after an exit unless stated.'] };
  await writeFile('research.json', JSON.stringify(out));
  console.log('done', out.seconds + 's', JSON.stringify(out.funnel.perGreenDay));
}
main().catch(e => { console.error(e); process.exit(1); });
