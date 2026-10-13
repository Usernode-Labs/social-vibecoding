'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { positiveId } = require('../src/services/row-id');

test('positiveId accepts the int4 range exactly and nothing else', () => {
  assert.equal(positiveId('1'), 1);
  assert.equal(positiveId('2147483647'), 2147483647, 'the SERIAL ceiling is a row id');
  assert.equal(positiveId('2147483648'), null, 'one past the ceiling is refused, not cast');
  assert.equal(positiveId('9999999999'), null, 'ten digits above the ceiling');
  for (const bad of ['', '0', '-1', '12abc', '0101', '1.0', '1e3', ' 1', 'abc', undefined, null]) {
    assert.equal(positiveId(bad), null, `refuses ${JSON.stringify(bad)}`);
  }
});
