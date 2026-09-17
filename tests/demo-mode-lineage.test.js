// Demo mode masks an app's fork lineage (task 457).
//
// The demo app for a recording is a fork of the real one, and the ⑂ badge on
// its tile, the "Forked from" line in Browse and the lineage in the app header
// were the one tell that it was not the real thing. All three read the same
// resolved `forked_from` off the API payload, and attachForkLineage is the one
// place that resolves it, so that is where an app in demo mode goes quiet:
// on the payload only. The row keeps its reference and nothing is written, so
// the lineage is back the moment demo mode goes off.
//
// Run with: node --test tests/demo-mode-lineage.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// routes/apps.js loads a lot; the resolver itself needs only a pool.
const { attachForkLineage } = require('../src/routes/apps');

function pool(names) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT id, name FROM apps WHERE id = ANY/.test(queries.at(-1).sql)) {
        return { rows: params[0].filter((id) => id in names).map((id) => ({ id, name: names[id] })) };
      }
      return { rows: [] };
    },
  };
}

test('a fork in demo mode carries no lineage on the payload; the same fork out of demo mode does', async () => {
  const db = pool({ 7: 'Todo List' });
  const demo = { slug: 'todo-list-b641de', demo_mode: true, forked_from: { appId: 7, slug: 'todo-list-b91765' } };
  const plain = { slug: 'run-club-fork', demo_mode: false, forked_from: { appId: 7, slug: 'todo-list-b91765' } };
  const never = { slug: 'notes', demo_mode: false, forked_from: null };
  await attachForkLineage(db, [demo, plain, never]);

  assert.equal(demo.forked_from, null, 'masked: no badge, no "Forked from"');
  assert.deepEqual(plain.forked_from, { appId: 7, slug: 'todo-list-b91765', name: 'Todo List', linkable: true },
    'a fork that is not in demo mode resolves exactly as before');
  assert.equal(never.forked_from, null);
  assert.equal(demo.demo_mode, true, 'the mode itself is still on the payload: the settings notice reads it');

  // Nothing written: the masking is a property of the payload, not the row.
  assert.ok(db.queries.every((q) => /^SELECT /.test(q.sql)), 'the resolver only reads');
  assert.deepEqual(db.queries[0].params, [[7]], 'and it looked the plain fork\'s source up once');

  // Off again: the same reference resolves, because it was never touched.
  const later = { slug: 'todo-list-b641de', demo_mode: false, forked_from: { appId: 7, slug: 'todo-list-b91765' } };
  await attachForkLineage(pool({ 7: 'Todo List' }), later);
  assert.equal(later.forked_from.name, 'Todo List');
});

test('a demo-mode app whose source is gone is masked the same way, and not looked up', async () => {
  const db = pool({});
  const demo = { slug: 'x', demo_mode: true, forked_from: { appId: 99, slug: 'gone' } };
  await attachForkLineage(db, demo);
  assert.equal(demo.forked_from, null);
  assert.equal(db.queries.length, 0, 'no ids to resolve, no query');
});

test('the single object form and a row with no lineage are unchanged by the mode', async () => {
  const db = pool({});
  const one = { slug: 'y', demo_mode: true, forked_from: null };
  await attachForkLineage(db, one);
  assert.equal(one.forked_from, null);
  const malformed = { slug: 'z', demo_mode: false, forked_from: { nope: true } };
  await attachForkLineage(db, malformed);
  assert.deepEqual(malformed.forked_from, { appId: null, slug: null, name: '<deleted>', linkable: false });
});
