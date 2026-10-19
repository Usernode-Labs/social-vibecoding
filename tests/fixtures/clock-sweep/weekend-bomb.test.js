'use strict';

// The shape of the two tests #4648 fixed: a card ending five days from now
// is expected to read "5d left", which is true on a Monday and false on a
// weekend, when the week ends first. Never run by `npm test` (it lives
// below tests/); tests/clock-sweep.test.js runs it to show the sweep fails
// it at a weekend instant and passes it at the start of a week.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('a card ending in five days reads 5d left', () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'weekend-bomb.cjs'), 'utf8'), sandbox);
  const cardEnd = Date.now() + 5 * 86400000 - 60000;
  assert.equal(sandbox.window.WeekClock.daysLeft(cardEnd), 5);
});
