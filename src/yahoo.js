'use strict';
// Yahoo Finance public endpoints (no API key).
// - v8 chart: daily closes for trend / volatility / support.
// - v7 options: needs a cookie + crumb session, which we fetch once and reuse.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const Q2 = 'https://query2.finance.yahoo.com';
const SESSION_TTL_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

let session = null; // { cookie, crumb, at }
let sessionPromise = null;

async function newSession(fetchImpl) {
  const res = await fetchImpl('https://fc.yahoo.com', {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const cookie = raw.map((c) => c.split(';')[0]).join('; ');
  const cr = await fetchImpl(`${Q2}/v1/test/getcrumb`, {
    headers: { 'User-Agent': UA, Cookie: cookie },
    signal: AbortSignal.timeout(10000),
  });
  const crumb = (await cr.text()).trim();
  if (!cr.ok || !crumb || crumb.length > 40 || /[<{\s]/.test(crumb)) throw new Error('Could not open a Yahoo session');
  return { cookie, crumb, at: Date.now() };
}

async function getSession(fetchImpl, force = false) {
  if (!force && session && Date.now() - session.at < SESSION_TTL_MS) return session;
  if (!sessionPromise) {
    sessionPromise = newSession(fetchImpl)
      .then((s) => (session = s))
      .finally(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

function resetSession() { session = null; }

/** GET JSON with timeout + retry. 404 -> null. 401 refreshes the crumb once. */
async function getJson(url, { fetchImpl = fetch, retries = 2, crumb = false, timeoutMs = 12000, backoffMs = 500 } = {}) {
  let lastErr;
  let refreshed = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = { 'User-Agent': UA, Accept: 'application/json' };
      let full = url;
      if (crumb) {
        const s = await getSession(fetchImpl);
        headers.Cookie = s.cookie;
        full += (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(s.crumb);
      }
      const res = await fetchImpl(full, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) return null;
      if (res.status === 401 && crumb && !refreshed) {
        refreshed = true;
        await getSession(fetchImpl, true);
        attempt--; // a crumb refresh does not count as a retry
        continue;
      }
      if (!res.ok) throw new HttpError(res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Option chain for one expiry (unix seconds) or the nearest one. null for unknown symbols. */
async function fetchChain(symbol, date, opts = {}) {
  let url = `${Q2}/v7/finance/options/${encodeURIComponent(symbol)}`;
  if (date) url += `?date=${date}`;
  const json = await getJson(url, { ...opts, crumb: true });
  const r = json && json.optionChain && json.optionChain.result && json.optionChain.result[0];
  if (!r || !r.quote || num(r.quote.regularMarketPrice) == null) return null;
  const o = (r.options && r.options[0]) || {};
  return {
    quote: r.quote,
    expirations: (r.expirationDates || []).filter((d) => num(d) != null),
    expiration: num(o.expirationDate),
    puts: (o.puts || []).map((p) => ({
      contract: p.contractSymbol,
      strike: num(p.strike),
      bid: num(p.bid) ?? 0,
      ask: num(p.ask) ?? 0,
      last: num(p.lastPrice) ?? 0,
      volume: num(p.volume) ?? 0,
      openInterest: num(p.openInterest) ?? 0,
      yahooIv: num(p.impliedVolatility),
      lastTradeDate: num(p.lastTradeDate),
      size: p.contractSize || 'REGULAR',
    }))
      // Adjusted contracts (after splits/mergers) don't deliver 100 shares, so CSP maths breaks.
      .filter((p) => p.strike != null && p.strike > 0 && p.size === 'REGULAR'),
  };
}

/** Daily closes (2 years by default), oldest first: { dates: [unix], close: [number] }. */
async function fetchDaily(symbol, { range = '2y', ...opts } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`;
  const json = await getJson(url, opts);
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !Array.isArray(r.timestamp)) return null;
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const meta = r.meta || {};
  const dates = [];
  const close = [];
  const low = [];
  const lastIdx = r.timestamp.length - 1;
  r.timestamp.forEach((ts, i) => {
    let c = num(q.close && q.close[i]);
    if (c == null && i === lastIdx) c = num(meta.regularMarketPrice); // Yahoo often leaves today's close null
    if (c == null) return;
    dates.push(ts);
    close.push(c);
    low.push(num(q.low && q.low[i]) ?? c);
  });
  return dates.length ? { dates, close, low } : null;
}

module.exports = { fetchChain, fetchDaily, getJson, getSession, resetSession, HttpError, UA };
