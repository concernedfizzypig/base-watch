// Base Watch scanner. Runs on GitHub Actions (Node 20+, no dependencies).
// 1) Gets the US stock list from TradingView's public screener.
// 2) Downloads ~8 months of daily prices per candidate from Yahoo Finance.
// 3) Finds breakout setups: big prior move -> tight, tightening base -> push through the top on volume.
// 4) Writes results.json for the app and sends a push to ntfy for anything new.
import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'results.json';
const STATE = 'alerted.json';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const APP_URL = process.env.APP_URL || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- settings (edit these to change what counts as a setup) ----------
const S = {
  minPrice: 1, minAvgVol: 150_000, minDollarVol: 1_000_000, mcapMin: 50e6, mcapMax: 50e9,
  minMove: 0.30,      // top of base at least 30% above the 60-day low before it
  maxDepth: 0.18,     // base no deeper than 18%
  minBase: 5, maxBase: 40,
  minADR: 0.025,      // average daily range at least 2.5%
  nearPct: 0.03,      // "near breakout" = within 3% of the top
  breakoutVol: 1.3,   // breakout needs volume >= 1.3x the 20-day average (projected during market hours)
  maxExtended: 0.10,  // ignore if already >10% above the breakout level
};

// ---------- 1. universe from TradingView ----------
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
  const allUS = (await tv({ filter: base, markets: ['america'], columns: ['name'], range: [0, 1] })).totalCount;
  const cols = ['name', 'description', 'market_cap_basic', 'sector', 'High.3M', 'Low.3M', 'close', 'average_volume_30d_calc', 'EMA20', 'EMA50', 'High.6M', 'High.1M', 'Low.1M', 'ATR'];
  const j = await tv({
    filter: [...base,
      { left: 'close', operation: 'greater', right: S.minPrice },
      { left: 'average_volume_30d_calc', operation: 'greater', right: S.minAvgVol },
      { left: 'market_cap_basic', operation: 'in_range', right: [S.mcapMin, S.mcapMax] }],
    markets: ['america'], columns: cols, range: [0, 10000],
  });
  const R = j.data.map(x => Object.fromEntries(cols.map((c, i) => [c, x.d[i]])));
  const tradeable = R.filter(r => r.close * r.average_volume_30d_calc >= S.minDollarVol);
  // cheap pre-filter so we only download history for plausible candidates
  const cand = tradeable.filter(r =>
    r['High.3M'] / r['Low.3M'] >= 1 + S.minMove && r.EMA20 > r.EMA50 && r.close >= 0.95 * r.EMA20 &&
    r.close >= 0.8 * r['High.6M'] && (r['High.1M'] - r['Low.1M']) / r['High.1M'] <= 0.35 && r.ATR / r.close >= 0.02);
  return { allUS, tradeable: tradeable.length, list: cand.map(r => [r.name, (r.description || '').slice(0, 40), Math.round((r.market_cap_basic || 0) / 1e6), r.sector || '']) };
}

// ---------- 2. price history from Yahoo ----------
let yahooErrors = 0; const codes = {};
async function history(sym) {
  const y = sym.replace(/\./g, '-');
  for (let a = 0; a < 4; a++) {
    const host = a % 2 ? 'query2' : 'query1';
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=8mo&interval=1d`, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (r.ok) { const j = await r.json(); return j.chart?.result?.[0] || null; }
      codes[r.status] = (codes[r.status] || 0) + 1;
      if (r.status === 404) return null;
    } catch { codes.net = (codes.net || 0) + 1; }
    await sleep(4000 * (a + 1));
  }
  yahooErrors++; return null;
}

// ---------- 3. analysis ----------
const ema = (c, n) => { const k = 2 / (n + 1), e = [c[0]]; for (let i = 1; i < c.length; i++) e.push(c[i] * k + e[i - 1] * (1 - k)); return e; };
const mx = (a, s, e) => { let m = -Infinity; for (let i = s; i <= e; i++) if (a[i] > m) m = a[i]; return m; };
const mn = (a, s, e) => { let m = Infinity; for (let i = s; i <= e; i++) if (a[i] < m) m = a[i]; return m; };
const avg = (a, s, e) => { let x = 0; for (let i = s; i <= e; i++) x += a[i]; return x / (e - s + 1); };
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;

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
export function analyze(d, info, frac = 1) {
  const n = d.c.length, i = n - 1; if (n < 90) return null;
  const E20 = ema(d.c, 20), E50 = ema(d.c, 50);
  const vAvg = avg(d.v, i - 20, i - 1); if (!(vAvg > 0)) return null;
  let adr = 0; for (let k = i - 20; k < i; k++) adr += d.h[k] / d.l[k] - 1; adr /= 20; if (adr < S.minADR) return null;
  const hi120 = mx(d.h, Math.max(0, i - 120), i - 1); let best = null;
  for (let L = S.minBase; L <= S.maxBase; L++) {
    const s = i - L; if (s < 62) break;
    const top = mx(d.h, s, i - 1), bot = mn(d.l, s, i - 1), rng = (top - bot) / top; if (rng > S.maxDepth) continue;
    const pre = mn(d.l, s - 60, s - 1), mv = top / pre - 1; if (mv < S.minMove) continue; if (top < 0.85 * hi120) continue;
    const hf = Math.floor(L / 2), ra = mx(d.h, s, s + hf - 1) - mn(d.l, s, s + hf - 1), rb = mx(d.h, s + hf, i - 1) - mn(d.l, s + hf, i - 1);
    if (rb > ra * 0.85) continue;                                   // getting tighter
    if (mn(d.l, s + hf, i - 1) < mn(d.l, s, s + hf - 1)) continue;  // higher lows
    if (!(E20[i - 1] > E50[i - 1] && d.c[i - 1] >= E20[i - 1] * 0.97)) continue; // trend intact
    best = { L, s, top, bot, rng, mv };
  }
  if (!best) return null;
  const { L, s, top, bot, rng, mv } = best; const c = d.c[i], vr = d.v[i] / vAvg / frac;
  const preV = avg(d.v, Math.max(0, s - 20), s - 1), dry = preV > 0 ? avg(d.v, i - 5, i - 1) / preV : 1;
  let st = null, over = false;
  if (c > top) { if (c > top * (1 + S.maxExtended)) return null; if (vr >= S.breakoutVol) st = 'breakout'; else { st = 'near'; over = true; } }
  else if (c >= top * (1 - S.nearPct)) st = 'near'; else if (c >= bot) st = 'forming'; else return null;
  const risk = st === 'breakout' ? (c - d.l[i]) / c : null;
  const tight = Math.max(0, 1 - rng / S.maxDepth), mS = Math.min(mv, 2) / 2, dS = dry < 0.7 ? 1 : dry < 1 ? 0.6 : 0.2, prox = Math.max(0, Math.min(1, 1 - ((top - c) / top) / 0.10));
  const score = Math.round(100 * (0.35 * tight + 0.25 * mS + 0.15 * dS + 0.25 * prox));
  return {
    t: info[0], nm: info[1], mc: info[2], sec: info[3], st, date: new Date(d.t[i] * 1000).toISOString().slice(0, 10),
    p: r2(c), chg: r3(c / d.c[i - 1] - 1), top: r2(top), bot: r2(bot), L, rng: r3(rng), mv: r3(mv), adr: r3(adr), vr: r2(vr), dry: r2(dry),
    entry: st === 'breakout' ? r2(c) : r2(top), stop: st === 'breakout' ? r2(d.l[i]) : null, risk: risk == null ? null : r3(risk),
    okRisk: risk == null ? null : risk <= adr, score, over, live: frac < 1,
    cl: d.c.slice(-50).map(x => Math.round(x / top * 1000)), bs: 50 - (i - s) - 1,
  };
}

// ---------- 4. push ----------
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
const pct = x => (x * 100).toFixed(1) + '%';

// ---------- run ----------
async function main() {
  const t0 = Date.now();
  const U = await universe();
  console.log(`US stocks ${U.allUS}, tradeable ${U.tradeable}, candidates ${U.list.length}`);
  const out = []; let k = 0, done = 0;
  const worker = async () => {
    while (k < U.list.length) {
      const info = U.list[k++]; const res = await history(info[0]); done++;
      if (res?.timestamp) { const x = analyze(clean(res), info, sessionFraction(res)); if (x) out.push(x); }
      await sleep(250);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const by = s => out.filter(x => x.st === s).sort((a, b) => b.score - a.score);
  const rows = [...by('breakout').slice(0, 25), ...by('near').slice(0, 25), ...by('forming').slice(0, 25)];

  let prevKeys = [];
  try { prevKeys = JSON.parse(await readFile(OUT, 'utf8')).keys || []; } catch {}
  const result = {
    ranAt: new Date().toISOString(), allUS: U.allUS, tradeable: U.tradeable, candidates: U.list.length,
    scanned: done, errors: yahooErrors, codes, seconds: Math.round((Date.now() - t0) / 1000),
    counts: { breakout: by('breakout').length, near: by('near').length, forming: by('forming').length },
    keys: rows.map(r => r.t + '|' + r.st), prevKeys, rows,
  };
  await writeFile(OUT, JSON.stringify(result));
  console.log(`Done in ${result.seconds}s: ${JSON.stringify(result.counts)}, Yahoo errors ${yahooErrors} ${JSON.stringify(codes)}`);

  // alert once per ticker+stage per day
  const today = new Date().toISOString().slice(0, 10);
  let state = { day: today, sent: [] };
  try { const s = JSON.parse(await readFile(STATE, 'utf8')); if (s.day === today) state = s; } catch {}
  const fresh = rows.filter(r => (r.st === 'breakout' || r.st === 'near' && !r.over) && !state.sent.includes(r.t + '|' + r.st));
  const bo = fresh.filter(r => r.st === 'breakout'), nr = fresh.filter(r => r.st === 'near').slice(0, 8);
  let ok = true;
  if (bo.length) {
    ok = await notify(`${bo.length} breakout${bo.length > 1 ? 's' : ''}: ${bo.slice(0, 4).map(r => r.t).join(', ')}`,
      bo.slice(0, 6).map(r => `${r.t} ${r.p} above ${r.top} · vol ×${r.vr} · stop ${r.stop} (risk ${pct(r.risk)})${r.okRisk ? '' : ' ⚠ wide stop'}`).join('\n'), 'rocket', 4) && ok;
  }
  if (nr.length) {
    ok = await notify(`Near breakout: ${nr.slice(0, 4).map(r => r.t).join(', ')}`,
      nr.map(r => `${r.t} ${r.p} → level ${r.top} (${pct((r.top - r.p) / r.top)} away) · ${r.L}-day base`).join('\n'), 'eyes', 3) && ok;
  }
  if (U.list.length > 50 && yahooErrors > U.list.length * 0.5) {
    await notify('Base Watch scan problem', `Price data failed for ${yahooErrors} of ${U.list.length} stocks ${JSON.stringify(codes)}. Results may be incomplete.`, 'warning', 3);
  }
  if (ok) state.sent.push(...fresh.map(r => r.t + '|' + r.st));
  await writeFile(STATE, JSON.stringify(state));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async e => { console.error(e); await notify('Base Watch scan failed', String(e.message || e), 'warning', 3); process.exit(1); });
}
