'use strict';
// Vercel serverless function: GET /api/scan  -> ranked best cash-secured put ideas now
const { scan } = require('../src/scan');
const { endpoint } = require('./_send');

const handler = endpoint('scan', (url) => scan({ fresh: url.searchParams.get('fresh') === '1' }), 'public, max-age=0, s-maxage=90, stale-while-revalidate=180');
module.exports = (req, res) => handler(req, res);
module.exports.handler = handler;
