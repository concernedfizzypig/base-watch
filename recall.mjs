// Recall test: did the live bot's rules catch the breakouts Qullamaggie showed in his own charts?
// For each case: every day in the window where price broke a 10-day high is checked against analyze(),
// and a diagnosis says which rule blocked it. Output: recall.json
import { writeFile } from 'node:fs/promises';
import { S, history, clean, sma, marketLight, analyze, dstr } from './scan.mjs';
import { detect4 } from './setup4.mjs';

const CASES = [
  // [label, symbols to try, window start, window end, note]
  ['TSLA 2020 triangle', ['TSLA'], '2020-05-26', '2020-06-12'],
  ['MNKD 2013 flag', ['MNKD'], '2013-04-15', '2013-06-20'],
  ['AAXN Jan 2004', ['AXON'], '2003-12-20', '2004-02-10'],
  ['AMZN Aug 2020 HTF', ['AMZN'], '2020-08-14', '2020-09-02'],
  ['WIX 2020 higher lows', ['WIX'], '2020-08-12', '2020-09-10'],
  ['LL 2020 stair-step', ['LL', 'LLFLQ'], '2020-08-12', '2020-08-31'],
  ['SPOT 2020 50-day', ['SPOT'], '2020-08-17', '2020-10-15'],
  ['LVGO 2020', ['LVGO'], '2020-06-01', '2020-08-25'],
  ['SHLL Aug 2020', ['HYLN'], '2020-08-10', '2020-09-15'],
  ['SVM Aug 2020', ['SVM'], '2020-08-12', '2020-09-04'],
  ['NNDM 2020-21 flags', ['NNDM'], '2020-10-01', '2021-01-25'],
  ['JMIA Jan 2021', ['JMIA'], '2021-01-04', '2021-01-20'],
  ['NIO Jun 2020', ['NIO'], '2020-06-01', '2020-07-15'],
  ['SRNE Jul 2020', ['SRNE', 'SRNEQ'], '2020-06-01', '2020-07-20'],
  ['SQ Jun 2020', ['XYZ', 'SQ'], '2020-05-15', '2020-07-15'],
  ['CAN Aug 2020', ['CAN'], '2020-07-28', '2020-08-10'],
  ['ZM Aug 2020', ['ZM'], '2020-08-03', '2020-08-31'],
  ['PETS 2020 (should NOT fire)', ['PETS'], '2020-08-01', '2020-09-15'],
];

const T = s => Math.floor(Date.parse(s + 'T00:00:00Z') / 1000);
const avg = (a, s, e) => { let x = 0; for (let i = s; i <= e; i++) x += a[i]; return x / (e - s + 1); };
const mx = (a, s, e) => { let m = -Infinity; for (let i = s; i <= e; i++) if (a[i] > m) m = a[i]; return m; };
const mn = (a, s, e) => { let m = Infinity; for (let i = s; i <= e; i++) if (a[i] < m) m = a[i]; return m; };
const sl = (d, e) => ({ t: d.t.slice(0, e + 1), o: d.o.slice(0, e + 1), h: d.h.slice(0, e + 1), l: d.l.slice(0, e + 1), c: d.c.slice(0, e + 1), v: d.v.slice(0, e + 1) });
const r = (x, k = 3) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** k) / 10 ** k;

// re-trace the analyze() gates and report the first one that fails (same numbers as scan.mjs)
function diag(d) {
  const n = d.c.length, i = n - 1; if (n < 140) return { fail: 'history<140 days', n };
  const S10 = sma(d.c, 10), S20 = sma(d.c, 20), S50 = sma(d.c, 50);
  let adr = 0; for (let k = i - 20; k < i; k++) adr += d.h[k] / d.l[k] - 1; adr /= 20;
  const j = i - 1, out = { adr: r(adr), dollarVol: Math.round(avg(d.v, i - 20, i - 1) * d.c[j] / 1e6) };
  out.rising = { 10: S10[j] > S10[j - 5], 20: S20[j] > S20[j - 5], 50: S50[j] > S50[j - 5] };
  out.ext10_adr = r((d.c[j] / S10[j] - 1) / adr, 2);
  const fails = [];
  if (adr < S.minADR) fails.push('ADR<4%');
  if (out.dollarVol < S.minDollarVol / 1e6) fails.push('$vol<10M');
  if (!out.rising[20]) fails.push('20-day not rising');
  if (!out.rising[50]) fails.push('50-day not rising');
  if (out.ext10_adr > S.maxExt10) fails.push('too far above 10-day');
  // base search: why does each length fail?
  const hi120 = mx(d.h, Math.max(0, i - 120), j); const why = {}; let best = null;
  for (let L = S.minBase; L <= S.maxBase; L++) {
    const s = i - L; if (s < 130) { why['not enough history'] = (why['not enough history'] || 0) + 1; break; }
    const top = mx(d.h, s, j), bot = mn(d.l, s, j), depth = (top - bot) / top;
    const prior = top / mn(d.l, Math.max(0, s - 126), s) - 1;
    let f = null;
    if (prior < S.minPriorMove) f = 'prior move<30%';
    else if (depth > (prior >= 1 ? S.maxDepthBigMove : S.maxDepth)) f = 'base too deep';
    else if (top < 0.85 * hi120) f = 'base not near 6-mo high';
    else if (Math.abs(d.c[j] / d.c[s] - 1) > S.maxDrift) f = 'base drifts >12% (not sideways)';
    else { const hf = Math.floor(L / 2);
      const ra = mx(d.h, s, s + hf - 1) - mn(d.l, s, s + hf - 1), rb = mx(d.h, s + hf, j) - mn(d.l, s + hf, j);
      if (rb > ra) f = '2nd half wider (not tightening)';
      else if (mn(d.l, s + hf, j) < mn(d.l, s, s + hf - 1)) f = 'lower low in 2nd half'; }
    if (f) why[f] = (why[f] || 0) + 1; else best = { L, top: r(top, 2), depth: r(depth), prior: r(prior) };
  }
  out.baseFailCounts = why; out.base = best;
  if (!best) fails.push('no valid base');
  if (best) {
    const s = i - best.L; let surf = null;
    for (const [nm, A] of [[10, S10], [20, S20], [50, S50]]) { if (!out.rising[nm]) continue;
      const w0 = Math.max(s, j - 15); let above = 0, touch = false;
      for (let k = w0; k <= j; k++) { if (d.c[k] >= A[k] * S.surfClose) above++; if (d.l[k] <= A[k] * 1.03) touch = true; }
      if (above / (j - w0 + 1) >= S.surfShare && touch) { surf = nm; break; } }
    out.surf = surf; if (!surf) fails.push('not surfing a rising 10/20/50');
  }
  out.fail = fails.join(' + ') || null;
  return out;
}

const ndxRes = await history('^IXIC', `period1=${T('2002-01-01')}&period2=${T('2021-06-01')}&interval=1d`);
const ndx = ndxRes ? clean(ndxRes) : null;
const ndxIdx = new Map((ndx?.t || []).map((t, k) => [Math.floor(t / 86400), k]));
const ctx = { ndx, hot: [] };
const results = [];
for (const [label, syms, w0, w1] of CASES) {
  let d = null, used = null;
  for (const sym of syms) {
    const res = await history(sym, `period1=${T(w0) - 400 * 86400}&period2=${T(w1) + 10 * 86400}&interval=1d`);
    if (res?.timestamp?.length > 50) { d = clean(res); used = sym; break; }
  }
  if (!d) { results.push({ label, error: 'no Yahoo data for ' + syms.join('/') }); continue; }
  const A = { S10: sma(d.c, 10), S20: sma(d.c, 20), S50: sma(d.c, 50), adr: d.c.map((_, k) => { if (k < 20) return null; let x = 0; for (let q = k - 19; q <= k; q++) x += d.h[q] / d.l[q] - 1; return x / 20; }) };
  const tr = d.c.map((c, k) => k ? Math.max(d.h[k] - d.l[k], Math.abs(d.h[k] - d.c[k - 1]), Math.abs(d.l[k] - d.c[k - 1])) : d.h[k] - d.l[k]);
  const days = [];
  for (let i = 140; i < d.c.length; i++) {
    if (d.t[i] < T(w0) || d.t[i] > T(w1) + 86399) continue;
    const prevHi = mx(d.h, i - 10, i - 1); if (!(d.h[i] > prevHi)) continue;     // a 10-day-high break = a candidate breakout day
    const sub = sl(d, i);
    const info = { r: { name: used, description: label, sector: '', earnings_release_next_date: null }, scans: [] };
    const a = analyze(sub, info, ctx, 1, { backtest: true, now: d.t[i] * 1000 });
    const k = ndxIdx.get(Math.floor(d.t[i] / 86400));
    const light = k != null && k > 30 ? marketLight({ c: ndx.c.slice(Math.max(0, k - 299), k + 1) }).light : null;
    const day = { date: dstr(d.t[i]), o: r(d.o[i], 2), h: r(d.h[i], 2), l: r(d.l[i], 2), c: r(d.c[i], 2), chg: r(d.c[i] / d.c[i - 1] - 1),
      vr: r(d.v[i] / avg(d.v, i - 20, i - 1), 2), light };
    if (a && a.st === 'breakout') Object.assign(day, { bot: 'BREAKOUT', trigger: a.top, L: a.L, surf: a.surf, stars: a.stars, chased: a.chased, stopTooWide: a.stopTooWide, volOK: a.volOK,
      wouldAlert: !a.chased && !a.stopTooWide && a.volOK && light !== 'red' });
    else if (a) Object.assign(day, { bot: 'setup but no break (' + a.st + ')', trigger: a.top });
    else Object.assign(day, { bot: 'MISSED', why: diag(sub) });
    const m4 = detect4(d, i, A), atr = avg(tr, i - 14, i - 1);
    if (m4.fail) day.v4 = 'miss: ' + m4.fail;
    else if (d.h[i] > m4.top) { const entry = Math.max(d.o[i], m4.top); day.v4 = 'BREAKOUT L' + m4.L + ' surf' + m4.surf + ' trig ' + r(m4.top, 2) + (entry - d.l[i] > atr ? ' (LOD stop > 1 ATR)' : ''); day.v4ok = entry - d.l[i] <= atr; }
    else day.v4 = 'setup, no break (trig ' + r(m4.top, 2) + ')';
    days.push(day);
  }
  results.push({ label, sym: used, window: [w0, w1], days, caught: days.some(x => x.bot === 'BREAKOUT'), alerted: days.some(x => x.wouldAlert), v4caught: days.some(x => x.v4ok) });
  console.log(label, used, days.map(x => x.date + ':' + (x.bot === 'BREAKOUT' ? (x.wouldAlert ? 'ALERT' : 'bo-blocked') : x.bot === 'MISSED' ? 'miss[' + x.why.fail + ']' : 'nb') + ' v4=' + x.v4).join(' | '));
}
await writeFile('recall.json', JSON.stringify({ at: new Date().toISOString(), settings: S, results }, null, 1));
