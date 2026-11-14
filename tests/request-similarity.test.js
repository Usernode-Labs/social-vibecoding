'use strict';

// The open requests the bot names when it offers to file one that looks the
// same (src/services/request-similarity.js): titles only, plain words, from
// the board the platform already caches.

const test = require('node:test');
const assert = require('node:assert/strict');

const similarity = require('../src/services/request-similarity');

const BOARD = [
  { number: 12, title: 'Dark mode for the workout log' },
  { number: 30, title: 'Change who approves merges' },
  { number: 41, title: 'Export workouts as CSV' },
  { number: 52, title: 'Add a dark theme to the workout logs page' },
  { number: 60, title: 'Typo' },
];

test('a title that shares most of its words with an open request finds it, closest first', () => {
  assert.deepEqual(similarity.similarRequests(BOARD, 'Dark mode on the workout log please'), [
    { number: 12, title: 'Dark mode for the workout log' },
    { number: 52, title: 'Add a dark theme to the workout logs page' },
  ]);
  assert.deepEqual(similarity.similarRequests(BOARD, 'Let the group change who approves merges').map((r) => r.number), [30]);
});

test('one shared word, a different ask, or a title too short to tell finds nothing', () => {
  assert.deepEqual(similarity.similarRequests(BOARD, 'Dark leaderboard'), []);
  assert.deepEqual(similarity.similarRequests(BOARD, 'Share my streak with friends'), []);
  assert.deepEqual(similarity.similarRequests(BOARD, 'Typo'), []);
  assert.deepEqual(similarity.similarRequests(null, 'Dark mode for the workout log'), []);
});

test('plain words and plurals do not count, and Indonesian titles compare too', () => {
  assert.deepEqual([...similarity.titleWords('Please add the new Exports button')], ['export']);
  assert.deepEqual(similarity.similarRequests([{ number: 7, title: 'Tambahkan laporan penjualan harian' }], 'Laporan penjualan harian untuk toko')
    .map((r) => r.number), [7]);
});

test('at most three, and the board is read from the cache, never throwing', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ number: i + 1, title: `Dark mode for the workout log ${i}` }));
  assert.equal(similarity.similarRequests(many, 'Dark mode for the workout log').length, similarity.MAX_SIMILAR);
  const calls = [];
  const github = { async fetchPublicIssues(owner, repo) { calls.push(`${owner}/${repo}`); return { issues: BOARD }; } };
  const parseRepo = (url) => ({ owner: 'o', repo: String(url).split('/').pop() });
  const app = { repo_url: 'https://github.com/o/gym' };
  assert.deepEqual((await similarity.openSimilar(app, 'Export my workouts as a CSV file', { github, parseRepo })).map((r) => r.number), [41]);
  assert.deepEqual(calls, ['o/gym']);
  const broken = { async fetchPublicIssues() { throw new Error('down'); } };
  assert.deepEqual(await similarity.openSimilar(app, 'Export my workouts as a CSV file', { github: broken, parseRepo }), []);
  assert.deepEqual(await similarity.openSimilar({ repo_url: null }, 'Export workouts', { github, parseRepo: () => null }), []);
});


test('closest twins compare open titles once, skip self and gathered threads, and break ties by number', () => {
  const { closestTwins } = require('../src/services/request-similarity');
  const issues = [{ number: 1, title: 'Dark mode resets after refresh' }, { number: 2, title: 'Dark mode resets after refresh' },
    { number: 3, title: 'Dark mode resets after refresh' }, { number: 4, title: 'Dark mode resets after refresh', state: 'closed' },
    { number: 5, title: 'Dark mode resets after refresh', title_fallback: true }, { number: 6, title: 'Export a calendar' }];
  const twins = closestTwins(issues);
  assert.equal(twins.get(1).number, 3);
  assert.equal(twins.get(3).number, 2);
  assert.equal(twins.has(4), false); assert.equal(twins.has(5), false); assert.equal(twins.has(6), false);
  assert.equal(closestTwins(issues.slice(0, 2), { together: () => true }).size, 0);
});

test('board twins use only this project and never pair requests already in the same thread', async () => {
  const { boardTwins } = require('../src/services/request-similarity');
  const rows = [{ number: 1, title: 'Dark mode resets after refresh', thread_id: 7 },
    { number: 2, title: 'Dark mode resets after refresh', thread_id: 7 }];
  const pool = { query: async (sql, params) => { assert.match(sql, /app_id = \$1 AND state = 'open'/); assert.deepEqual(params, [9, 'Untitled']); return { rows }; } };
  assert.equal((await boardTwins(pool, 9, rows, 'Untitled')).size, 0);
  rows[1].thread_id = 8;
  assert.equal((await boardTwins(pool, 9, rows, 'Untitled')).get(1).number, 2);
});
