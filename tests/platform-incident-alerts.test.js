'use strict';

// #4296: the unexpected events digest and hourly alert
// (src/services/platform-incident-alerts.js), and the incident list the
// admin console's Unexpected events section reads
// (src/services/platform-incidents.js list). No database: the decisions are
// pure, and the sweep and the list are driven through a recording pool.

const test = require('node:test');
const assert = require('node:assert/strict');

const alerts = require('../src/services/platform-incident-alerts');
const incidents = require('../src/services/platform-incidents');

test('the hourly line and the digest hour are named constants', () => {
  assert.equal(alerts.HOURLY_THRESHOLD, 5);
  assert.equal(alerts.DIGEST_HOUR_UTC, 15);
  assert.equal(alerts.digestDue(new Date('2026-10-07T14:59:00Z')), false);
  assert.equal(alerts.digestDue(new Date('2026-10-07T15:00:00Z')), true);
  assert.equal(alerts.digestDue(new Date('2026-10-07T23:30:00Z')), true);
});

test('a digest counts every kind, lists what fits in 32 characters, and is nothing for a quiet day', () => {
  assert.equal(alerts.digestToken([]), null);
  assert.equal(alerts.digestToken([{ kind: 'build_interrupted', n: 0 }]), null);
  assert.equal(alerts.digestToken([{ kind: 'build_interrupted', n: 7 }]), 'digest:7:build_interrupted=7');
  const two = alerts.digestToken([{ kind: 'build_interrupted', n: 7 }, { kind: 'deploy_failed', n: 2 }]);
  assert.equal(two, 'digest:9:build_interrupted=7', 'the second kind does not fit, but the total counts it');
  assert.ok(two.length <= 32);
  assert.equal(alerts.digestToken([{ kind: 'stuck', n: 3 }, { kind: 'lost', n: 1 }]), 'digest:4:stuck=3,lost=1');
  assert.deepEqual(alerts.parseDetail('digest:9:build_interrupted=7'),
    { type: 'digest', total: 9, kinds: [{ kind: 'build_interrupted', n: 7 }] });
  assert.deepEqual(alerts.parseDetail('digest:4:stuck=3,lost=1'),
    { type: 'digest', total: 4, kinds: [{ kind: 'stuck', n: 3 }, { kind: 'lost', n: 1 }] });
});

test('an hour alert is one kind at or past its line', () => {
  const out = alerts.hourAlerts([{ kind: 'build_interrupted', n: 6 }, { kind: 'stuck', n: 4 }]);
  assert.deepEqual(out, [{ kind: 'build_interrupted', n: 6, detail: 'hour:build_interrupted:6' }]);
  assert.deepEqual(alerts.hourAlerts([{ kind: 'stuck', n: 5 }]).map((a) => a.detail), ['hour:stuck:5']);
  assert.deepEqual(alerts.parseDetail('hour:build_interrupted:6'), { type: 'hour', kind: 'build_interrupted', n: 6 });
  assert.equal(alerts.parseDetail('apps_warn:40:50'), null);
  assert.equal(alerts.hourToken('Not A Kind', 5), null);
});

function sweepPool(counts) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/GROUP BY 1/.test(sql)) {
        // countByKind: [since, until] → which window is asked for.
        const key = params[2] ? 'day' : 'hour';
        return { rows: counts[key] || [] };
      }
      return { rows: [] };
    },
    async connect() {
      return { query: this.query.bind(this), release() {} };
    },
  };
}

test('the sweep sends the hour alert and the day before\'s digest to full admins once', async () => {
  const pool = sweepPool({
    hour: [{ kind: 'build_interrupted', n: 6 }],
    day: [{ kind: 'build_interrupted', n: 9 }],
  });
  const created = [];
  const published = [];
  const now = new Date('2026-10-07T16:02:00Z');
  const summary = await alerts.sweep(pool, {
    now,
    staging: false,
    create: async (_db, args) => { created.push(args); return [{ id: created.length }]; },
    publish: async (_p, row) => { published.push(row.id); },
  });
  assert.deepEqual(created.map((c) => [c.detail, c.dedupePrefix]), [
    ['hour:build_interrupted:6', 'hour:build_interrupted:'],
    ['digest:9:build_interrupted=9', 'digest:'],
  ]);
  assert.equal(created[0].since.toISOString(), '2026-10-07T15:02:00.000Z', 'at most once per kind per hour');
  assert.equal(created[1].since.toISOString(), '2026-10-07T00:00:00.000Z', 'at most one digest per UTC day');
  const day = pool.queries.find((q) => q.params[2]);
  assert.equal(day.params[1].toISOString(), '2026-10-06T00:00:00.000Z', 'the digest is the previous UTC day');
  assert.equal(day.params[2].toISOString(), '2026-10-07T00:00:00.000Z');
  assert.ok(pool.queries.some((q) => /pg_advisory_xact_lock/.test(q.sql)), 'one sweep at a time');
  assert.deepEqual(published, [1, 2]);
  assert.deepEqual(summary.digest, { detail: 'digest:9:build_interrupted=9', recipients: 1 });
});

test('the sweep stays quiet before the digest hour, on a quiet day, and in a preview', async () => {
  const create = async () => { throw new Error('should not notify'); };
  const early = sweepPool({ day: [{ kind: 'build_interrupted', n: 9 }] });
  await alerts.sweep(early, { now: new Date('2026-10-07T09:00:00Z'), staging: false, create });
  assert.equal(early.queries.filter((q) => q.params[2]).length, 0, 'the day is not even counted before the hour');

  const quiet = sweepPool({ hour: [{ kind: 'build_interrupted', n: 4 }], day: [] });
  const summary = await alerts.sweep(quiet, { now: new Date('2026-10-07T16:00:00Z'), staging: false, create });
  assert.deepEqual(summary, { hour: [], digest: null });

  const preview = sweepPool({ hour: [{ kind: 'build_interrupted', n: 50 }], day: [{ kind: 'build_interrupted', n: 50 }] });
  await alerts.sweep(preview, { now: new Date('2026-10-07T16:00:00Z'), staging: true, create });
});

test('the list reads every filter as a parameter, and ignores one that is not a kind or a slug', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/to_char/.test(sql)) return { rows: [{ day: '2026-10-07', kind: 'build_interrupted', n: 2 }] };
      if (/DISTINCT a\.slug/.test(sql)) return { rows: [{ slug: 'recipebot' }] };
      if (/GROUP BY 1/.test(sql)) return { rows: [{ kind: 'build_interrupted', n: 2 }] };
      return {
        rows: [{
          created_at: new Date('2026-10-07T10:00:00Z'), session_id: 41, app_slug: 'recipebot',
          metadata: { kind: 'build_interrupted', runId: 12, issueNumber: 7, why: 'the worker is gone', outcome: 'resumed' },
        }],
      };
    },
  };
  const out = await incidents.list(pool, { days: '30', kind: 'build_interrupted', app: 'recipebot' });
  assert.equal(out.days, 30);
  assert.equal(out.total, 2);
  assert.deepEqual(out.items[0], {
    at: '2026-10-07T10:00:00.000Z', kind: 'build_interrupted', app: 'recipebot', sessionId: 41,
    runId: 12, issueNumber: 7, why: 'the worker is gone', outcome: 'resumed',
  });
  assert.deepEqual(out.kinds, [{ kind: 'build_interrupted', n: 2 }]);
  assert.deepEqual(out.apps, ['recipebot']);
  assert.deepEqual(queries[0].params, ['platform_incident', 30, 'build_interrupted', 'recipebot', 100]);

  queries.length = 0;
  const loose = await incidents.list(pool, { days: 9, kind: "x' OR 1=1", app: 'Not A Slug' });
  assert.equal(loose.days, 7, 'a range it does not offer reads the last week');
  assert.deepEqual(queries[0].params.slice(2, 4), [null, null]);
});

test('the list is null, not a throw, when it cannot be read', async () => {
  const pool = { async query() { throw new Error('down'); } };
  assert.equal(await incidents.list(pool, {}), null);
});
