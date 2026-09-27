'use strict';
// Local server: static files from public/ + /api/analyze + /api/scan.
// (On Vercel, public/ is served statically and api/*.js run as functions.)
const http = require('http');
const fs = require('fs');
const path = require('path');
const analyzeApi = require('./api/analyze');
const scanApi = require('./api/scan');

const PORT = Number(process.env.PORT) || 5700;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

/** File path for a URL path inside `root`, or { error } (400 bad encoding, 403 escape). */
function resolveStatic(root, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return { error: 400 }; }
  if (rel.includes('\0')) return { error: 400 };
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(root, '.' + path.posix.normalize('/' + rel.replace(/\\/g, '/')));
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { error: 403 };
  return { file };
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

function createServer({ publicDir = PUBLIC_DIR, runAnalyze, runScan } = {}) {
  return http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendText(res, 400, 'Bad request'); }
    const api = url.pathname === '/api/analyze' ? [analyzeApi.handler, runAnalyze]
      : url.pathname === '/api/scan' ? [scanApi.handler, runScan] : null;
    if (api) {
      const [handler, run] = api;
      return handler(req, res, run).catch(() => { if (!res.headersSent) sendText(res, 500, 'Server error'); });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    const { file, error } = resolveStatic(publicDir, url.pathname);
    if (error) return sendText(res, error, error === 400 ? 'Bad request' : 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return sendText(res, 404, 'Not found');
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`Cash-Secured Puts on http://localhost:${PORT}`));
}

module.exports = { createServer, resolveStatic };
