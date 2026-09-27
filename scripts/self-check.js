'use strict';
// Live self-test against real Yahoo data: analyse several tickers, then run the scan, and check
// every candidate against the same invariants the offline tests use.  `npm run selftest` (named self-check.js so `node --test` does not pick it up)
const { analyze } = require('../src/analyze');
const { scan } = require('../src/scan');
const CSP = require('../public/csp');

const TICKERS = ['AAPL', 'MSFT', 'KO', 'JPM', 'TSLA', 'SPY', 'QQQ', 'BRK.B'];

function problems(c) {
  const out = [];
  for (const [k, v] of Object.entries(c)) if (typeof v === 'number' && !Number.isFinite(v)) out.push(`${k} not finite`);
  if (!(c.breakeven > 0) || !(c.netCost > 0)) out.push('breakeven/net cost <= 0');
  if (c.pop < 0 || c.pop > 1) out.push('pop out of range');
  if (c.premium > 0 && Math.abs(CSP.payoff(c.strike, c.premium, c.breakeven)) > 0.02) out.push('breakeven P/L != 0');
  if (c.eligible && (c.strike >= c.spot || c.noBid || c.badQuote)) out.push('ineligible contract marked eligible');
  return out;
}

(async () => {
  let failures = 0;
  const fail = (msg) => { failures++; console.log('  FAIL', msg); };
  for (const s of TICKERS) {
    try {
      const t = Date.now();
      const r = await analyze(s);
      const bad = r.candidates.flatMap((c) => problems(c).map((p) => `${c.contract}: ${p}`));
      const b = r.profiles.balanced;
      console.log(`${bad.length ? 'FAIL' : 'PASS'} ${s.padEnd(6)} $${r.price}  grade ${r.analysis.grade}  ${r.candidates.length} puts  ${Date.now() - t}ms  ` +
        (b ? `balanced ${new Date(b.expiration * 1000).toISOString().slice(0, 10)} ${b.strike}P @ ${b.premium.toFixed(2)}  ann ${(b.annualized * 100).toFixed(1)}%  keep ${(b.pop * 100).toFixed(0)}%  Δ${b.delta.toFixed(2)}` : 'no pick'));
      bad.slice(0, 5).forEach(fail);
      if (!b) fail(`${s}: no balanced pick`);
      if (b && (b.delta > -0.1 || b.delta < -0.45)) fail(`${s}: balanced delta ${b.delta} outside -0.45..-0.10`);
    } catch (e) {
      fail(`${s}: ${e.message}`);
    }
  }
  const t = Date.now();
  try {
    const sc = await scan({ useCache: false });
    const ok = sc.found >= sc.scanned * 0.8;
    console.log(`${ok ? 'PASS' : 'FAIL'} scan   ${sc.found}/${sc.scanned} in ${Date.now() - t}ms; top: ${sc.rows.slice(0, 6).map((r) => `${r.symbol}(${r.rank})`).join(' ')}`);
    if (!ok) fail('scan found too few names');
    if (sc.rows.some((r) => !(r.best.breakeven > 0) || r.best.strike >= r.price)) fail('scan row with an ITM strike or bad breakeven');
  } catch (e) {
    fail(`scan: ${e.message}`);
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nAll live self-tests passed');
  process.exit(failures ? 1 : 0);
})();
