'use strict';
// Fake Yahoo: cookie/crumb session, option chains and daily chart, all offline.
const CSP = require('../public/csp');

const DAY = 86400;
const NOW = 1790000000; // fixed "now" (unix s)

function makePuts(spot, expiration, iv = 0.3) {
  const T = (expiration - NOW) / DAY / 365;
  const puts = [];
  const step = Math.max(1, Math.round(spot / 100));
  for (let k = Math.round(spot * 0.7); k <= Math.round(spot * 1.05); k += step) {
    const fair = CSP.bsPut(spot, k, T, 0.04, iv);
    puts.push({
      contractSymbol: `TEST${expiration}P${k}`, strike: k,
      bid: Math.max(0, +(fair * 0.97).toFixed(2)), ask: +(fair * 1.03 + 0.01).toFixed(2),
      lastPrice: +fair.toFixed(2), volume: 100, openInterest: 2000, impliedVolatility: iv,
    });
  }
  return puts;
}

function yahooMock({ spot = 100, expDays = [7, 21, 35, 70], quote = {}, noOptions = false, unknown = false, crumbFailsOnce = false, only = null, extraPuts = [], delayMs = 0 } = {}) {
  const exps = expDays.map((d) => NOW + d * DAY);
  const calls = [];
  let crumbHits = 0;
  const q = {
    regularMarketPrice: spot, shortName: 'Test Co', currency: 'USD', marketState: 'REGULAR', marketCap: 100e9,
    fiftyDayAverage: spot * 0.97, twoHundredDayAverage: spot * 0.9, ...quote,
  };
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

  async function fetchImpl(url) {
    calls.push(url);
    if (url.startsWith('https://fc.yahoo.com')) {
      return { ok: false, status: 404, headers: { getSetCookie: () => ['A3=abc; Path=/'], get: () => null }, text: async () => '' };
    }
    if (url.includes('/getcrumb')) {
      crumbHits++;
      return { ok: true, status: 200, text: async () => 'crumb' + crumbHits };
    }
    if (url.includes('/v7/finance/options/')) {
      if (crumbFailsOnce && crumbHits < 2) return json({ finance: { error: 'Invalid Crumb' } }, 401);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const sym = decodeURIComponent(url.split('/v7/finance/options/')[1].split('?')[0]);
      if (unknown || (only && !only.includes(sym))) return json({ optionChain: { result: [] } });
      const m = url.match(/date=(\d+)/);
      const exp = m ? +m[1] : exps[0];
      return json({ optionChain: { result: [{
        quote: q,
        expirationDates: noOptions ? [] : exps,
        options: noOptions ? [] : [{ expirationDate: exp, puts: [...makePuts(spot, exp), ...extraPuts] }],
      }] } });
    }
    if (url.includes('/v8/finance/chart/')) {
      const n = 500; // ~2 years of trading days
      const timestamp = [], close = [], low = [];
      for (let i = 0; i < n; i++) {
        timestamp.push(NOW - (n - i) * DAY);
        const c = spot * (0.8 + 0.2 * i / n) * (1 + 0.01 * Math.sin(i / 3));
        close.push(c);
        low.push(c * 0.99);
      }
      return json({ chart: { result: [{ meta: {}, timestamp, indicators: { quote: [{ close, low }] } }] } });
    }
    return json({}, 404);
  }
  return { fetchImpl, calls };
}

module.exports = { yahooMock, makePuts, NOW, DAY };
