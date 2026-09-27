'use strict';
function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/** Wrap a (URL) => Promise<result> job as a GET-only JSON endpoint. */
function endpoint(name, job, cache) {
  return async function handler(req, res, run = job) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url, 'http://localhost');
    try {
      const result = await run(url);
      return send(res, 200, result, { 'Cache-Control': cache });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`${name} failed:`, err.cause || err);
      const message = err.status ? err.message : 'Unexpected server error.';
      return send(res, status, { error: message }, { 'Cache-Control': 'no-store' });
    }
  };
}
module.exports = { send, endpoint };
