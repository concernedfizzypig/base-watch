// Base Watch v4 setup detector, rebuilt from the charts he showed (see recall.json for what v3 missed).
// v3 missed most of his examples because: depth was a fixed 30% (too tight for 10%+ ADR stocks), the base had to be
// within 15% of the 6-month high (kills flags that form below a news spike), the 20-day had to be rising (kills
// pullbacks to the 50-day), and gap-up breakouts were thrown out as "chased".
// v4: a consolidation of 3-40 days that sits on a rising 10, 20 or 50-day, after a 30%+ leg up, holding the upper half
// of that leg, with depth and drift scaled to the stock's ADR, and higher lows or a tightening range.
// d = daily arrays; A = precomputed { S10, S20, S50, adr } where adr[k] = 20-day ADR ending at bar k (inclusive).
export const V4 = {
  minADR: 0.04, maxExt: 2.0,             // close no more than 2 ADRs above the 10-day
  minPrior: 0.30, legLook: 126, peakLook: 40, minRetain: 0.5,
  minL: 3, maxL: 40, depthADR: 3.5, depthCap: 0.45, driftADR: 1.5, driftMin: 0.12,
  surfClose: 0.95, surfShare: 0.6, touch: 1.04, last3ADR: 2.5,
  trend: 'any',                          // 'any' = 50-day rising OR (10 & 20 rising, 10 above 20); 'strict' = 20 & 50 rising
};
const mx = (a, s, e) => { let m = -Infinity; for (let i = s; i <= e; i++) if (a[i] > m) m = a[i]; return m; };
const mn = (a, s, e) => { let m = Infinity; for (let i = s; i <= e; i++) if (a[i] < m) m = a[i]; return m; };
const argmx = (a, s, e) => { let m = -Infinity, k = s; for (let i = s; i <= e; i++) if (a[i] > m) { m = a[i]; k = i; } return k; };

export function detect4(d, i, A, o = V4) {
  const j = i - 1; if (j < 60) return { fail: 'history' };
  const a = A.adr[j], { S10, S20, S50 } = A;
  if (!(a >= o.minADR)) return { fail: 'adr' };
  const r = { 10: S10[j] > S10[j - 5], 20: S20[j] > S20[j - 5], 50: S50[j] > S50[j - 5] };
  const trendOK = o.trend === 'strict' ? r[20] && r[50] : (r[50] && d.c[j] >= S50[j] * 0.97) || (r[10] && r[20] && S10[j] > S20[j]);
  if (!trendOK) return { fail: 'trend' };
  const ext = (d.c[j] / S10[j] - 1) / a; if (ext > o.maxExt) return { fail: 'ext', ext };
  let best = null, why = null;
  for (let L = o.minL; L <= o.maxL; L++) {
    const s = j - L + 1; if (s < 60) break;
    const top = mx(d.h, s, j), bot = mn(d.l, s, j), depth = (top - bot) / top;
    if (depth > Math.min(o.depthCap, o.depthADR * a)) { why = 'deep'; continue; }
    if (Math.abs(d.c[j] / d.c[s] - 1) > Math.max(o.driftMin, o.driftADR * a)) { why = 'drift'; continue; }
    const pk = argmx(d.h, Math.max(0, s - o.peakLook), j), peak = d.h[pk];
    const legLow = mn(d.l, Math.max(0, pk - o.legLook), pk), prior = peak / legLow - 1;
    if (prior < o.minPrior) { why = 'prior'; continue; }
    if (top < legLow + o.minRetain * (peak - legLow)) { why = 'retain'; continue; }
    const hf = Math.max(1, Math.floor(L / 2));
    const ra = mx(d.h, s, s + hf - 1) - mn(d.l, s, s + hf - 1), rb = mx(d.h, s + hf, j) - mn(d.l, s + hf, j);
    const hl = mn(d.l, s + hf, j) >= mn(d.l, s, s + hf - 1) * (1 - 0.25 * a), tightening = rb <= ra * 1.1;
    if (!(hl || tightening)) { why = 'shape'; continue; }
    let surf = null;
    for (const [nm, M] of [[10, S10], [20, S20], [50, S50]]) { if (!r[nm]) continue;
      const w0 = Math.max(s, j - 15); let ab = 0, touch = false;
      for (let k = w0; k <= j; k++) { if (d.c[k] >= M[k] * o.surfClose) ab++; if (d.l[k] <= M[k] * o.touch) touch = true; }
      if (ab / (j - w0 + 1) >= o.surfShare && touch) { surf = nm; break; } }
    if (!surf) { why = 'surf'; continue; }
    best = { L, s, top, bot, depth, prior, surf, hl, tightening };
  }
  if (!best) return { fail: 'base:' + why, ext };
  const last3 = (mx(d.h, j - 2, j) - mn(d.l, j - 2, j)) / d.c[j];
  if (last3 > o.last3ADR * a) return { fail: 'loose', ext };
  const nr = (d.h[j] - d.l[j]) / d.c[j] <= 0.6 * a, inside = d.h[j] <= d.h[j - 1] && d.l[j] >= d.l[j - 1];
  return { ...best, ext, adr: a, tight: last3 <= 2 * a && (nr || inside || last3 <= 1.4 * a), last3 };
}
