'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { createServer, resolveStatic } = require('../server');

function listen(opts) {
  return new Promise((resolve) => {
    const srv = createServer(opts).listen(0, () => resolve({ srv, base: `http://localhost:${srv.address().port}` }));
  });
}

test('static paths cannot escape public/', () => {
  const root = path.join(__dirname, '..', 'public');
  const r = resolveStatic(root, '/%2e%2e/server.js');
  assert.ok(r.error === 403 || r.file.startsWith(root));
  assert.equal(resolveStatic(root, '/%E0%A4%A').error, 400);
  assert.equal(resolveStatic(root, '/').file, path.join(root, 'index.html'));
});

test('serves the page and wires both APIs', async () => {
  const { srv, base } = await listen({
    runAnalyze: async (url) => ({ symbol: url.searchParams.get('symbol') }),
    runScan: async () => ({ rows: [] }),
  });
  try {
    assert.match(await (await fetch(base + '/')).text(), /CSP Finder/);
    const a = await fetch(base + '/api/analyze?symbol=KO');
    assert.equal(a.status, 200);
    assert.deepEqual(await a.json(), { symbol: 'KO' });
    assert.match(a.headers.get('cache-control'), /max-age=0/);
    assert.deepEqual(await (await fetch(base + '/api/scan')).json(), { rows: [] });
    assert.equal((await fetch(base + '/api/scan', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/nope.js')).status, 404);
  } finally {
    srv.close();
  }
});

test('API errors: user errors pass through, internal errors are hidden', async () => {
  const { srv, base } = await listen({
    runAnalyze: async () => { throw Object.assign(new Error('No data found for ZZZ.'), { status: 404 }); },
    runScan: async () => { throw new Error('secret stack detail'); },
  });
  const orig = console.error;
  console.error = () => {};
  try {
    const a = await fetch(base + '/api/analyze?symbol=ZZZ');
    assert.equal(a.status, 404);
    assert.equal((await a.json()).error, 'No data found for ZZZ.');
    const s = await fetch(base + '/api/scan');
    assert.equal(s.status, 500);
    assert.equal((await s.json()).error, 'Unexpected server error.');
  } finally {
    srv.close();
    console.error = orig;
  }
});

test('vercel config keeps server.js out of the deployment', () => {
  const root = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, '.vercelignore'), 'utf8'), /^server\.js$/m);
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(v.framework, null);
  assert.equal(v.outputDirectory, 'public');
});
