# CSP Finder — Cash-Secured Puts

Live cash-secured put finder. No API key, no dependencies (Node 18+).

- **Analyse a stock** — type one ticker, get the best puts to sell across the next ~60 days (Conservative / Balanced / Aggressive), a 1-year price chart with strike, breakeven and expected-move cone, a P/L-at-expiry chart with the probability distribution, price scenarios, a strike ladder, and a stock grade (A–D) with reasons. Optional "cash available" sizes the number of contracts. Live refresh every 60s.
- **Top CSP ideas now** — scans ~57 liquid US large caps/ETFs, finds each one's best ~30-DTE put and ranks them. Budget and trend/earnings filters. Refreshes every 90s.

```
npm start          # http://localhost:5700
npm test           # 48 offline tests (Yahoo mocked): maths, UI decisions, API, server
npm run test:live  # real Yahoo round-trip
```

Data: Yahoo Finance option chains (`v7/finance/options`, needs a cookie + crumb session, handled in `src/yahoo.js`) and daily chart (`v8/finance/chart`).
Maths (Black-Scholes IV/delta/probabilities, scoring) lives in `public/csp.js`, shared by browser, server and tests.

Vercel-ready: `public/` is static, `api/analyze.js` and `api/scan.js` are functions; `server.js` is local-only (in `.vercelignore`).

Educational tool — not financial advice.
