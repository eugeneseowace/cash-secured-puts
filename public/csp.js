// Cash-secured put maths, shared by the browser, the server and the tests (UMD).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RISK_FREE = 0.04;
  const DAY = 86400;

  /**
   * US Eastern offset from UTC in hours at unix time `ts` (-4 in daylight time, -5 otherwise).
   * DST runs from 2am on the 2nd Sunday of March to 2am on the 1st Sunday of November.
   */
  function easternOffset(ts) {
    const y = new Date(ts * 1000).getUTCFullYear();
    const nthSunday = (month, n) => {
      const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
      return 1 + ((7 - first) % 7) + 7 * (n - 1);
    };
    const start = Date.UTC(y, 2, nthSunday(2, 2), 7); // 2am EST = 07:00 UTC
    const end = Date.UTC(y, 10, nthSunday(10, 1), 6); // 2am EDT = 06:00 UTC
    const ms = ts * 1000;
    return ms >= start && ms < end ? -4 : -5;
  }

  /**
   * Yahoo stamps an expiry as 00:00 UTC of the expiry date; the option really stops trading
   * at 16:00 New York time that day. Returns that close as unix seconds.
   */
  function expiryClose(expiration) {
    const midnight = Math.floor(expiration / DAY) * DAY;
    return midnight + (16 - easternOffset(midnight + 12 * 3600)) * 3600;
  }

  /** Days (fractional) from `now` to the 4pm ET close on the expiry date. */
  function daysToExpiry(expiration, now) {
    return (expiryClose(expiration) - now) / DAY;
  }

  /**
   * Next earnings date from a Yahoo quote. Yahoo gives a window (start/end) and a point
   * estimate that can disagree; take the earliest one that is still in the future.
   */
  function earningsOf(q, now) {
    const ts = [q && q.earningsTimestampStart, q && q.earningsTimestamp, q && q.earningsTimestampEnd]
      .filter((t) => typeof t === 'number' && Number.isFinite(t) && t > now);
    return ts.length ? Math.min(...ts) : null;
  }

  const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 10 ** d) / 10 ** d);

  /** Standard normal CDF (Abramowitz-Stegun 26.2.17, |err| < 7.5e-8). */
  function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
  }

  function d1d2(S, K, T, r, iv) {
    const v = iv * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + iv * iv / 2) * T) / v;
    return [d1, d1 - v];
  }

  /** Black-Scholes European put price. */
  function bsPut(S, K, T, r, iv) {
    if (T <= 0 || iv <= 0) return Math.max(K - S, 0);
    const [d1, d2] = d1d2(S, K, T, r, iv);
    return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
  }

  /** Implied vol from a put price by bisection; null when the price is outside BS bounds. */
  function impliedVol(price, S, K, T, r) {
    if (!(price > 0) || !(T > 0)) return null;
    const lower = Math.max(K * Math.exp(-r * T) - S, 0);
    if (price <= lower + 1e-6 || price >= K) return null;
    let lo = 0.005, hi = 5;
    if (bsPut(S, K, T, r, hi) < price) return null;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (bsPut(S, K, T, r, mid) > price) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * Premium we can realistically collect.
   * - both sides quoted: the mid
   * - ask but no bid: nobody is buying, so a seller collects nothing (noBid)
   * - no quotes at all (market closed / data gap): the last trade, flagged stale
   */
  function premiumOf(p) {
    const bid = p.bid > 0 ? p.bid : 0;
    const ask = p.ask > 0 ? p.ask : 0;
    if (bid > 0 && ask >= bid) return { premium: (bid + ask) / 2, stale: false, noBid: false };
    if (bid === 0 && ask > 0) return { premium: 0, stale: false, noBid: true };
    if (p.last > 0) return { premium: p.last, stale: true, noBid: false };
    return { premium: 0, stale: true, noBid: false };
  }

  /**
   * Evaluate selling one put.
   * @param p     contract {strike,bid,ask,last,openInterest,volume,yahooIv}
   * @param ctx   {spot, expiration (unix s), now (unix s), fallbackIv, earningsTs, r}
   */
  function evaluatePut(p, ctx) {
    const S = ctx.spot;
    const K = p.strike;
    const r = ctx.r ?? RISK_FREE;
    const closeTs = expiryClose(ctx.expiration);
    const dte = Math.max((closeTs - ctx.now) / DAY, 0.25);
    const T = dte / 365;
    const { premium, stale, noBid } = premiumOf(p);
    let iv = impliedVol(premium, S, K, T, r);
    let ivSource = 'premium';
    if (iv == null || iv > 3) {
      iv = p.yahooIv > 0.03 && p.yahooIv < 3 ? p.yahooIv : ctx.fallbackIv || 0.35;
      ivSource = 'fallback';
    }
    const [d1, d2] = d1d2(S, K, T, r, iv);
    const delta = normCdf(d1) - 1;
    const pop = normCdf(d2); // P(S_T > K): the put expires worthless and you keep the premium
    const breakeven = K - premium;
    const probProfit = normCdf(d1d2(S, Math.max(breakeven, 0.01), T, r, iv)[1]);
    const collateral = K * 100;
    const roc = premium / K;
    const annualized = roc * 365 / dte;
    const spreadPct = p.bid > 0 && p.ask >= p.bid ? (p.ask - p.bid) / ((p.ask + p.bid) / 2) : null;
    const expectedMove = S * iv * Math.sqrt(T);
    return {
      contract: p.contract,
      spot: S,
      strike: K,
      expiration: ctx.expiration,
      dte: round(dte, 1),
      bid: p.bid,
      ask: p.ask,
      last: p.last,
      premium: round(premium),
      stale,
      noBid,
      credit: round(premium * 100, 2),
      collateral: round(collateral, 2),
      netCost: round(collateral - premium * 100, 2),
      breakeven: round(breakeven),
      discount: round(1 - breakeven / S, 6), // how far below today's price your effective buy price is
      otmPct: round(1 - K / S, 6),
      roc: round(roc, 6),
      annualized: round(annualized, 6),
      iv: round(iv, 6),
      ivSource,
      delta: round(delta, 6),
      pop: round(pop, 6),
      probProfit: round(probProfit, 6),
      probAssign: round(1 - pop, 6),
      expectedMove: round(expectedMove),
      openInterest: p.openInterest,
      volume: p.volume,
      spreadPct: round(spreadPct, 6),
      // Earnings released before the final close can gap the stock through the strike.
      earningsBefore: !!(ctx.earningsTs && ctx.earningsTs > ctx.now && ctx.earningsTs < closeTs),
    };
  }

  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  /** 0-100 quality score for a CSP candidate, plus the reasons behind it. */
  function scorePut(c) {
    const yieldPts = clamp01(c.annualized / 0.40) * 30;
    // Delta 0.15-0.30 is the classic CSP zone: real premium without coin-flip assignment odds.
    const d = -c.delta;
    const deltaFit = d >= 0.15 && d <= 0.30 ? 1 : d > 0.30 ? clamp01(1 - (d - 0.30) / 0.15) : 0.5 + 0.5 * clamp01((d - 0.05) / 0.10);
    const deltaPts = deltaFit * 20;
    const safetyPts = clamp01((c.pop - 0.55) / 0.35) * 5;
    const cushionPts = clamp01(c.discount / 0.10) * 10;
    const spreadOk = c.spreadPct == null ? 0.4 : clamp01(1 - Math.max(0, c.spreadPct - 0.08) / 0.4);
    const oiOk = clamp01(Math.log10(c.openInterest + 1) / 3);
    const liqPts = spreadOk * oiOk * 15;
    // 20-50 DTE is the CSP sweet spot: enough premium, manageable gamma, time to roll.
    const dtePts = c.dte >= 20 && c.dte <= 50 ? 20 : c.dte < 20 ? 20 * clamp01(c.dte / 20) : 20 * clamp01(1 - (c.dte - 50) / 40);
    let score = yieldPts + deltaPts + safetyPts + cushionPts + liqPts + dtePts;
    if (c.earningsBefore) score -= 8;
    if (c.stale) score -= 5;
    if (c.annualized < 0.08) score -= 10; // too little income for the cash tied up
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /** Contracts worth considering at all: OTM, meaningful premium, sane delta. */
  function eligible(c) {
    return !c.noBid && c.strike < c.spot && c.premium >= 0.05 && c.delta <= -0.05 && c.delta >= -0.45 && c.annualized > 0.02;
  }

  /** Pick conservative / balanced / aggressive from scored candidates. */
  function pickProfiles(cands) {
    if (!cands.length) return {};
    // Weeklies inflate annualised yield; prefer 14+ DTE for the core picks when available.
    const core = cands.filter((c) => c.dte >= 14);
    const byScore = [...(core.length ? core : cands)].sort((a, b) => b.score - a.score);
    const nearest = (target, pool) => pool.reduce((best, c) => (Math.abs(c.delta - target) < Math.abs(best.delta - target) ? c : best));
    const good = byScore.slice(0, Math.max(8, Math.ceil(byScore.length * 0.4)));
    return {
      conservative: nearest(-0.15, good),
      balanced: byScore[0],
      aggressive: nearest(-0.33, good),
    };
  }

  /** P/L per contract at expiry for a short put. */
  function payoff(strike, premium, priceAtExpiry) {
    return (premium - Math.max(strike - priceAtExpiry, 0)) * 100;
  }

  /** Lognormal density of the price at expiry (for the payoff chart overlay). */
  function lognormalPdf(x, S, T, r, iv) {
    if (x <= 0) return 0;
    const s = iv * Math.sqrt(T);
    const mu = Math.log(S) + (r - iv * iv / 2) * T;
    const z = (Math.log(x) - mu) / s;
    return Math.exp(-z * z / 2) / (x * s * Math.sqrt(2 * Math.PI));
  }

  function sma(arr, n) {
    if (arr.length < n) return null;
    let s = 0;
    for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
    return s / n;
  }

  function smaSeries(arr, n) {
    const out = new Array(arr.length).fill(null);
    let s = 0;
    for (let i = 0; i < arr.length; i++) {
      s += arr[i];
      if (i >= n) s -= arr[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }

  /** Annualised close-to-close volatility over the last n days. */
  function histVol(close, n = 30) {
    if (close.length < n + 1) return null;
    if (close.slice(-n - 1).some((c) => !(c > 0))) return null;
    const rets = [];
    for (let i = close.length - n; i < close.length; i++) rets.push(Math.log(close[i] / close[i - 1]));
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(v * 252);
  }

  function rsi(close, n = 14) {
    if (close.length < n + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = close[i] - close[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    for (let i = n + 1; i < close.length; i++) {
      const d = close[i] - close[i - 1];
      gain = (gain * (n - 1) + Math.max(d, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    }
    if (loss === 0) return gain === 0 ? 50 : 100; // a flat series is neutral, not overbought
    return 100 - 100 / (1 + gain / loss);
  }

  // ---------- UI decisions (pure, so they can be unit-tested) ----------

  /** How many contracts `cash` can secure. At least 1 is shown for illustration. */
  function contractsFor(cash, collateral) {
    if (!(cash > 0) || !(collateral > 0)) return { n: 1, affordable: null };
    const n = Math.floor(cash / collateral);
    return n >= 1 ? { n, affordable: true } : { n: 1, affordable: false };
  }

  /** Price-at-expiry scenarios for the P/L table, highest price first, no duplicate prices. */
  function scenarioRows(spot, strike, premium, n = 1) {
    const moves = [0.10, 0.05, 0, -0.05, -0.10, -0.15, -0.20, -0.30];
    const rows = moves.map((m) => ({ label: m === 0 ? 'unchanged' : `${m > 0 ? '+' : ''}${(m * 100).toFixed(0)}%`, price: spot * (1 + m) }));
    rows.push({ label: 'at strike', price: strike }, { label: 'breakeven', price: strike - premium });
    const seen = new Set();
    return rows
      .sort((a, b) => b.price - a.price)
      .filter((r) => {
        const key = r.price.toFixed(2);
        if (seen.has(key) || !(r.price > 0)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => {
        let pl = payoff(strike, premium, r.price) * n;
        if (Math.abs(pl) < 0.005) pl = 0;
        return { ...r, pl, ret: pl / (strike * 100 * n), assigned: r.price < strike };
      });
  }

  /**
   * The contract to show when the user picks an expiry: the best-scored eligible put, else the
   * OTM put closest to 0.20 delta, else null. Never a contract from another expiry.
   */
  function bestForExpiry(cands, expiration) {
    const same = cands.filter((c) => c.expiration === expiration);
    const elig = same.filter((c) => c.eligible);
    if (elig.length) return elig.reduce((a, c) => (c.score > a.score ? c : a));
    const otm = same.filter((c) => c.strike < c.spot && c.premium > 0);
    if (otm.length) return otm.reduce((a, c) => (Math.abs(c.delta + 0.2) < Math.abs(a.delta + 0.2) ? c : a));
    return null;
  }

  /**
   * Filter/adapt scan rows for the Ideas table. When the best trade is over budget (or has
   * earnings inside it and the user excluded those) the conservative strike is tried instead;
   * rows that still don't fit are dropped.
   */
  function filterIdeas(rows, { budget = null, uptrendOnly = false, noEarnings = false } = {}) {
    const fits = (c) => c && !(budget && c.collateral > budget) && !(noEarnings && c.earningsBefore);
    const out = [];
    for (const r of rows) {
      if (uptrendOnly && r.trend !== 'up') continue;
      const pick = fits(r.best) ? r.best : fits(r.safer) ? r.safer : null;
      if (pick) out.push({ ...r, pick });
    }
    return out;
  }

  return {
    RISK_FREE, DAY, easternOffset, expiryClose, daysToExpiry, earningsOf, round,
    normCdf, bsPut, impliedVol, premiumOf, evaluatePut, scorePut, eligible,
    pickProfiles, payoff, lognormalPdf, sma, smaSeries, histVol, rsi,
    contractsFor, scenarioRows, bestForExpiry, filterIdeas,
  };
});
