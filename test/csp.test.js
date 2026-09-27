'use strict';
// Unit tests for every function exported by public/csp.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const CSP = require('../public/csp');

const DAY = 86400;
const utc = (...a) => Date.UTC(...a) / 1000;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

test('exports every documented function', () => {
  for (const k of ['easternOffset', 'expiryClose', 'daysToExpiry', 'earningsOf', 'round', 'normCdf', 'bsPut', 'impliedVol',
    'premiumOf', 'evaluatePut', 'scorePut', 'eligible', 'pickProfiles', 'payoff', 'lognormalPdf', 'sma', 'smaSeries',
    'histVol', 'rsi', 'contractsFor', 'scenarioRows', 'bestForExpiry', 'filterIdeas']) {
    assert.equal(typeof CSP[k], 'function', k);
  }
});

// ---------- time ----------
test('easternOffset follows US daylight-saving rules', () => {
  assert.equal(CSP.easternOffset(utc(2026, 0, 15, 12)), -5); // January
  assert.equal(CSP.easternOffset(utc(2026, 6, 15, 12)), -4); // July
  // 2026: DST starts Sun Mar 8 07:00 UTC, ends Sun Nov 1 06:00 UTC.
  assert.equal(CSP.easternOffset(utc(2026, 2, 8, 6, 59)), -5);
  assert.equal(CSP.easternOffset(utc(2026, 2, 8, 7, 0)), -4);
  assert.equal(CSP.easternOffset(utc(2026, 10, 1, 5, 59)), -4);
  assert.equal(CSP.easternOffset(utc(2026, 10, 1, 6, 0)), -5);
});

test('expiryClose moves Yahoo midnight-UTC stamps to 4pm New York', () => {
  assert.equal(CSP.expiryClose(utc(2026, 8, 28)), utc(2026, 8, 28, 20)); // EDT
  assert.equal(CSP.expiryClose(utc(2026, 11, 18)), utc(2026, 11, 18, 21)); // EST
  assert.equal(CSP.expiryClose(utc(2026, 11, 18, 5)), utc(2026, 11, 18, 21), 'any time on the date maps to that close');
});

test('daysToExpiry counts to the close, not to midnight', () => {
  const fri = utc(2026, 9, 2); // Fri Oct 2 2026
  const monOpen = utc(2026, 8, 28, 13, 30); // Mon 9:30am ET
  near(CSP.daysToExpiry(fri, monOpen), 4 + 6.5 / 24, 1e-9);
  assert.ok(CSP.daysToExpiry(fri, monOpen) > (fri - monOpen) / DAY);
});

test('earningsOf picks the earliest future timestamp', () => {
  const now = 1000;
  assert.equal(CSP.earningsOf({ earningsTimestampStart: 500, earningsTimestamp: 2000 }, now), 2000, 'past window start ignored');
  assert.equal(CSP.earningsOf({ earningsTimestampStart: 1500, earningsTimestamp: 2000 }, now), 1500);
  assert.equal(CSP.earningsOf({ earningsTimestamp: 900 }, now), null);
  assert.equal(CSP.earningsOf({}, now), null);
  assert.equal(CSP.earningsOf(null, now), null);
});

test('round trims float noise and passes through null/NaN', () => {
  assert.equal(CSP.round(2.2800000000000002), 2.28);
  assert.equal(CSP.round(1.23456, 2), 1.23);
  assert.equal(CSP.round(null), null);
  assert.ok(Number.isNaN(CSP.round(NaN)));
});

// ---------- pricing ----------
test('normCdf matches known values and is symmetric', () => {
  near(CSP.normCdf(0), 0.5, 1e-7);
  near(CSP.normCdf(1.96), 0.975, 1e-4);
  near(CSP.normCdf(-1), 0.158655, 1e-5);
  for (const x of [0.3, 1.1, 2.7]) near(CSP.normCdf(x) + CSP.normCdf(-x), 1, 1e-7);
});

test('bsPut satisfies put-call parity bounds and edge cases', () => {
  const p = CSP.bsPut(100, 100, 0.25, 0.04, 0.3);
  near(p, 5.44, 0.05, 'ATM 3m put'); // textbook value
  assert.equal(CSP.bsPut(100, 90, 0, 0.04, 0.3), 0, 'expired OTM');
  assert.equal(CSP.bsPut(80, 90, 0, 0.04, 0.3), 10, 'expired ITM');
  assert.ok(CSP.bsPut(100, 95, 0.1, 0.04, 0.5) > CSP.bsPut(100, 95, 0.1, 0.04, 0.2), 'vega > 0');
});

test('impliedVol inverts bsPut and rejects impossible prices', () => {
  for (const iv of [0.08, 0.3, 1.2]) {
    const price = CSP.bsPut(100, 95, 30 / 365, 0.04, iv);
    near(CSP.impliedVol(price, 100, 95, 30 / 365, 0.04), iv, 1e-4, `iv ${iv}`);
  }
  assert.equal(CSP.impliedVol(0, 100, 95, 0.1, 0.04), null);
  assert.equal(CSP.impliedVol(200, 100, 95, 0.1, 0.04), null);
  assert.equal(CSP.impliedVol(1, 100, 95, 0, 0.04), null);
  assert.equal(CSP.impliedVol(4.5, 90, 95, 0.1, 0.04), null, 'below the discounted-intrinsic bound');
});

test('premiumOf: mid, no-bid, stale last trade', () => {
  assert.deepEqual(CSP.premiumOf({ bid: 1, ask: 1.2, last: 5 }), { premium: 1.1, stale: false, noBid: false });
  assert.deepEqual(CSP.premiumOf({ bid: 0, ask: 0.3, last: 0.8 }), { premium: 0, stale: false, noBid: true });
  assert.deepEqual(CSP.premiumOf({ bid: 0, ask: 0, last: 0.8 }), { premium: 0.8, stale: true, noBid: false });
  assert.deepEqual(CSP.premiumOf({ bid: 0, ask: 0, last: 0 }), { premium: 0, stale: true, noBid: false });
  assert.equal(CSP.premiumOf({ bid: 1.2, ask: 1.0, last: 0.9 }).stale, true, 'crossed quote is not trusted');
});

function evalAt({ strike = 95, bid = 1.9, ask = 2.1, last = 2, days = 30, ...ctx } = {}) {
  const now = utc(2026, 8, 1, 14);
  const expiration = utc(2026, 8, 1) + days * DAY;
  return CSP.evaluatePut(
    { contract: 'X', strike, bid, ask, last, openInterest: 500, volume: 10 },
    { spot: 100, now, expiration, ...ctx },
  );
}

test('evaluatePut computes CSP economics', () => {
  const c = evalAt();
  assert.equal(c.premium, 2);
  assert.equal(c.credit, 200);
  assert.equal(c.collateral, 9500);
  assert.equal(c.netCost, 9300);
  assert.equal(c.breakeven, 93);
  near(c.roc, 2 / 95, 1e-6);
  near(c.annualized, (2 / 95) * 365 / c.dte, c.annualized * 0.01, 'uses the unrounded DTE');
  near(c.dte, 30 + 6 / 24, 0.06, 'counted to the 4pm ET close');
  assert.ok(c.delta < 0 && c.delta > -0.5);
  assert.ok(c.pop > 0.5 && c.pop < 1);
  near(c.probAssign, 1 - c.pop, 1e-6);
  assert.ok(c.probProfit > c.pop, 'any profit (above breakeven) is likelier than keeping everything');
  near(c.discount, 0.07, 1e-9);
  near(c.otmPct, 0.05, 1e-9);
  near(c.spreadPct, 0.1, 1e-9);
  assert.equal(c.ivSource, 'premium');
  near(c.expectedMove, 100 * c.iv * Math.sqrt(c.dte / 365), 0.02);
  assert.equal(String(c.premium).length <= 6, true, 'no float noise');
});

test('evaluatePut falls back to Yahoo IV, then context IV, when premium gives none', () => {
  const now = utc(2026, 8, 1, 14);
  const base = { spot: 100, now, expiration: utc(2026, 9, 1) };
  const noQuote = { strike: 95, bid: 0, ask: 0, last: 0, openInterest: 0, volume: 0 };
  const a = CSP.evaluatePut({ ...noQuote, yahooIv: 0.44 }, base);
  assert.equal(a.ivSource, 'fallback');
  assert.equal(a.iv, 0.44);
  const b = CSP.evaluatePut({ ...noQuote, yahooIv: 0.00001 }, { ...base, fallbackIv: 0.27 });
  assert.equal(b.iv, 0.27, 'garbage Yahoo IV ignored');
  assert.ok(Number.isFinite(b.delta) && Number.isFinite(b.pop));
});

test('evaluatePut never returns non-finite numbers, even at expiry', () => {
  const now = utc(2026, 8, 1, 19, 59);
  const c = CSP.evaluatePut({ strike: 99, bid: 0.05, ask: 0.1, last: 0.05, openInterest: 1, volume: 1 },
    { spot: 100, now, expiration: utc(2026, 8, 1) });
  for (const [k, v] of Object.entries(c)) if (typeof v === 'number') assert.ok(Number.isFinite(v), k);
  assert.equal(c.dte, 0.3, 'clamped to a quarter-day floor');
});

test('earnings before the expiry close is flagged; after close or in the past is not', () => {
  const exp = utc(2026, 9, 1); // close = 20:00 UTC Oct 1
  const now = utc(2026, 8, 1, 14);
  const at = (earningsTs) => evalAt({ days: 30, earningsTs }).earningsBefore;
  assert.equal(at(now + 10 * DAY), true);
  assert.equal(at(exp + 13 * 3600), true, 'morning of expiry day');
  assert.equal(at(exp + 21 * 3600), false, 'after the final close');
  assert.equal(at(now - DAY), false);
  assert.equal(at(null), false);
});

test('payoff: keep premium above strike, lose below breakeven', () => {
  assert.equal(CSP.payoff(95, 2, 120), 200);
  assert.equal(CSP.payoff(95, 2, 95), 200);
  assert.equal(CSP.payoff(95, 2, 93), 0);
  assert.equal(CSP.payoff(95, 2, 85), -800);
  assert.equal(CSP.payoff(95, 2, 0), -9300);
});

test('lognormalPdf integrates to ~1 and is zero at non-positive prices', () => {
  let area = 0;
  const S = 100, T = 30 / 365, iv = 0.3;
  for (let x = 1; x < 300; x += 0.05) area += CSP.lognormalPdf(x, S, T, 0.04, iv) * 0.05;
  near(area, 1, 1e-3);
  assert.equal(CSP.lognormalPdf(0, S, T, 0.04, iv), 0);
  assert.equal(CSP.lognormalPdf(-5, S, T, 0.04, iv), 0);
});

// ---------- scoring ----------
const baseScore = { annualized: 0.25, pop: 0.75, discount: 0.06, spreadPct: 0.05, openInterest: 3000, dte: 30, delta: -0.22, earningsBefore: false, stale: false };

test('scorePut prefers the 0.15-0.30 delta, 20-50 DTE zone and applies penalties', () => {
  const s = CSP.scorePut(baseScore);
  assert.ok(s > CSP.scorePut({ ...baseScore, delta: -0.44 }));
  assert.ok(s > CSP.scorePut({ ...baseScore, delta: -0.06 }));
  assert.ok(s > CSP.scorePut({ ...baseScore, dte: 5 }));
  assert.ok(s > CSP.scorePut({ ...baseScore, dte: 85 }));
  assert.ok(s > CSP.scorePut({ ...baseScore, spreadPct: 0.4 }));
  assert.ok(s > CSP.scorePut({ ...baseScore, openInterest: 3 }));
  assert.equal(CSP.scorePut({ ...baseScore, earningsBefore: true }), s - 8);
  assert.equal(CSP.scorePut({ ...baseScore, stale: true }), s - 5);
  assert.ok(CSP.scorePut({ ...baseScore, annualized: 0.05 }) < s - 10);
  assert.ok(s >= 0 && s <= 100 && Number.isInteger(s));
  assert.equal(CSP.scorePut({ ...baseScore, annualized: 0, delta: -0.9, pop: 0, discount: -1, openInterest: 0, dte: 200, earningsBefore: true, stale: true }), 0);
});

test('eligible excludes ITM, no-bid, tiny premium and extreme deltas', () => {
  const ok = { strike: 95, spot: 100, premium: 1, delta: -0.2, annualized: 0.2, noBid: false };
  assert.equal(CSP.eligible(ok), true);
  assert.equal(CSP.eligible({ ...ok, strike: 101 }), false);
  assert.equal(CSP.eligible({ ...ok, noBid: true }), false);
  assert.equal(CSP.eligible({ ...ok, premium: 0.02 }), false);
  assert.equal(CSP.eligible({ ...ok, delta: -0.6 }), false);
  assert.equal(CSP.eligible({ ...ok, delta: -0.01 }), false);
  assert.equal(CSP.eligible({ ...ok, annualized: 0.01 }), false);
});

test('pickProfiles: balanced is top score among 14+ DTE; conservative/aggressive by delta', () => {
  const mk = (delta, dte, score) => ({ delta, dte, score });
  const cands = [mk(-0.25, 5, 99), mk(-0.14, 30, 60), mk(-0.22, 30, 80), mk(-0.34, 30, 70), mk(-0.3, 21, 75)];
  const p = CSP.pickProfiles(cands);
  assert.equal(p.balanced.score, 80, 'the 5-DTE weekly does not win balanced');
  assert.equal(p.conservative.delta, -0.14);
  assert.equal(p.aggressive.delta, -0.34);
  assert.equal(CSP.pickProfiles([mk(-0.2, 5, 50)]).balanced.dte, 5, 'weeklies used when nothing else exists');
  assert.deepEqual(CSP.pickProfiles([]), {});
});

// ---------- indicators ----------
test('sma / smaSeries', () => {
  assert.equal(CSP.sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(CSP.sma([1], 5), null);
  assert.deepEqual(CSP.smaSeries([1, 2, 3], 2), [null, 1.5, 2.5]);
  assert.deepEqual(CSP.smaSeries([], 3), []);
});

test('histVol: zero for flat, ~input vol for a known series, null for bad data', () => {
  assert.equal(CSP.histVol(Array(40).fill(10), 30), 0);
  const alt = [100];
  for (let i = 0; i < 60; i++) alt.push(alt[i] * Math.exp(i % 2 ? 0.01 : -0.01));
  near(CSP.histVol(alt, 30), 0.01 * Math.sqrt(252) * Math.sqrt(30 / 29), 1e-3);
  assert.equal(CSP.histVol([1, 2], 30), null);
  assert.equal(CSP.histVol([...Array(40).fill(10), 0], 30), null, 'zero close would give -Infinity log return');
});

test('rsi: rising 100, falling 0, flat 50', () => {
  assert.equal(CSP.rsi(Array.from({ length: 30 }, (_, i) => i + 1)), 100);
  assert.equal(CSP.rsi(Array.from({ length: 30 }, (_, i) => 30 - i)), 0);
  assert.equal(CSP.rsi(Array(30).fill(5)), 50);
  assert.equal(CSP.rsi([1, 2, 3]), null);
});

// ---------- UI decisions ----------
test('contractsFor sizes positions from cash', () => {
  assert.deepEqual(CSP.contractsFor(null, 9500), { n: 1, affordable: null });
  assert.deepEqual(CSP.contractsFor(20000, 9500), { n: 2, affordable: true });
  assert.deepEqual(CSP.contractsFor(9500, 9500), { n: 1, affordable: true });
  assert.deepEqual(CSP.contractsFor(5000, 9500), { n: 1, affordable: false });
  assert.deepEqual(CSP.contractsFor(-5, 9500), { n: 1, affordable: null });
});

test('scenarioRows: sorted, deduped, correct P/L', () => {
  const rows = CSP.scenarioRows(100, 95, 2, 2);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].price > rows[i].price);
  const be = rows.find((r) => r.label === 'breakeven');
  assert.equal(be.price, 93);
  assert.equal(be.pl, 0);
  assert.equal(rows.find((r) => r.label === '+10%').pl, 400);
  assert.equal(rows.find((r) => r.label === '-10%').pl, (2 - 5) * 200);
  assert.equal(rows.find((r) => r.label === '-10%').assigned, true);
  near(rows.find((r) => r.label === '+10%').ret, 400 / 19000, 1e-12);
  // strike exactly 5% below spot collides with the "-5%" row: only one survives
  assert.equal(rows.filter((r) => Math.abs(r.price - 95) < 1e-9).length, 1);
});

test('bestForExpiry never returns a contract from another expiry', () => {
  const c = (expiration, strike, eligible, score, delta, premium = 1) => ({ expiration, strike, spot: 100, eligible, score, delta, premium });
  const cands = [c(1, 95, true, 70, -0.2), c(1, 90, true, 80, -0.12), c(2, 97, false, null, -0.4), c(2, 92, false, null, -0.18), c(2, 101, false, null, -0.55)];
  assert.equal(CSP.bestForExpiry(cands, 1).strike, 90);
  assert.equal(CSP.bestForExpiry(cands, 2).strike, 92, 'no eligible: OTM put nearest 0.20 delta');
  assert.equal(CSP.bestForExpiry(cands, 3), null);
});

test('filterIdeas applies budget, trend and earnings filters with a safer fallback', () => {
  const put = (collateral, earningsBefore = false) => ({ collateral, earningsBefore });
  const rows = [
    { symbol: 'A', trend: 'up', best: put(50000), safer: put(40000) },
    { symbol: 'B', trend: 'down', best: put(9000), safer: put(8000) },
    { symbol: 'C', trend: 'up', best: put(9000, true), safer: put(8000) },
    { symbol: 'D', trend: 'up', best: put(9000, true), safer: put(8000, true) },
  ];
  assert.equal(CSP.filterIdeas(rows).length, 4);
  assert.deepEqual(CSP.filterIdeas(rows, { budget: 10000 }).map((r) => r.symbol), ['B', 'C', 'D']);
  assert.deepEqual(CSP.filterIdeas(rows, { budget: 45000 }).map((r) => [r.symbol, r.pick.collateral]), [['A', 40000], ['B', 9000], ['C', 9000], ['D', 9000]]);
  assert.deepEqual(CSP.filterIdeas(rows, { uptrendOnly: true }).map((r) => r.symbol), ['A', 'C', 'D']);
  const noE = CSP.filterIdeas(rows, { noEarnings: true });
  assert.deepEqual(noE.map((r) => r.symbol), ['A', 'B', 'C']);
  assert.equal(noE.find((r) => r.symbol === 'C').pick.collateral, 8000, 'switched to the earnings-free safer strike');
});
