'use strict';
// "Best CSP ideas right now": scan a universe of liquid, optionable US names, find each
// one's best ~30-DTE put, and rank them by trade quality + stock quality.
const yahoo = require('./yahoo');
const CSP = require('../public/csp');


const UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'AVGO', 'NFLX',
  'ORCL', 'CRM', 'ADBE', 'INTC', 'QCOM', 'MU', 'PLTR', 'UBER', 'SHOP', 'PYPL',
  'JPM', 'BAC', 'WFC', 'C', 'GS', 'V', 'MA', 'SCHW', 'SOFI',
  'KO', 'PEP', 'WMT', 'COST', 'HD', 'MCD', 'NKE', 'SBUX', 'DIS', 'TGT',
  'XOM', 'CVX', 'OXY', 'PFE', 'MRK', 'ABBV', 'JNJ', 'UNH', 'LLY',
  'T', 'VZ', 'F', 'GM', 'BA', 'CAT',
  'SPY', 'QQQ', 'IWM',
];

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Expiry closest to `target` DTE inside [min, max]. */
function targetExpiry(expirations, now, target = 30, min = 14, max = 50) {
  let best = null;
  for (const e of expirations) {
    const dte = CSP.daysToExpiry(e, now);
    if (dte < min || dte > max) continue;
    if (best == null || Math.abs(dte - target) < Math.abs(CSP.daysToExpiry(best, now) - target)) best = e;
  }
  return best;
}

/** Stock-quality tilt from quote fields only (keeps the scan to 2 requests per name). */
function stockTilt(q) {
  const spot = q.regularMarketPrice;
  const s50 = q.fiftyDayAverage;
  const s200 = q.twoHundredDayAverage;
  let pts = 0;
  let trend = 'mixed';
  if (s50 && s200) {
    if (spot > s50 && s50 > s200) { pts += 10; trend = 'up'; }
    else if (spot > s200) { pts += 4; trend = 'above 200d'; }
    else if (spot < s50 && s50 < s200) { pts -= 12; trend = 'down'; }
    else { pts -= 4; trend = 'below 200d'; }
  }
  if (q.marketCap >= 200e9) pts += 4;
  else if (q.marketCap && q.marketCap < 10e9) pts -= 4;
  return { pts, trend };
}

async function scanOne(symbol, { now, fetchImpl }) {
  const opts = fetchImpl ? { fetchImpl } : {};
  const first = await yahoo.fetchChain(symbol, null, opts);
  if (!first) return null;
  const exp = targetExpiry(first.expirations, now);
  if (!exp) return null;
  const chain = exp === first.expiration ? first : await yahoo.fetchChain(symbol, exp, opts);
  if (!chain || !chain.expiration) return null;
  const q = chain.quote;
  const spot = q.regularMarketPrice;
  if (!(spot > 0)) return null;
  const earningsTs = CSP.earningsOf(q, now);
  const ctx = { spot, now, expiration: chain.expiration, earningsTs, fallbackIv: 0.35 };
  const cands = chain.puts
    .filter((p) => p.strike < spot && p.strike > spot * 0.6)
    .map((p) => CSP.evaluatePut(p, ctx))
    .filter(CSP.eligible);
  if (!cands.length) return null;
  cands.forEach((c) => { c.score = CSP.scorePut(c); });
  const { balanced, conservative } = CSP.pickProfiles(cands);
  const tilt = stockTilt(q);
  const rank = Math.max(0, Math.min(100, Math.round(balanced.score * 0.85 + 5 + tilt.pts)));
  const trim = (c) => ({
    strike: c.strike, expiration: c.expiration, dte: c.dte, premium: c.premium, credit: c.credit,
    collateral: c.collateral, breakeven: c.breakeven, discount: c.discount, roc: c.roc,
    annualized: c.annualized, pop: c.pop, delta: c.delta, iv: c.iv, openInterest: c.openInterest,
    spreadPct: c.spreadPct, stale: c.stale, earningsBefore: c.earningsBefore, score: c.score,
  });
  return {
    symbol,
    name: q.shortName || q.longName || symbol,
    price: spot,
    changePct: q.regularMarketChangePercent ?? null,
    marketCap: q.marketCap ?? null,
    trend: tilt.trend,
    rank,
    best: trim(balanced),
    safer: trim(conservative),
  };
}

let cache = null; // { at, result }
let inflight = null; // one shared scan while it runs, so concurrent visitors don't multiply Yahoo calls
const CACHE_MS = 90 * 1000;
const MIN_FRESH_MS = 20 * 1000; // "Rescan" can't hammer Yahoo more often than this

async function runScan({ now, fetchImpl, universe }) {
  const rows = (await mapLimit(universe, 8, (s) => scanOne(s, { now, fetchImpl }))).filter(Boolean);
  if (!rows.length) {
    const e = new Error('Could not reach Yahoo Finance for option data. Try again in a moment.');
    e.status = 502;
    throw e;
  }
  rows.sort((a, b) => b.rank - a.rank || a.symbol.localeCompare(b.symbol));
  return { asOf: now, scanned: universe.length, found: rows.length, rows };
}

async function scan({ now, fetchImpl, universe = UNIVERSE, useCache = true, fresh = false } = {}) {
  if (!useCache) return runScan({ now: now ?? Math.floor(Date.now() / 1000), fetchImpl, universe });
  const age = cache ? Date.now() - cache.at : Infinity;
  if (age < (fresh ? MIN_FRESH_MS : CACHE_MS)) return cache.result;
  if (!inflight) {
    inflight = runScan({ now: now ?? Math.floor(Date.now() / 1000), fetchImpl, universe })
      .then((result) => { cache = { at: Date.now(), result }; return result; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

function resetCache() { cache = null; inflight = null; }

module.exports = { scan, scanOne, targetExpiry, stockTilt, mapLimit, resetCache, UNIVERSE };
