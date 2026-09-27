'use strict';
// Real Yahoo round-trip: analyse a few tickers and run the scan. `npm run test:live`
const { analyze } = require('../src/analyze');
const { scan } = require('../src/scan');

(async () => {
  let bad = 0;
  for (const s of ['AAPL', 'KO', 'SPY', 'TSLA']) {
    try {
      const r = await analyze(s);
      const b = r.profiles.balanced;
      console.log(`${s.padEnd(5)} ${r.price}  grade ${r.analysis.grade}  ` +
        (b ? `sell ${new Date(b.expiration * 1000).toISOString().slice(0, 10)} ${b.strike}P @ ${b.premium.toFixed(2)}  ann ${(b.annualized * 100).toFixed(1)}%  keep ${(b.pop * 100).toFixed(0)}%` : 'no pick'));
      if (!b) bad++;
    } catch (e) { bad++; console.log(s, 'FAILED', e.message); }
  }
  const t = Date.now();
  const sc = await scan({ useCache: false });
  console.log(`scan: ${sc.found}/${sc.scanned} in ${Date.now() - t}ms; top: ${sc.rows.slice(0, 5).map((r) => `${r.symbol}(${r.rank})`).join(' ')}`);
  if (sc.found < sc.scanned * 0.8) bad++;
  process.exit(bad ? 1 : 0);
})();
