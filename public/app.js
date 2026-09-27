/* global CSP, Charts */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {
    data: null, sel: null, expiry: null,
    reqId: 0, loading: false, timer: null, controller: null,
    ideas: null, ideasReq: 0, ideasTimer: null, ideasAt: 0,
  };
  const QUICK = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'KO', 'JPM', 'PLTR', 'SPY', 'QQQ'];
  const ANALYSE_REFRESH_MS = 60000;
  const IDEAS_REFRESH_MS = 90000;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v, d = 2) => (v == null || !Number.isFinite(+v) ? '—' : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(d) + '%');
  const date = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const shortDate = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const bigNum = (v) => (v == null ? '—' : v >= 1e12 ? (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : String(v));
  const cashInput = () => { const v = parseFloat($('cash').value); return v > 0 ? v : null; };

  /** fetch JSON with a timeout; throws Error(message) with the server's error text on failure. */
  async function getJson(url, { timeoutMs, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason));
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      return body;
    } catch (err) {
      if (err.name === 'TimeoutError' || (ctrl.signal.aborted && ctrl.signal.reason && ctrl.signal.reason.name === 'TimeoutError')) {
        throw new Error('The data source is taking too long to respond. Please try again.');
      }
      if (err.name === 'AbortError') throw err;
      if (err instanceof TypeError) throw new Error('Network error — check your connection and try again.');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- tabs ----------
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    // Reload ideas when first opened, or when the data went stale while the tab was hidden.
    if (name === 'ideas' && (!state.ideas || Date.now() - state.ideasAt > IDEAS_REFRESH_MS)) loadIdeas();
    else if (name === 'ideas') scheduleIdeas();
    if (name === 'analyse' && state.data) requestAnimationFrame(drawCharts);
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- analyse ----------
  $('quick').innerHTML = QUICK.map((s) => `<button type="button" data-s="${s}">${s}</button>`).join('');
  $('quick').addEventListener('click', (e) => {
    const s = e.target.dataset && e.target.dataset.s;
    if (s) { $('symbol').value = s; analyse(s); }
  });
  $('search').addEventListener('submit', (e) => { e.preventDefault(); analyse($('symbol').value); });
  // Cash changes contract counts, the "over budget" notes on the cards, KPIs, scenarios and charts.
  $('cash').addEventListener('input', () => { if (state.data) { renderProfiles(); renderSelection(); } });
  $('auto').addEventListener('change', setAuto);

  function setStatus(el, html, error) {
    el.hidden = !html;
    el.className = 'status' + (error ? ' error' : '');
    el.innerHTML = html || '';
  }

  async function analyse(raw, { silent = false } = {}) {
    const symbol = String(raw || '').trim().toUpperCase();
    if (!symbol) return;
    // A background refresh must never cancel or overwrite something the user asked for.
    if (silent && state.loading) return;
    const id = ++state.reqId;
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    if (!silent) {
      setStatus($('status'), `<span class="spinner"></span>Pulling live option chains for <b>${esc(symbol)}</b>…`);
      $('result').hidden = true;
      $('go').disabled = true;
    }
    try {
      const body = await getJson('/api/analyze?symbol=' + encodeURIComponent(symbol), { timeoutMs: 30000, signal: controller.signal });
      if (id !== state.reqId) return; // a newer request superseded this one
      const keep = state.data && state.data.symbol === body.symbol && state.sel ? state.sel.contract : null;
      state.data = body;
      state.sel = (keep && body.candidates.find((c) => c.contract === keep))
        || body.profiles.balanced
        || (body.expirations[0] && CSP.bestForExpiry(body.candidates, body.expirations[0].expiration))
        || null;
      state.expiry = state.sel ? state.sel.expiration : (body.expirations[0] || {}).expiration;
      setStatus($('status'), '');
      render();
      try { history.replaceState(null, '', '?symbol=' + encodeURIComponent(body.symbol)); } catch { /* file:// */ }
    } catch (err) {
      if (id !== state.reqId || err.name === 'AbortError') return;
      if (silent) $('r-asof').textContent = `Refresh failed (${err.message}) — showing ${new Date(state.data.asOf * 1000).toLocaleTimeString()} data`;
      else setStatus($('status'), esc(err.message), true);
    } finally {
      if (id === state.reqId) {
        state.loading = false;
        state.controller = null;
        $('go').disabled = false;
      }
    }
  }

  function setAuto() {
    clearInterval(state.timer);
    state.timer = null;
    if ($('auto').checked) {
      state.timer = setInterval(() => {
        if (state.data && !document.hidden && !$('tab-analyse').hidden) analyse(state.data.symbol, { silent: true });
      }, ANALYSE_REFRESH_MS);
    }
  }

  function render() {
    const d = state.data;
    $('result').hidden = false;
    $('r-symbol').textContent = d.symbol;
    $('r-name').textContent = `${d.name}${d.exchange ? ' · ' + d.exchange : ''}`;
    const live = d.marketState === 'REGULAR';
    $('r-state').textContent = live ? 'MARKET OPEN' : d.marketState === 'PRE' || d.marketState === 'PREPRE' ? 'PRE-MARKET' : d.marketState === 'POST' || d.marketState === 'POSTPOST' ? 'AFTER HOURS' : 'MARKET CLOSED';
    $('r-state').className = 'pill' + (live ? ' live' : '');
    $('r-price').textContent = money(d.price);
    const up = (d.change || 0) >= 0;
    $('r-change').className = 'mono ' + (up ? 'up' : 'down');
    $('r-change').textContent = d.change == null ? '' : `${up ? '+' : ''}${d.change.toFixed(2)} (${up ? '+' : ''}${(d.changePct || 0).toFixed(2)}%)`;
    $('r-grade').textContent = d.analysis.grade;
    $('r-grade').className = 'grade ' + d.analysis.grade;
    $('r-asof').textContent = 'Updated ' + new Date(d.asOf * 1000).toLocaleTimeString();
    $('r-summary').textContent = d.analysis.summary;
    $('notes').innerHTML = d.analysis.notes.map((n) => `<li class="${esc(n.tone)}">${esc(n.text)}</li>`).join('');
    renderStats();
    renderProfiles();
    renderChips();
    renderSelection();
  }

  function renderStats() {
    const s = state.data.stats;
    const items = [
      ['50-day avg', money(s.sma50)], ['200-day avg', money(s.sma200)], ['RSI (14)', s.rsi14 ?? '—'],
      ['Implied vol', pct(s.atmIv, 0)], ['Realised vol 30d', pct(s.hv30, 0)], ['IV / HV', s.ivHvRatio ?? '—'],
      ['52w high', money(s.high52)], ['52w low', money(s.low52)], ['60d support', money(s.support60)],
      ['Next earnings', s.earningsTs ? shortDate(s.earningsTs) + (s.daysToEarnings != null ? ` (${s.daysToEarnings}d)` : '') : '—'],
      ['Market cap', bigNum(s.marketCap)], ['P/E', s.pe ?? '—'], ['Dividend yield', s.divYield != null ? pct(s.divYield, 2) : '—'],
    ];
    $('stats').innerHTML = items.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('');
  }

  function renderProfiles() {
    const p = state.data.profiles;
    const cash = cashInput();
    const order = [['conservative', 'Conservative', 'Lower yield, higher odds'], ['balanced', 'Balanced ★', 'Best overall score'], ['aggressive', 'Aggressive', 'More premium, more assignment risk']];
    $('profiles').innerHTML = order.map(([key, label, sub]) => {
      const c = p[key];
      if (!c) return `<div class="profile ${key}"><div class="p-name">${label}</div><p class="muted">No contract fits.</p></div>`;
      const sel = state.sel && state.sel.contract === c.contract;
      return `<button type="button" class="profile ${key}${sel ? ' sel' : ''}" data-c="${esc(c.contract)}">
        <div class="p-head"><span class="p-name">${label}</span><span class="score">${c.score}/100</span></div>
        <div class="p-title">${shortDate(c.expiration)} $${c.strike} put</div>
        <dl>
          <dt>Premium</dt><dd>${money(c.premium)} <span class="muted">(${money(c.credit, 0)})</span></dd>
          <dt>Cash secured</dt><dd>${money(c.collateral, 0)}</dd>
          <dt>Return · annualised</dt><dd>${pct(c.roc, 2)} · ${pct(c.annualized)}</dd>
          <dt>Keep premium</dt><dd>${pct(c.pop, 0)}</dd>
          <dt>Breakeven</dt><dd>${money(c.breakeven)}</dd>
          <dt>Delta · DTE</dt><dd>${c.delta.toFixed(2)} · ${Math.round(c.dte)}d</dd>
        </dl>
        <div class="muted small" style="margin-top:8px">${sub}${c.earningsBefore ? ' · <span style="color:var(--amber)">earnings before expiry</span>' : ''}</div>
        ${cash && c.collateral > cash ? `<div class="over">Needs ${money(c.collateral, 0)} — more than your ${money(cash, 0)}</div>` : ''}
      </button>`;
    }).join('');
    $('profiles').querySelectorAll('button.profile').forEach((b) => b.addEventListener('click', () => select(b.dataset.c)));
  }

  function select(contract) {
    const c = state.data.candidates.find((x) => x.contract === contract);
    if (!c) return;
    state.sel = c;
    state.expiry = c.expiration;
    renderProfiles();
    renderChips();
    renderSelection();
  }

  function renderChips() {
    $('exp-chips').innerHTML = state.data.expirations.map((e) =>
      `<button type="button" data-e="${e.expiration}" class="${e.expiration === state.expiry ? 'active' : ''}" title="${e.count} qualifying puts">${shortDate(e.expiration)} · ${e.dte}d</button>`).join('');
    $('exp-chips').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.expiry = +b.dataset.e;
      // Always show a contract from the chosen expiry (or none), never a leftover from another one.
      state.sel = CSP.bestForExpiry(state.data.candidates, state.expiry);
      renderProfiles();
      renderChips();
      renderSelection();
    }));
  }

  function renderSelection() {
    const c = state.sel;
    renderChain();
    if (!c) {
      $('sel-label').textContent = '';
      $('kpis').innerHTML = '<p class="muted">No sellable out-of-the-money put for this expiry.</p>';
      $('scenarios').innerHTML = '';
      $('scen-note').textContent = '';
      clearCharts();
      return;
    }
    const cash = cashInput();
    const { n, affordable } = CSP.contractsFor(cash, c.collateral);
    $('sel-label').innerHTML = `${esc(c.contract)} · ${date(c.expiration)}` +
      `${c.stale ? ' <span class="tag stale">LAST TRADE</span>' : ''}${c.earningsBefore ? ' <span class="tag earn">EARNINGS</span>' : ''}` +
      `${c.eligible ? '' : ' <span class="tag stale">OUTSIDE FILTERS</span>'}`;
    const k = [
      ['Sell to open', `${n} × $${c.strike} put`, `${Math.round(c.dte)} days to expiry`],
      ['Premium collected', money(c.credit * n, 0), `${money(c.premium)} × 100 × ${n}`],
      ['Cash secured', money(c.collateral * n, 0), affordable === false ? `more than your ${money(cash, 0)}` : cash ? `${pct(c.collateral * n / cash, 0)} of your cash` : 'strike × 100'],
      ['Return', pct(c.roc, 2), `${pct(c.annualized)} annualised`],
      ['Keep full premium', pct(c.pop, 0), `assignment ≈ ${pct(c.probAssign, 0)}`],
      ['Any profit', pct(c.probProfit, 0), `stock above ${money(c.breakeven)}`],
      ['Breakeven', money(c.breakeven), c.discount >= 0 ? `${pct(c.discount)} below now` : `${pct(-c.discount)} above now (in the money)`],
      ['Delta · IV', `${c.delta.toFixed(2)} · ${pct(c.iv, 0)}`, `±1σ move ${money(c.expectedMove)}`],
      ['Bid / Ask', `${c.bid.toFixed(2)} / ${c.ask.toFixed(2)}`, `OI ${c.openInterest.toLocaleString()} · vol ${c.volume.toLocaleString()}`],
      ['Max loss (to $0)', money(c.breakeven * 100 * n, 0), 'if the stock went to zero'],
    ];
    $('kpis').innerHTML = k.map(([a, b, s]) => `<div class="kpi"><div class="k">${a}</div><div class="v">${b}</div><div class="s">${s}</div></div>`).join('');
    renderScenarios(c, n, affordable);
    drawCharts();
  }

  function renderScenarios(c, n, affordable) {
    const rows = CSP.scenarioRows(state.data.price, c.strike, c.premium, n);
    $('scen-note').textContent = `${n} contract${n > 1 ? 's' : ''}${affordable === false ? ' (exceeds your cash)' : ''}`;
    $('scenarios').innerHTML = '<thead><tr><th>Stock at expiry</th><th>Price</th><th>Outcome</th><th>P/L</th><th>Return</th></tr></thead><tbody>' +
      rows.map((r) => {
        const cls = r.pl >= 0 ? 'pos' : 'neg';
        return `<tr><td>${r.label}</td><td>${money(r.price)}</td><td class="nm">${r.assigned ? 'assigned — own shares' : 'expires worthless'}</td>` +
          `<td class="${cls}">${r.pl > 0 ? '+' : ''}${money(r.pl, 0)}</td><td class="${cls}">${pct(r.ret, 2)}</td></tr>`;
      }).join('') + '</tbody>';
  }

  function chainRows() {
    return state.data.candidates.filter((c) => c.expiration === state.expiry).sort((a, b) => b.strike - a.strike);
  }

  function renderChain() {
    const rows = chainRows();
    const sel = state.sel;
    $('chain').innerHTML = '<thead><tr><th>Strike</th><th>OTM</th><th>Bid</th><th>Ask</th><th>Premium</th><th>Return</th><th>Annual</th><th>Keep prem.</th><th>Delta</th><th>IV</th><th>OI</th><th>Score</th></tr></thead><tbody>' +
      (rows.length ? rows.map((c) => `<tr data-c="${esc(c.contract)}" class="${sel && c.contract === sel.contract ? 'sel' : ''}${c.eligible ? '' : ' dim'}">
        <td class="sym">$${c.strike}${c.stale ? '<span class="tag stale">LAST</span>' : ''}${c.noBid ? '<span class="tag stale">NO BID</span>' : ''}${c.badQuote ? '<span class="tag stale">BAD PRINT</span>' : ''}</td><td>${pct(c.otmPct)}</td>
        <td>${c.bid.toFixed(2)}</td><td>${c.ask.toFixed(2)}</td><td>${c.premium.toFixed(2)}</td><td>${pct(c.roc, 2)}</td>
        <td>${pct(c.annualized)}</td><td>${pct(c.pop, 0)}</td><td>${c.delta.toFixed(2)}</td><td>${pct(c.iv, 0)}</td>
        <td>${c.openInterest.toLocaleString()}</td><td>${c.score == null ? '—' : `<span class="bar" style="width:${c.score * 0.5}px"></span>${c.score}`}</td></tr>`).join('')
        : '<tr><td colspan="12" class="muted" style="text-align:center;padding:18px">No puts listed for this expiry.</td></tr>') + '</tbody>';
    $('chain').querySelectorAll('tbody tr[data-c]').forEach((tr) => tr.addEventListener('click', () => select(tr.dataset.c)));
  }

  function clearCharts() {
    const msg = '<div class="muted" style="padding:20px">Pick an expiry or strike with a sellable put.</div>';
    $('chart-price').innerHTML = msg;
    $('chart-payoff').innerHTML = msg;
    Charts.ladderChart($('chart-ladder'), { rows: chainRows().slice().reverse(), selected: null, onSelect: (r) => select(r.contract) });
  }

  function drawCharts() {
    const d = state.data;
    const c = state.sel;
    if (!d || !c || $('result').hidden || $('tab-analyse').hidden) return;
    const { n } = CSP.contractsFor(cashInput(), c.collateral);
    if (d.history && d.history.dates.length > 1) {
      Charts.priceChart($('chart-price'), {
        ...d.history, spot: d.price, strike: c.strike, breakeven: c.breakeven,
        expiration: c.expiration, expectedMove: c.expectedMove,
      });
    } else {
      $('chart-price').innerHTML = '<div class="muted" style="padding:20px">Price history unavailable.</div>';
    }
    $('price-legend').innerHTML = '<span><i style="background:#e6edf5"></i>Price</span><span><i style="background:#5b9dff"></i>50d</span><span><i style="background:#a78bfa"></i>200d</span><span><i style="background:#f5a524"></i>Strike</span><span><i style="background:#f05252"></i>Breakeven</span><span><i style="background:rgba(91,157,255,.5)"></i>±1σ to expiry</span>';
    Charts.payoffChart($('chart-payoff'), {
      spot: d.price, strike: c.strike, premium: c.premium, breakeven: c.breakeven,
      dte: c.dte, iv: c.iv, r: d.riskFree, contracts: n,
    });
    $('payoff-legend').innerHTML = '<span><i style="background:#10b981"></i>Profit</span><span><i style="background:#f05252"></i>Loss</span><span><i style="background:rgba(91,157,255,.6)"></i>Likely prices</span>';
    Charts.ladderChart($('chart-ladder'), {
      rows: chainRows().slice().reverse(), selected: c.contract,
      onSelect: (r) => select(r.contract),
    });
  }

  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(drawCharts, 120); });

  // ---------- ideas ----------
  $('rescan').addEventListener('click', () => loadIdeas(true));
  $('budget').addEventListener('input', renderIdeas);
  $('trend-filter').addEventListener('change', renderIdeas);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('tab-ideas').hidden && state.ideas && Date.now() - state.ideasAt > IDEAS_REFRESH_MS) loadIdeas();
  });

  function scheduleIdeas() {
    clearTimeout(state.ideasTimer);
    state.ideasTimer = setTimeout(() => {
      state.ideasTimer = null;
      // Only refresh while someone is looking; showTab/visibilitychange restart it later.
      if (!$('tab-ideas').hidden && !document.hidden) loadIdeas();
    }, IDEAS_REFRESH_MS);
  }

  async function loadIdeas(manual = false) {
    const id = ++state.ideasReq;
    const btn = $('rescan');
    btn.disabled = true;
    if (!state.ideas || manual) setStatus($('ideas-status'), '<span class="spinner"></span>Scanning option chains across ~57 liquid stocks and ETFs…');
    try {
      const body = await getJson('/api/scan' + (manual ? '?fresh=1' : ''), { timeoutMs: 60000 });
      if (id !== state.ideasReq) return;
      state.ideas = body;
      state.ideasAt = Date.now();
      setStatus($('ideas-status'), '');
      renderIdeas();
    } catch (err) {
      if (id !== state.ideasReq) return;
      setStatus($('ideas-status'), esc(err.message) + (state.ideas ? ' Showing the previous scan.' : ''), true);
    } finally {
      if (id === state.ideasReq) {
        btn.disabled = false;
        scheduleIdeas();
      }
    }
  }

  function renderIdeas() {
    const s = state.ideas;
    if (!s) return;
    const f = $('trend-filter').value;
    const rows = CSP.filterIdeas(s.rows, {
      budget: parseFloat($('budget').value) > 0 ? parseFloat($('budget').value) : null,
      uptrendOnly: f === 'up',
      noEarnings: f === 'noEarn',
    });
    const tone = (v) => (v >= 80 ? 'var(--green)' : v >= 65 ? 'var(--blue)' : v >= 50 ? 'var(--amber)' : 'var(--red)');
    $('ideas').innerHTML = '<thead><tr><th>#</th><th>Stock</th><th>Price</th><th>Trend</th><th>Sell put</th><th>Premium</th><th>Cash secured</th><th>Return</th><th>Annual</th><th>Keep prem.</th><th>Breakeven</th><th>Score</th></tr></thead><tbody>' +
      (rows.length ? rows.map((r, i) => {
        const b = r.pick;
        const name = r.name.length > 26 ? r.name.slice(0, 25) + '…' : r.name;
        return `<tr data-s="${esc(r.symbol)}">
          <td>${i + 1}</td>
          <td><span class="sym">${esc(r.symbol)}</span> <span class="nm">${esc(name)}</span></td>
          <td>${money(r.price)} <span class="${(r.changePct || 0) >= 0 ? 'pos' : 'neg'} small">${r.changePct == null ? '' : (r.changePct >= 0 ? '+' : '') + r.changePct.toFixed(1) + '%'}</span></td>
          <td class="nm">${esc(r.trend)}</td>
          <td>${shortDate(b.expiration)} $${b.strike}${b === r.safer && r.safer !== r.best ? '<span class="tag stale">SAFER</span>' : ''}${b.earningsBefore ? '<span class="tag earn">ER</span>' : ''}${b.stale ? '<span class="tag stale">LAST</span>' : ''}</td>
          <td>${money(b.premium)}</td><td>${money(b.collateral, 0)}</td><td>${pct(b.roc, 2)}</td>
          <td>${pct(b.annualized)}</td><td>${pct(b.pop, 0)}</td><td>${money(b.breakeven)} <span class="muted small">−${pct(b.discount)}</span></td>
          <td><span class="rank" style="color:${tone(r.rank)};background:rgba(255,255,255,0.04)">${r.rank}</span></td></tr>`;
      }).join('') : '<tr><td colspan="12" class="muted" style="text-align:center;padding:24px">No ideas match these filters.</td></tr>') + '</tbody>';
    $('ideas').querySelectorAll('tbody tr[data-s]').forEach((tr) => tr.addEventListener('click', () => {
      $('symbol').value = tr.dataset.s;
      showTab('analyse');
      analyse(tr.dataset.s);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    $('ideas-foot').textContent = `Scanned ${s.scanned} tickers, ${s.found} with a qualifying put · showing ${rows.length} · data from ${new Date(s.asOf * 1000).toLocaleTimeString()} · auto-refreshes every 90s while open · click a row for the full analysis. ER = earnings before expiry, SAFER = conservative strike shown to fit your filters.`;
  }

  // ---------- boot ----------
  const qs = new URLSearchParams(location.search).get('symbol');
  $('symbol').value = qs || 'AAPL';
  analyse($('symbol').value);
})();
