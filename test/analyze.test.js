'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, cleanSymbol, pickExpirations } = require('../src/analyze');
const { scan, targetExpiry, mapLimit, resetCache } = require('../src/scan');
const CSP = require('../public/csp');
const yahoo = require('../src/yahoo');
const { yahooMock, NOW, DAY } = require('./helpers');

test.beforeEach(() => { yahoo.resetSession(); resetCache(); });

function nonFinite(obj) {
  const bad = [];
  (function walk(v, k) {
    if (typeof v === 'number' && !Number.isFinite(v)) bad.push(k);
    else if (v && typeof v === 'object') for (const [a, b] of Object.entries(v)) walk(b, `${k}.${a}`);
  })(obj, '');
  return bad;
}

test('cleanSymbol validates input', () => {
  assert.equal(cleanSymbol(' aapl '), 'AAPL');
  assert.equal(cleanSymbol('brk-b'), 'BRK-B');
  assert.throws(() => cleanSymbol(''), /Enter a ticker/);
  assert.throws(() => cleanSymbol('<script>'), /not a valid ticker/);
});

test('pickExpirations keeps the 4-60 DTE window', () => {
  const exps = [1, 3, 10, 30, 45, 61, 90].map((d) => NOW + d * DAY);
  assert.deepEqual(pickExpirations(exps, NOW).map((e) => (e - NOW) / DAY), [10, 30, 45]);
  const many = Array.from({ length: 20 }, (_, i) => NOW + (5 + i * 2.5) * DAY);
  const picked = pickExpirations(many, NOW);
  assert.ok(picked.length >= 6 && picked.length <= 7);
  assert.ok(picked.some((e) => Math.abs((e - NOW) / DAY - 30) <= 1.25), 'keeps the ~30 DTE expiry');
});

test('analyze returns profiles, candidates, history and a verdict', async () => {
  const m = yahooMock({ spot: 100 });
  const r = await analyze('test', { now: NOW, fetchImpl: m.fetchImpl });
  assert.equal(r.symbol, 'TEST');
  assert.equal(r.price, 100);
  assert.deepEqual(r.expirations.map((e) => e.dte), [7, 21, 35]); // 70 DTE is outside the window
  assert.ok(r.candidates.length > 20);
  const b = r.profiles.balanced;
  assert.ok(b && b.strike < 100 && b.dte >= 14);
  assert.ok(-b.delta >= 0.1 && -b.delta <= 0.4);
  assert.ok(r.profiles.conservative.delta > r.profiles.aggressive.delta);
  assert.ok(Math.abs(b.iv - 0.3) < 0.03, 'IV is recovered from the premium');
  assert.equal(r.history.dates.length, 260);
  assert.ok(r.history.sma200.every((v) => v != null), '2y fetch means the 200d line spans the whole chart');
  assert.match(r.analysis.summary, /sell the .* \$\d+ put/);
  assert.ok(['A', 'B', 'C', 'D'].includes(r.analysis.grade));
});

test('analyze flags earnings inside the trade window', async () => {
  const m = yahooMock({ spot: 100, quote: { earningsTimestamp: NOW + 10 * DAY } });
  const r = await analyze('TEST', { now: NOW, fetchImpl: m.fetchImpl });
  assert.ok(r.candidates.filter((c) => c.expiration > NOW + 10 * DAY).every((c) => c.earningsBefore));
  assert.ok(r.candidates.filter((c) => c.expiration < NOW + 9 * DAY).every((c) => !c.earningsBefore));
});

test('analyze errors: unknown symbol 404, no options 422', async () => {
  await assert.rejects(analyze('ZZZZ', { now: NOW, fetchImpl: yahooMock({ unknown: true }).fetchImpl }), (e) => e.status === 404);
  await assert.rejects(analyze('ZZZZ', { now: NOW, fetchImpl: yahooMock({ noOptions: true }).fetchImpl }), (e) => e.status === 422);
});

test('an expired crumb (401) is refreshed once and the request succeeds', async () => {
  const m = yahooMock({ crumbFailsOnce: true });
  const r = await analyze('TEST', { now: NOW, fetchImpl: m.fetchImpl });
  assert.equal(r.symbol, 'TEST');
  assert.equal(m.calls.filter((u) => u.includes('getcrumb')).length, 2);
});

test('analyze output never contains NaN/Infinity', async () => {
  const r = await analyze('TEST', { now: NOW, fetchImpl: yahooMock({ spot: 37.5 }).fetchImpl });
  assert.deepEqual(nonFinite(r), []);
});

test('analyze DTE counts to the 4pm ET close', async () => {
  const r = await analyze('TEST', { now: NOW, fetchImpl: yahooMock().fetchImpl });
  for (const c of r.candidates) assert.ok(Math.abs(c.dte - CSP.daysToExpiry(c.expiration, NOW)) < 0.051);
});

test('BRK.B is retried as BRK-B', async () => {
  const m = yahooMock({ only: ['BRK-B'] });
  const r = await analyze('brk.b', { now: NOW, fetchImpl: m.fetchImpl });
  assert.equal(r.symbol, 'BRK-B');
  await assert.rejects(analyze('VOD.LX', { now: NOW, fetchImpl: yahooMock({ only: [] }).fetchImpl }), (e) => e.status === 404);
});

test('adjusted (non-100-share) contracts are dropped', async () => {
  const odd = { contractSymbol: 'TEST1ADJ', strike: 92.3, bid: 1, ask: 1.1, lastPrice: 1, volume: 5, openInterest: 50, impliedVolatility: 0.3, contractSize: 'ADJUSTED' };
  const r = await analyze('TEST', { now: NOW, fetchImpl: yahooMock({ extraPuts: [odd] }).fetchImpl });
  assert.equal(r.candidates.some((c) => c.contract === 'TEST1ADJ'), false);
});

test('earnings: a past window start does not hide a future point estimate', async () => {
  const m = yahooMock({ quote: { earningsTimestampStart: NOW - 5 * DAY, earningsTimestamp: NOW + 10 * DAY } });
  const r = await analyze('TEST', { now: NOW, fetchImpl: m.fetchImpl });
  assert.equal(r.stats.earningsTs, NOW + 10 * DAY);
  assert.equal(r.stats.daysToEarnings, 10);
});

test('concurrent scans share one Yahoo sweep; fresh=1 respects a 20s floor', async () => {
  const m = yahooMock({ spot: 50, expDays: [9, 30, 44], delayMs: 20 });
  const opts = { now: NOW, fetchImpl: m.fetchImpl, universe: ['AAA', 'BBB'] };
  const [a, b] = await Promise.all([scan(opts), scan(opts)]);
  assert.equal(a, b, 'same result object');
  const optionCalls = () => m.calls.filter((u) => u.includes('/options/')).length;
  const n = optionCalls();
  assert.equal(n, 4, '2 symbols x 2 chain calls, not doubled');
  await scan({ ...opts, fresh: true });
  assert.equal(optionCalls(), n, 'fresh within 20s is served from cache');
});

test('targetExpiry picks the expiry closest to 30 DTE within 14-50', () => {
  const e = [5, 12, 26, 33, 60].map((d) => NOW + d * DAY);
  assert.equal((targetExpiry(e, NOW) - NOW) / DAY, 33);
  assert.equal(targetExpiry([NOW + 5 * DAY, NOW + 90 * DAY], NOW), null);
});

test('mapLimit keeps order and swallows per-item failures', async () => {
  const out = await mapLimit([1, 2, 3, 4], 2, async (x) => { if (x === 3) throw new Error('x'); return x * 10; });
  assert.deepEqual(out, [10, 20, null, 40]);
});

test('scan ranks rows around a ~30 DTE expiry', async () => {
  const m = yahooMock({ spot: 50, expDays: [9, 30, 44] });
  const r = await scan({ now: NOW, fetchImpl: m.fetchImpl, universe: ['AAA', 'BBB'], useCache: false });
  assert.equal(r.found, 2);
  assert.ok(r.rows[0].rank >= r.rows[1].rank);
  const b = r.rows[0].best;
  assert.equal(Math.round(b.dte), 30);
  assert.equal(b.collateral, b.strike * 100);
  assert.equal(r.rows[0].trend, 'up');
});

test('scan with nothing reachable is a 502', async () => {
  await assert.rejects(
    scan({ now: NOW, fetchImpl: yahooMock({ unknown: true }).fetchImpl, universe: ['AAA'], useCache: false }),
    (e) => e.status === 502,
  );
});
