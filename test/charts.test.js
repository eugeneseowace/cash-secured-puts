'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Charts } = require('../public/charts');

test('niceTicks gives round, in-range, increasing steps', () => {
  const t = Charts.niceTicks(93.2, 247.9, 5);
  assert.deepEqual(t, [100, 125, 150, 175, 200, 225]);
  const small = Charts.niceTicks(0.013, 0.071, 4);
  for (let i = 1; i < small.length; i++) assert.ok(small[i] > small[i - 1]);
  assert.ok(small.every((v) => v >= 0.013 && v <= 0.071));
  assert.ok(Charts.niceTicks(5, 5, 4).length >= 1, 'flat range does not loop or return nothing');
  assert.ok(Charts.niceTicks(-4000, 350, 5).includes(0), 'crosses zero cleanly');
});
