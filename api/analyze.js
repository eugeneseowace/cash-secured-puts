'use strict';
// Vercel serverless function: GET /api/analyze?symbol=AAPL
const { analyze } = require('../src/analyze');
const { endpoint } = require('./_send');

const handler = endpoint('analyze', (url) => analyze(url.searchParams.get('symbol')), 'public, max-age=0, s-maxage=60, stale-while-revalidate=120');
module.exports = (req, res) => handler(req, res);
module.exports.handler = handler;
