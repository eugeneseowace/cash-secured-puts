'use strict';
// One-ticker cash-secured put analysis: option chains for the next ~2 months, scored
// candidates, stock context (trend, volatility, support, earnings) and a plain-English verdict.
const yahoo = require('./yahoo');
const CSP = require('../public/csp');

const DAY = 86400;
const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,15}$/;
const MIN_DTE = 4;
const MAX_DTE = 60;
const MAX_EXPIRIES = 6;

function userError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function cleanSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) throw userError('Enter a ticker symbol, e.g. AAPL.');
  if (!SYMBOL_RE.test(s)) throw userError(`"${String(raw).slice(0, 20)}" is not a valid ticker.`);
  return s;
}

/** Expirations inside the CSP sweet-spot window, nearest first. */
function pickExpirations(expirations, now, { min = MIN_DTE, max = MAX_DTE, limit = MAX_EXPIRIES } = {}) {
  const dte = (e) => CSP.daysToExpiry(e, now);
  const inWindow = expirations.filter((e) => dte(e) >= min && dte(e) <= max);
  if (inWindow.length <= limit) return inWindow;
  // Keep the nearest, the one closest to 30 DTE, and spread the rest.
  const step = (inWindow.length - 1) / (limit - 1);
  const picked = new Set();
  for (let i = 0; i < limit; i++) picked.add(inWindow[Math.round(i * step)]);
  const near30 = inWindow.reduce((b, e) => (Math.abs(dte(e) - 30) < Math.abs(dte(b) - 30) ? e : b));
  picked.add(near30);
  return [...picked].sort((a, b) => a - b).slice(0, limit + 1);
}


/** Evaluate + score every put of one chain. */
function evaluateChain(chain, ctxBase) {
  const ctx = { ...ctxBase, expiration: chain.expiration };
  return chain.puts
    .filter((p) => p.strike >= ctxBase.spot * 0.6 && p.strike <= ctxBase.spot * 1.03)
    .map((p) => {
      const c = CSP.evaluatePut(p, ctx);
      c.eligible = CSP.eligible(c);
      c.score = c.eligible ? CSP.scorePut(c) : null;
      return c;
    });
}

function round(x, d = 2) {
  return x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
}

function stockContext(q, hist, candidates, now) {
  const close = hist ? hist.close : [];
  const spot = q.regularMarketPrice;
  const sma50 = CSP.sma(close, 50) ?? q.fiftyDayAverage ?? null;
  const sma200 = CSP.sma(close, 200) ?? q.twoHundredDayAverage ?? null;
  const hv30 = CSP.histVol(close, 30);
  const rsi14 = CSP.rsi(close.slice(-120), 14);
  const hi52 = q.fiftyTwoWeekHigh ?? (close.length ? Math.max(...close) : null);
  const lo52 = q.fiftyTwoWeekLow ?? (close.length ? Math.min(...close) : null);
  const lows = hist ? hist.low.slice(-60) : [];
  const support60 = lows.length ? Math.min(...lows) : null;

  // ATM IV from the expiry nearest 30 DTE.
  let atmIv = null;
  if (candidates.length) {
    const exp = candidates.reduce((b, c) => (Math.abs(c.dte - 30) < Math.abs(b.dte - 30) ? c : b)).expiration;
    const same = candidates.filter((c) => c.expiration === exp);
    const atm = same.reduce((b, c) => (Math.abs(c.strike - spot) < Math.abs(b.strike - spot) ? c : b));
    atmIv = atm.iv;
  }
  const earningsTs = CSP.earningsOf(q, now);
  const daysToEarnings = earningsTs ? (earningsTs - now) / DAY : null;
  const divYield = q.dividendYield != null ? q.dividendYield / 100 : q.trailingAnnualDividendYield ?? null;

  return {
    sma50: round(sma50), sma200: round(sma200),
    hv30: round(hv30, 4), atmIv: round(atmIv, 4),
    ivHvRatio: atmIv && hv30 ? round(atmIv / hv30, 2) : null,
    rsi14: round(rsi14, 1),
    high52: round(hi52), low52: round(lo52),
    fromHigh: hi52 ? round(spot / hi52 - 1, 4) : null,
    support60: round(support60),
    earningsTs, daysToEarnings: daysToEarnings != null ? Math.round(daysToEarnings) : null,
    marketCap: q.marketCap ?? null,
    pe: round(q.trailingPE ?? null, 1),
    forwardPe: round(q.forwardPE ?? null, 1),
    divYield: round(divYield, 4),
  };
}

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;

/** Stock-level suitability for selling puts, 0-100, with reasons. */
function assess(spot, st, best) {
  const notes = [];
  let score = 50;
  const add = (pts, tone, text) => { score += pts; notes.push({ tone, text }); };

  if (st.sma200 && st.sma50) {
    if (spot > st.sma50 && st.sma50 > st.sma200) add(12, 'good', `Uptrend: price is above the 50-day (${st.sma50}) and the 50-day is above the 200-day (${st.sma200}).`);
    else if (spot > st.sma200) add(5, 'good', `Price is above its 200-day average (${st.sma200}) — long-term trend intact.`);
    else if (spot < st.sma50 && st.sma50 < st.sma200) add(-14, 'bad', `Downtrend: price is below the 50-day and the 50-day is below the 200-day. Assignment risk is higher.`);
    else add(-5, 'warn', `Price is below its 200-day average (${st.sma200}) — trend is weak.`);
  }
  if (st.ivHvRatio != null) {
    if (st.ivHvRatio >= 1.15) add(10, 'good', `Options are rich: implied vol ${pct(st.atmIv, 0)} vs realised ${pct(st.hv30, 0)} (×${st.ivHvRatio}). Put sellers are being paid well.`);
    else if (st.ivHvRatio < 0.85) add(-6, 'warn', `Options are cheap: implied vol ${pct(st.atmIv, 0)} is below realised ${pct(st.hv30, 0)}. Premium may not cover the real risk.`);
    else add(0, 'info', `Implied vol ${pct(st.atmIv, 0)} is close to realised ${pct(st.hv30, 0)} — fairly priced premium.`);
  }
  if (st.rsi14 != null) {
    if (st.rsi14 < 30) add(4, 'info', `RSI ${st.rsi14}: oversold. Selling puts into weakness can work, but don't catch a falling knife.`);
    else if (st.rsi14 > 72) add(-4, 'warn', `RSI ${st.rsi14}: overbought. A pullback toward your strike is more likely than usual.`);
    else add(2, 'good', `RSI ${st.rsi14}: neutral momentum.`);
  }
  if (st.daysToEarnings != null && best && best.earningsBefore) {
    add(-10, 'bad', `Earnings in ~${st.daysToEarnings} days — before the suggested expiry. Gap risk is high; consider an expiry before earnings.`);
  } else if (st.daysToEarnings != null && st.daysToEarnings < 60) {
    add(0, 'info', `Next earnings in ~${st.daysToEarnings} days (after the suggested expiry).`);
  }
  if (st.support60 && best) {
    if (best.strike <= st.support60) add(6, 'good', `Suggested strike ${best.strike} sits at/below 60-day support (${st.support60}).`);
    else add(0, 'info', `60-day support is ${st.support60}; the suggested strike ${best.strike} is above it.`);
  }
  if (st.marketCap != null) {
    if (st.marketCap >= 50e9) add(5, 'good', 'Mega/large-cap — the kind of company most CSP sellers are happy to own if assigned.');
    else if (st.marketCap < 2e9) add(-8, 'warn', 'Small-cap — wider swings and thinner options; size positions carefully.');
  }
  if (st.fromHigh != null && st.fromHigh < -0.35) add(-4, 'warn', `Price is ${pct(-st.fromHigh, 0)} below its 52-week high.`);
  if (best && best.stale) add(-3, 'warn', 'Market is closed or quotes are thin — premiums use the last trade and may change at the open.');

  if (!best) {
    // A great stock is still a poor CSP candidate when no put is worth selling.
    add(-15, 'bad', 'No out-of-the-money put currently pays a meaningful premium with a real bid.');
    score = Math.min(score, 47);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 75 ? 'A' : score >= 62 ? 'B' : score >= 48 ? 'C' : 'D';
  return { score, grade, notes };
}

function summary(symbol, spot, best, grade) {
  if (!best) return `No put on ${symbol} currently meets the CSP filters (out-of-the-money, delta 0.05–0.45, a real premium). Try another ticker.`;
  const exp = new Date(best.expiration * 1000).toISOString().slice(0, 10);
  const verdict = { A: 'Strong candidate', B: 'Good candidate', C: 'Acceptable with caution', D: 'Weak candidate' }[grade];
  return `${verdict}. Best balanced trade: sell the ${exp} $${best.strike} put for about $${best.premium.toFixed(2)} ` +
    `($${best.credit.toFixed(0)} per contract, $${best.collateral.toLocaleString('en-US')} cash secured). ` +
    `That is ${pct(best.roc, 2)} in ${Math.round(best.dte)} days (${pct(best.annualized, 1)} annualised), ` +
    `with a ${pct(best.pop, 0)} chance of expiring worthless. If assigned you buy ${symbol} at an effective ` +
    `$${best.breakeven.toFixed(2)}, ${pct(best.discount, 1)} below today's $${spot.toFixed(2)}.`;
}

async function analyze(rawSymbol, { now = Math.floor(Date.now() / 1000), fetchImpl } = {}) {
  let symbol = cleanSymbol(rawSymbol);
  const opts = fetchImpl ? { fetchImpl } : {};
  let first;
  try {
    first = await yahoo.fetchChain(symbol, null, opts);
    // US share classes are written BRK.B by most people but BRK-B by Yahoo.
    if (!first && /^[A-Z]{1,5}\.[A-Z]$/.test(symbol)) {
      const alt = symbol.replace('.', '-');
      first = await yahoo.fetchChain(alt, null, opts);
      if (first) symbol = alt;
    }
  } catch (err) {
    throw Object.assign(userError('Could not reach Yahoo Finance for option data. Try again in a moment.', 502), { cause: err });
  }
  if (!first) throw userError(`No data found for ${symbol}.`, 404);
  if (!first.expirations.length) throw userError(`${symbol} has no listed options, so you can't sell puts on it.`, 422);

  const q = first.quote;
  const spot = q.regularMarketPrice;
  const exps = pickExpirations(first.expirations, now);
  if (!exps.length) throw userError(`${symbol} has no option expiries in the next ${MAX_DTE} days.`, 422);

  if (!Number.isFinite(spot) || spot <= 0) throw userError(`No valid price for ${symbol}.`, 404);

  const [chains, hist] = await Promise.all([
    Promise.all(exps.map((e) => (e === first.expiration ? first : yahoo.fetchChain(symbol, e, opts).catch(() => null)))),
    yahoo.fetchDaily(symbol, opts).catch(() => null),
  ]);

  const hv30 = hist ? CSP.histVol(hist.close, 30) : null;
  const ctxBase = { spot, now, fallbackIv: hv30 || 0.35, earningsTs: CSP.earningsOf(q, now) };
  const candidates = [];
  const expirations = [];
  for (const ch of chains) {
    if (!ch || !ch.expiration) continue;
    const list = evaluateChain(ch, ctxBase);
    candidates.push(...list);
    expirations.push({ expiration: ch.expiration, dte: Math.round(CSP.daysToExpiry(ch.expiration, now)), count: list.filter((c) => c.eligible).length });
  }
  const eligible = candidates.filter((c) => c.eligible);
  const profiles = CSP.pickProfiles(eligible);
  const stats = stockContext(q, hist, candidates, now);
  const assessment = assess(spot, stats, profiles.balanced);

  let history = null;
  if (hist) {
    const from = Math.max(0, hist.close.length - 260);
    const cut = (arr) => arr.slice(from).map((v) => round(v, 3));
    history = {
      dates: hist.dates.slice(from),
      close: cut(hist.close),
      sma50: cut(CSP.smaSeries(hist.close, 50)),
      sma200: cut(CSP.smaSeries(hist.close, 200)),
    };
  }

  return {
    symbol,
    name: q.longName || q.shortName || symbol,
    currency: q.currency || 'USD',
    exchange: q.fullExchangeName || q.exchange || '',
    price: spot,
    change: q.regularMarketChange ?? null,
    changePct: q.regularMarketChangePercent ?? null,
    marketState: q.marketState || 'UNKNOWN',
    quoteTime: q.regularMarketTime ?? null,
    asOf: now,
    riskFree: CSP.RISK_FREE,
    stats,
    history,
    expirations,
    candidates,
    profiles,
    analysis: { ...assessment, summary: summary(symbol, spot, profiles.balanced, assessment.grade) },
  };
}

module.exports = { analyze, cleanSymbol, pickExpirations, assess, evaluateChain, userError };
