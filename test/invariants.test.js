'use strict';
// Property tests: thousands of random puts (incl. closed markets, crossed and garbage quotes)
// must always produce finite, internally consistent numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const CSP = require('../public/csp');
const { analyze } = require('../src/analyze');
const yahoo = require('../src/yahoo');
const { yahooMock, NOW, DAY } = require('./helpers');

function rng(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

test('evaluatePut invariants hold for 20,000 random contracts', () => {
  const rnd = rng(42);
  for (let i = 0; i < 20000; i++) {
    const S = 1 + rnd() * 900;
    const K = S * (0.6 + rnd() * 0.5);
    const expiration = Math.floor((NOW + (1 + rnd() * 70) * DAY) / DAY) * DAY;
    const fair = CSP.bsPut(S, K, CSP.daysToExpiry(expiration, NOW) / 365, 0.04, 0.05 + rnd() * 1.5);
    const q = { contract: 'x', strike: K, bid: fair * 0.97, ask: fair * 1.03, last: fair, openInterest: Math.floor(rnd() * 5000), volume: 1 };
    const mode = rnd();
    if (mode < 0.05) { q.bid = 0; q.ask = 0; } // closed market
    else if (mode < 0.1) { [q.bid, q.ask] = [q.ask, q.bid]; } // crossed
    else if (mode < 0.15) q.bid = 0; // no bid
    else if (mode < 0.2) { q.bid = 0; q.ask = 0; q.last = K * (1 + rnd()); } // garbage print
    const c = CSP.evaluatePut(q, { spot: S, expiration, now: NOW, fallbackIv: 0.3, earningsTs: NOW + rnd() * 90 * DAY });
    const where = `#${i} S=${S} K=${K} bid=${q.bid} ask=${q.ask} last=${q.last}`;
    for (const [k, v] of Object.entries(c)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} not finite ${where}`);
    assert.ok(c.premium >= 0 && c.premium < K, `premium ${where}`);
    assert.ok(c.breakeven > 0 && c.netCost > 0, `breakeven/net cost ${where}`);
    assert.ok(c.pop >= 0 && c.pop <= 1 && c.delta <= 0 && c.delta >= -1, `probabilities ${where}`);
    if (c.premium > 0) assert.ok(Math.abs(CSP.payoff(K, c.premium, c.breakeven)) < 0.02, `breakeven P/L ${where}`);
    else assert.equal(c.probProfit, 0, `nothing to gain without premium ${where}`);
    assert.ok(Math.abs(CSP.payoff(K, c.premium, K * 10) - c.credit) < 0.01, `max profit is the credit ${where}`);
    if (CSP.eligible(c)) {
      assert.ok(c.strike < c.spot && !c.noBid && !c.badQuote, `eligible filter ${where}`);
      const sc = CSP.scorePut(c);
      assert.ok(Number.isInteger(sc) && sc >= 0 && sc <= 100, `score ${where}`);
    }
  }
});

test('lognormalPdf is 0, not NaN, with no time or no vol', () => {
  assert.equal(CSP.lognormalPdf(100, 100, 0, 0.04, 0.3), 0);
  assert.equal(CSP.lognormalPdf(100, 100, 0.1, 0.04, 0), 0);
});

test('premiumOf takes the bid when there is no ask', () => {
  assert.deepEqual(CSP.premiumOf({ bid: 0.8, ask: 0, last: 0.5 }), { premium: 0.8, stale: false, noBid: false });
});

test('analyze: a bad print is never recommended; no tradeable put means grade D', async () => {
  yahoo.resetSession();
  const g = await analyze('TEST', { now: NOW, fetchImpl: yahooMock({ extraPuts: [{ contractSymbol: 'G1', strike: 96, bid: 0, ask: 0, lastPrice: 180, volume: 0, openInterest: 5 }] }).fetchImpl });
  const bad = g.candidates.find((c) => c.contract === 'G1');
  assert.ok(bad && bad.badQuote && !bad.eligible && bad.breakeven > 0);
  yahoo.resetSession();
  const p = await analyze('TEST', { now: NOW, fetchImpl: yahooMock({ spot: 0.8 }).fetchImpl });
  assert.equal(p.profiles.balanced, undefined);
  assert.equal(p.analysis.grade, 'D');
});
