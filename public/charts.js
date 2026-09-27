// Dependency-free SVG charts: price history with strike/breakeven + expected-move cone,
// short-put payoff with the price-at-expiry distribution, and a strike ladder.
(function (root) {
  'use strict';
  const C = {
    green: '#10b981', red: '#f05252', amber: '#f5a524', blue: '#5b9dff', violet: '#a78bfa',
    text: '#e6edf5', muted: '#8a9bb0', line: '#243244',
  };
  const tip = () => document.getElementById('tooltip');

  function scale(d0, d1, r0, r1) {
    const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
    return (v) => r0 + (v - d0) * k;
  }

  function niceTicks(min, max, count = 5) {
    const span = max - min || 1;
    const step0 = span / count;
    const mag = 10 ** Math.floor(Math.log10(step0));
    // Round step whose tick count is closest to what was asked for (rounding up only gave too few).
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag)
      .reduce((best, s) => (Math.abs(span / s - count) < Math.abs(span / best - count) ? s : best));
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function size(el) {
    const r = el.getBoundingClientRect();
    return { w: Math.max(280, r.width), h: Math.max(180, r.height) };
  }

  const fmtMoney = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));
  const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const fmtDateY = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  function path(points) {
    let d = '';
    let pen = false;
    for (const [x, y] of points) {
      if (y == null || !Number.isFinite(y)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
      pen = true;
    }
    return d;
  }

  function showTip(evt, html) {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    const pad = 14;
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    const r = t.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  const hideTip = () => { tip().hidden = true; };

  function hLine(y, x0, x1, color, label, dash = '5 4', side = 'right', below = false) {
    const lx = side === 'right' ? x1 - 4 : x0 + 4;
    const anchor = side === 'right' ? 'end' : 'start';
    return `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="1.5" stroke-dasharray="${dash}"/>` +
      (label ? `<text x="${lx}" y="${below ? y + 14 : y - 5}" fill="${color}" font-size="11" font-family="JetBrains Mono" text-anchor="${anchor}" font-weight="600">${label}</text>` : '');
  }

  /** 1-year closes + SMAs, strike & breakeven lines, and a cone to expiry. */
  function priceChart(el, o) {
    const { w, h } = size(el);
    const m = { l: 10, r: 58, t: 14, b: 26 };
    const n = o.dates.length;
    const start = Math.max(0, n - 252);
    const dates = o.dates.slice(start);
    const close = o.close.slice(start);
    const s50 = o.sma50.slice(start);
    const s200 = o.sma200.slice(start);
    const lastT = dates[dates.length - 1];
    const futureEnd = Math.max(o.expiration, lastT + 86400);
    const coneHi = o.spot + o.expectedMove;
    const coneLo = Math.max(0, o.spot - o.expectedMove);
    const vals = close.concat(s50, s200, [o.strike, o.breakeven, coneHi, coneLo]).filter((v) => v != null);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.06;
    lo -= pad; hi += pad;
    const x = scale(dates[0], futureEnd, m.l, w - m.r);
    const y = scale(lo, hi, h - m.b, m.t);

    let svg = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`;
    svg += '<g class="grid">';
    for (const t of niceTicks(lo, hi, 5)) svg += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += '</g><g class="axis">';
    for (const t of niceTicks(lo, hi, 5)) svg += `<text x="${w - m.r + 6}" y="${y(t) + 4}">${fmtMoney(t)}</text>`;
    // month labels
    let lastMonth = -1;
    const every = w < 500 ? 3 : 2;
    dates.forEach((d, i) => {
      const dt = new Date(d * 1000);
      const mo = dt.getUTCMonth();
      if (mo !== lastMonth) {
        lastMonth = mo;
        if (i > 5 && mo % every === 0) svg += `<text x="${x(d)}" y="${h - 6}" text-anchor="middle">${dt.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</text>`;
      }
    });
    svg += '</g>';

    // future zone + cone
    const xNow = x(lastT), xExp = x(o.expiration);
    svg += `<rect x="${xNow}" y="${m.t}" width="${Math.max(0, w - m.r - xNow)}" height="${h - m.t - m.b}" fill="rgba(91,157,255,0.05)"/>`;
    const steps = 24;
    const upper = [], lower = [];
    for (let i = 0; i <= steps; i++) {
      const t = lastT + (o.expiration - lastT) * (i / steps);
      const f = Math.sqrt(i / steps);
      upper.push([x(t), y(o.spot + o.expectedMove * f)]);
      lower.push([x(t), y(Math.max(0, o.spot - o.expectedMove * f))]);
    }
    svg += `<path d="${path(upper)}L${lower.reverse().map((p) => p.join(',')).join('L')}Z" fill="rgba(91,157,255,0.14)" stroke="rgba(91,157,255,0.5)" stroke-width="1"/>`;
    svg += `<line x1="${xExp}" x2="${xExp}" y1="${m.t}" y2="${h - m.b}" stroke="${C.muted}" stroke-dasharray="2 3"/>`;
    svg += `<text x="${xExp}" y="${m.t + 10}" fill="${C.muted}" font-size="10" text-anchor="end" dx="-4" font-family="JetBrains Mono">expiry ${fmtDate(o.expiration)}</text>`;

    // lines
    svg += `<path d="${path(dates.map((d, i) => [x(d), s200[i] == null ? null : y(s200[i])]))}" fill="none" stroke="${C.violet}" stroke-width="1.4" opacity="0.85"/>`;
    svg += `<path d="${path(dates.map((d, i) => [x(d), s50[i] == null ? null : y(s50[i])]))}" fill="none" stroke="${C.blue}" stroke-width="1.4" opacity="0.85"/>`;
    const area = path(dates.map((d, i) => [x(d), y(close[i])]));
    svg += `<defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.text}" stop-opacity="0.12"/><stop offset="1" stop-color="${C.text}" stop-opacity="0"/></linearGradient></defs>`;
    svg += `<path d="${area}L${x(lastT)},${h - m.b}L${x(dates[0])},${h - m.b}Z" fill="url(#pg)"/>`;
    svg += `<path d="${area}" fill="none" stroke="${C.text}" stroke-width="1.8"/>`;
    svg += hLine(y(o.strike), m.l, w - m.r, C.amber, `strike ${fmtMoney(o.strike)}`, '6 4', 'left');
    svg += hLine(y(o.breakeven), m.l, w - m.r, C.red, `breakeven ${fmtMoney(o.breakeven)}`, '2 3', 'left', true);
    svg += `<circle cx="${x(lastT)}" cy="${y(o.spot)}" r="4" fill="${C.green}" stroke="#0b1017" stroke-width="2"/>`;
    svg += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${h - m.b}" stroke="${C.muted}" opacity="0"/>`;
    svg += `<circle class="xd" r="3.5" fill="${C.text}" opacity="0"/>`;
    svg += `<rect class="hit" x="${m.l}" y="${m.t}" width="${w - m.l - m.r}" height="${h - m.t - m.b}" fill="transparent"/>`;
    svg += '</svg>';
    el.innerHTML = svg;

    const s = el.querySelector('svg');
    const xh = s.querySelector('.xh');
    const xd = s.querySelector('.xd');
    const hit = s.querySelector('.hit');
    hit.addEventListener('pointermove', (evt) => {
      const r = s.getBoundingClientRect();
      const px = (evt.clientX - r.left) * (w / r.width);
      let i = 0, best = Infinity;
      dates.forEach((d, k) => { const dd = Math.abs(x(d) - px); if (dd < best) { best = dd; i = k; } });
      if (px > xNow + 4) {
        xh.setAttribute('opacity', 0); xd.setAttribute('opacity', 0);
        showTip(evt, `Expected range by ${fmtDate(o.expiration)}<br><b>${fmtMoney(coneLo)} – ${fmtMoney(coneHi)}</b> (±1σ)`);
        return;
      }
      xh.setAttribute('x1', x(dates[i])); xh.setAttribute('x2', x(dates[i])); xh.setAttribute('opacity', 0.6);
      xd.setAttribute('cx', x(dates[i])); xd.setAttribute('cy', y(close[i])); xd.setAttribute('opacity', 1);
      showTip(evt, `${fmtDateY(dates[i])}<br>Close <b>${fmtMoney(close[i])}</b>` +
        (s50[i] ? `<br><span style="color:${C.blue}">50d ${fmtMoney(s50[i])}</span>` : '') +
        (s200[i] ? `<br><span style="color:${C.violet}">200d ${fmtMoney(s200[i])}</span>` : ''));
    });
    hit.addEventListener('pointerleave', () => { hideTip(); xh.setAttribute('opacity', 0); xd.setAttribute('opacity', 0); });
  }

  /** Short-put P/L per contract at expiry, with the lognormal distribution behind it. */
  function payoffChart(el, o) {
    const { w, h } = size(el);
    const m = { l: 58, r: 14, t: 16, b: 28 };
    const CSP = root.CSP;
    const T = Math.max(o.dte, 0.25) / 365;
    const x0 = Math.max(0.01, Math.min(o.spot * (1 - 2.6 * o.iv * Math.sqrt(T)), o.strike * 0.9));
    const x1 = o.spot * (1 + 2.2 * o.iv * Math.sqrt(T)) + o.spot * 0.02;
    const N = 160;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const p = x0 + (x1 - x0) * (i / N);
      pts.push([p, CSP.payoff(o.strike, o.premium, p) * o.contracts, CSP.lognormalPdf(p, o.spot, T, o.r, o.iv)]);
    }
    const maxP = o.premium * 100 * o.contracts;
    const minP = Math.min(...pts.map((p) => p[1]));
    const lo = minP - (maxP - minP) * 0.08;
    const hi = maxP + (maxP - minP) * 0.15;
    const x = scale(x0, x1, m.l, w - m.r);
    const y = scale(lo, hi, h - m.b, m.t);
    const maxD = Math.max(...pts.map((p) => p[2])) || 1;
    const yd = (d) => (h - m.b) - (d / maxD) * (h - m.t - m.b) * 0.55;

    let svg = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`;
    svg += '<g class="grid">';
    for (const t of niceTicks(lo, hi, 5)) svg += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += '</g><g class="axis">';
    for (const t of niceTicks(lo, hi, 5)) svg += `<text x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${t < 0 ? '−' : ''}$${Math.abs(t).toLocaleString('en-US', { maximumFractionDigits: 0 })}</text>`;
    for (const t of niceTicks(x0, x1, w < 500 ? 4 : 7)) svg += `<text x="${x(t)}" y="${h - 8}" text-anchor="middle">${fmtMoney(t)}</text>`;
    svg += '</g>';
    // distribution
    svg += `<path d="${path(pts.map((p) => [x(p[0]), yd(p[2])]))}L${x(x1)},${h - m.b}L${x(x0)},${h - m.b}Z" fill="rgba(91,157,255,0.10)" stroke="rgba(91,157,255,0.45)" stroke-width="1"/>`;
    // profit / loss fills split at zero
    const zero = y(0);
    svg += `<defs><clipPath id="cp-pos"><rect x="0" y="0" width="${w}" height="${zero}"/></clipPath><clipPath id="cp-neg"><rect x="0" y="${zero}" width="${w}" height="${h}"/></clipPath></defs>`;
    const line = path(pts.map((p) => [x(p[0]), y(p[1])]));
    const fill = `${line}L${x(x1)},${zero}L${x(x0)},${zero}Z`;
    svg += `<path d="${fill}" fill="rgba(16,185,129,0.22)" clip-path="url(#cp-pos)"/>`;
    svg += `<path d="${fill}" fill="rgba(240,82,82,0.2)" clip-path="url(#cp-neg)"/>`;
    svg += `<line x1="${m.l}" x2="${w - m.r}" y1="${zero}" y2="${zero}" stroke="${C.muted}" stroke-width="1"/>`;
    svg += `<path d="${line}" fill="none" stroke="${C.text}" stroke-width="2.2"/>`;
    const vline = (v, color, label, dy, left = false) =>
      `<line x1="${x(v)}" x2="${x(v)}" y1="${m.t}" y2="${h - m.b}" stroke="${color}" stroke-dasharray="4 4" stroke-width="1.3"/>` +
      `<text x="${x(v) + (left ? -4 : 4)}" y="${m.t + 10 + dy}" fill="${color}" font-size="11" font-family="JetBrains Mono" font-weight="600" text-anchor="${left ? 'end' : 'start'}">${label}</text>`;
    svg += vline(o.breakeven, C.red, `BE ${fmtMoney(o.breakeven)}`, 28, true);
    svg += vline(o.strike, C.amber, `K ${fmtMoney(o.strike)}`, 14);
    svg += vline(o.spot, C.green, `now ${fmtMoney(o.spot)}`, 0);
    svg += `<text x="${w - m.r - 4}" y="${y(maxP) - 6}" fill="${C.green}" font-size="11" text-anchor="end" font-family="JetBrains Mono" font-weight="600">max profit $${maxP.toFixed(0)}</text>`;
    svg += `<circle class="pd" r="4" fill="${C.text}" opacity="0"/>`;
    svg += `<rect class="hit" x="${m.l}" y="${m.t}" width="${w - m.l - m.r}" height="${h - m.t - m.b}" fill="transparent"/>`;
    svg += '</svg>';
    el.innerHTML = svg;

    const s = el.querySelector('svg');
    const pd = s.querySelector('.pd');
    const hit = s.querySelector('.hit');
    hit.addEventListener('pointermove', (evt) => {
      const r = s.getBoundingClientRect();
      const px = (evt.clientX - r.left) * (w / r.width);
      const price = x0 + ((px - m.l) / (w - m.l - m.r)) * (x1 - x0);
      const pl = CSP.payoff(o.strike, o.premium, price) * o.contracts;
      pd.setAttribute('cx', x(price)); pd.setAttribute('cy', y(pl)); pd.setAttribute('opacity', 1);
      const chg = price / o.spot - 1;
      showTip(evt, `Price at expiry <b>${fmtMoney(price)}</b> (${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(1)}%)<br>` +
        `P/L <b style="color:${pl >= 0 ? C.green : C.red}">${pl >= 0 ? '+' : '−'}$${Math.abs(pl).toFixed(0)}</b>` +
        (price < o.strike ? '<br><span style="color:#8a9bb0">assigned: you own the shares</span>' : ''));
    });
    hit.addEventListener('pointerleave', () => { hideTip(); pd.setAttribute('opacity', 0); });
  }

  /** Annualised yield bars per strike with probability-of-keeping-premium line. */
  function ladderChart(el, o) {
    const { w, h } = size(el);
    const m = { l: 46, r: 46, t: 14, b: 26 };
    const rows = o.rows;
    if (!rows.length) { el.innerHTML = '<div class="muted" style="padding:20px">No strikes for this expiry.</div>'; return; }
    const maxY = Math.max(0.1, Math.min(1.5, Math.max(...rows.map((r) => r.annualized)) * 1.1));
    const x = scale(0, rows.length, m.l, w - m.r);
    const y = scale(0, maxY, h - m.b, m.t);
    const yp = scale(0, 1, h - m.b, m.t);
    const bw = Math.max(2, (x(1) - x(0)) * 0.7);
    let svg = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`;
    svg += '<g class="grid">';
    for (const t of niceTicks(0, maxY, 4)) svg += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += '</g><g class="axis">';
    for (const t of niceTicks(0, maxY, 4)) svg += `<text x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${(t * 100).toFixed(0)}%</text>`;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) svg += `<text x="${w - m.r + 6}" y="${yp(t) + 4}" fill="${C.blue}">${t * 100}%</text>`;
    const every = Math.ceil(rows.length / Math.max(4, Math.floor(w / 60)));
    rows.forEach((r, i) => { if (i % every === 0) svg += `<text x="${x(i + 0.5)}" y="${h - 8}" text-anchor="middle">${fmtMoney(r.strike)}</text>`; });
    svg += '</g>';
    rows.forEach((r, i) => {
      const sel = r.contract === o.selected;
      const color = !r.eligible ? '#34465c' : sel ? C.amber : C.green;
      const yy = y(Math.min(r.annualized, maxY));
      svg += `<rect data-i="${i}" x="${x(i + 0.5) - bw / 2}" y="${yy}" width="${bw}" height="${Math.max(0, h - m.b - yy)}" rx="2" fill="${color}" opacity="${sel ? 1 : 0.8}" style="cursor:pointer"/>`;
    });
    svg += `<path d="${path(rows.map((r, i) => [x(i + 0.5), yp(r.pop)]))}" fill="none" stroke="${C.blue}" stroke-width="2"/>`;
    svg += '</svg>';
    el.innerHTML = svg;
    el.querySelectorAll('rect[data-i]').forEach((b) => {
      const r = rows[+b.dataset.i];
      b.addEventListener('pointermove', (evt) => showTip(evt,
        `Strike <b>${fmtMoney(r.strike)}</b> · premium ${r.premium.toFixed(2)}<br>` +
        `Annualised <b>${(r.annualized * 100).toFixed(1)}%</b><br>Keep premium <b>${(r.pop * 100).toFixed(0)}%</b> · Δ ${r.delta.toFixed(2)}`));
      b.addEventListener('pointerleave', hideTip);
      b.addEventListener('click', () => { hideTip(); o.onSelect && o.onSelect(r); });
    });
  }

  root.Charts = { priceChart, payoffChart, ladderChart, niceTicks, hideTip };
})(typeof self !== 'undefined' ? self : this);
