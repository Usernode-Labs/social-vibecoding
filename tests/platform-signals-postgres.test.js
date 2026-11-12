'use strict';

// services/platform-signals.js against the FULL PostgreSQL schema: a
// problem's whole life (raised, filed, counted, cleared, closed, back again),
// shadow mode, the bot's slots and holds, the topic page's list, and the
// figures that read the rows. GitHub, the bot's queue and notifications are
// stubbed; the observers are replaced by the test's own list of what is
// happening now.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const signals = require('../src/services/platform-signals');

const MIN = 60 * 1000;

function fakeDeps(pool, seen) {
  const calls = { created: [], reopened: [], comments: [], closed: [], patched: [], fronted: [], notified: [] };
  let next = 100;
  const deps = {
    github: {
      isEnabled: () => true,
      createIssue: async (owner, repo, { title }) => { next += 1; calls.created.push({ owner, repo, title, number: next }); return { number: next }; },
      reopenIssue: async (_o, _r, n) => { calls.reopened.push(n); },
      patchIssueBody: async (_o, _r, n) => { calls.patched.push(n); },
      createIssueComment: async (_o, _r, n, body) => { calls.comments.push({ n, body }); },
      closeIssue: async (_o, _r, n, opts) => { calls.closed.push({ n, reason: opts?.reason }); },
    },
    budget: { budgetAllows: () => true },
    observers: () => ({ observeAll: async () => ({ items: seen.items, ok: new Set(seen.ok) }) }),
    bot: () => ({
      ensureBotUser: async (p) => (await p.query(
        `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE)
         ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username RETURNING id`)).rows[0],
      enqueueFront: async (_p, args) => { calls.fronted.push(args.issueNumber); },
      noteIssueActivity: () => {},
    }),
    notifications: () => ({
      createPlatformIncidentNotifications: async (_p, args) => { calls.notified.push(args.detail); return []; },
      hydrateAndPush: async () => {},
    }),
  };
  return { deps, calls };
}

const wf = (key, extra = {}) => ({
  kind: 'workflow', key, fileAfterMs: 0, title: `Stuck work in ${key}`,
  evidence: { lines: [`${key} faulted`] }, ...extra,
});
const limit = (key) => ({ kind: 'limit', key, title: `Platform limit full: ${key}`, evidence: { lines: ['12 of 12'] } });

async function rowOf(pool, fingerprint) {
  const { rows } = await pool.query(
    'SELECT * FROM platform_signals WHERE fingerprint = $1 ORDER BY id DESC LIMIT 1', [fingerprint]);
  return rows[0] || null;
}

test('platform signals against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `platform_signals_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const savedEnv = { mode: process.env.PLATFORM_SIGNALS, kinds: process.env.PLATFORM_SIGNALS_KINDS, bot: process.env.PLATFORM_SIGNALS_BOT };
  t.after(async () => {
    for (const [k, v] of [['PLATFORM_SIGNALS', savedEnv.mode], ['PLATFORM_SIGNALS_KINDS', savedEnv.kinds], ['PLATFORM_SIGNALS_BOT', savedEnv.bot]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  delete process.env.PLATFORM_SIGNALS_KINDS;
  delete process.env.PLATFORM_SIGNALS_BOT;

  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url, self_hosted)
     VALUES ('Homeroom', 'usernode-2d5619', 'running', 'https://github.com/Usernode-Labs/social-vibecoding', TRUE)
     RETURNING id`);
  const { rows: [person] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('evan', 'x') RETURNING id`);
  const seen = { items: [], ok: ['workflow', 'limit'] };

  await t.test('shadow mode keeps the rows and files nothing', async () => {
    process.env.PLATFORM_SIGNALS = 'shadow';
    const { deps, calls } = fakeDeps(pool, seen);
    seen.items = [wf('preview:faulted:x', { fileAfterMs: 10 * MIN })];
    await signals.sweep(pool, {}, { deps });
    let row = await rowOf(pool, 'workflow:preview:faulted:x');
    assert.equal(row.state, 'pending', 'inside its delay');
    assert.equal(row.app_id, app.id, 'on the platform\'s own board');
    assert.equal(row.topic_key, 'proposal-pipeline');
    await pool.query(`UPDATE platform_signals SET first_seen_at = NOW() - interval '11 minutes' WHERE id = $1`, [row.id]);
    await signals.sweep(pool, {}, { deps });
    row = await rowOf(pool, 'workflow:preview:faulted:x');
    assert.deepEqual([row.state, row.issue_number], ['open', null], 'recorded, not filed');
    assert.equal(calls.created.length, 0);

    // Before filing is on, only full admins see it on the topic page.
    assert.deepEqual((await signals.openForTopic(pool, { appId: app.id, topicKey: 'proposal-pipeline' })).signals, []);
    const forAdmin = (await signals.openForTopic(pool, { appId: app.id, topicKey: 'proposal-pipeline', fullAdmin: true })).signals;
    assert.deepEqual(forAdmin.map((s) => [s.kind, s.who, s.adminSection]), [['workflow', 'bot', 'workflows']]);

    // It stopped: clearing, then closed once quiet, with nothing on GitHub.
    seen.items = [];
    await signals.sweep(pool, {}, { deps });
    row = await rowOf(pool, 'workflow:preview:faulted:x');
    assert.equal(row.state, 'clearing');
    await pool.query(`UPDATE platform_signals SET cleared_at = NOW() - interval '31 minutes' WHERE id = $1`, [row.id]);
    await signals.sweep(pool, {}, { deps });
    row = await rowOf(pool, 'workflow:preview:faulted:x');
    assert.deepEqual([row.state, row.close_reason], ['closed', 'cleared']);
    assert.equal(calls.closed.length, 0);
  });

  await t.test('a blip that stops before its delay closes without ever filing', async () => {
    process.env.PLATFORM_SIGNALS = 'file';
    const { deps, calls } = fakeDeps(pool, seen);
    seen.items = [wf('shots:stalled:x', { fileAfterMs: 10 * MIN })];
    await signals.sweep(pool, {}, { deps });
    seen.items = [];
    await signals.sweep(pool, {}, { deps });
    const row = await rowOf(pool, 'workflow:shots:stalled:x');
    assert.deepEqual([row.state, row.close_reason], ['closed', 'blip']);
    assert.equal(calls.created.length, 0);
  });

  let wfIssue;
  let limitIssue;
  await t.test('filing: one request each, the bot\'s queue for a bot problem, the admins for a person\'s', async () => {
    process.env.PLATFORM_SIGNALS = 'file';
    const { deps, calls } = fakeDeps(pool, seen);
    seen.items = [wf('merge-queue:faulted:boom'), limit('apps')];
    const out = await signals.sweep(pool, {}, { deps });
    assert.equal(out.filed, 2);
    const w = await rowOf(pool, 'workflow:merge-queue:faulted:boom');
    const l = await rowOf(pool, 'limit:apps');
    wfIssue = w.issue_number;
    limitIssue = l.issue_number;
    assert.deepEqual([w.state, l.state], ['open', 'open']);
    assert.deepEqual(calls.fronted, [wfIssue], 'the bot\'s problem goes to the front of its queue');
    assert.deepEqual(calls.notified, [`signal:${limitIssue}`], 'a person\'s problem tells the full admins');
    const { rows: issues } = await pool.query(
      `SELECT github_issue_number, status, payload FROM issues WHERE app_id = $1 ORDER BY github_issue_number`, [app.id]);
    assert.deepEqual(issues.map((i) => [i.github_issue_number, i.status]), [[wfIssue, 'open'], [limitIssue, 'open']]);
    assert.equal(issues[0].payload.signalId, Number(w.id));

    // Seen again: counted in the row, nothing new on GitHub.
    await signals.sweep(pool, {}, { deps });
    assert.equal(calls.created.length, 2);
    assert.equal((await rowOf(pool, 'limit:apps')).state, 'open');

    // The bot is held off the person's problem, not its own.
    const held = await signals.heldIssues(pool, app.id);
    assert.deepEqual(held.map((h) => Number(h.n)), [limitIssue]);
    const forIssue = await signals.forIssue(pool, app.id, wfIssue);
    assert.deepEqual([forIssue.kind, forIssue.fixer], ['workflow', 'bot']);
    const topics = await signals.topicsByIssue(pool, app.id);
    assert.equal(topics.get(limitIssue), 'infra');

    // Filing is on: everybody who can read the topic sees a filed problem.
    const open = (await signals.openForTopic(pool, { appId: app.id, topicKey: 'infra' })).signals;
    assert.deepEqual(open.map((s) => [s.issueNumber, s.who, s.whoText, s.adminSection]), [[limitIssue, 'person', 'Waiting for a person', null]]);
  });

  await t.test('a body is rewritten when the problem happens four times as often', async () => {
    const { deps, calls } = fakeDeps(pool, seen);
    seen.items = [wf('merge-queue:faulted:boom', { occurrences: 40 }), limit('apps')];
    await signals.sweep(pool, {}, { deps });
    assert.deepEqual(calls.patched, [wfIssue]);
    await signals.sweep(pool, {}, { deps });
    assert.deepEqual(calls.patched, [wfIssue], 'once per material change');
  });

  await t.test('cleared: never closed while a person is talking about it; then closed as not planned', async () => {
    const { deps, calls } = fakeDeps(pool, seen);
    seen.items = [wf('merge-queue:faulted:boom', { occurrences: 40 })];
    await signals.sweep(pool, {}, { deps });
    let l = await rowOf(pool, 'limit:apps');
    assert.equal(l.state, 'clearing');
    await pool.query(`UPDATE platform_signals SET cleared_at = NOW() - interval '2 hours' WHERE id = $1`, [l.id]);
    const { rows: [msg] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, msg_type)
       VALUES ($1, $2, 'looking at this', 'issue', $3, 'message') RETURNING id`, [app.id, person.id, limitIssue]);
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'limit:apps')).state, 'clearing', 'a person said something today');
    await pool.query('DELETE FROM chat_messages WHERE id = $1', [msg.id]);
    await signals.sweep(pool, {}, { deps });
    l = await rowOf(pool, 'limit:apps');
    assert.deepEqual([l.state, l.close_reason], ['closed', 'cleared']);
    assert.deepEqual(calls.closed, [{ n: limitIssue, reason: 'not_planned' }]);
    assert.match(calls.comments[0].body, /^This stopped:/);
    const { rows: [issue] } = await pool.query(
      'SELECT status FROM issues WHERE app_id = $1 AND github_issue_number = $2', [app.id, limitIssue]);
    assert.equal(issue.status, 'closed');
  });

  await t.test('back within a week: the same request reopens', async () => {
    const { deps, calls } = fakeDeps(pool, seen);
    seen.items = [wf('merge-queue:faulted:boom', { occurrences: 40 }), limit('apps')];
    await signals.sweep(pool, {}, { deps });
    const l = await rowOf(pool, 'limit:apps');
    assert.deepEqual([l.state, l.issue_number], ['open', limitIssue]);
    assert.ok(l.previous_id, 'linked to the episode before');
    assert.deepEqual(calls.reopened, [limitIssue]);
    assert.equal(calls.created.length, 0, 'no second request');
    assert.match(calls.comments[0].body, /^This is happening again/);
  });

  await t.test('a request somebody closed (a fix merged) ends its episode without a comment', async () => {
    const { deps, calls } = fakeDeps(pool, seen);
    await pool.query(
      `UPDATE issues SET status = 'closed' WHERE app_id = $1 AND github_issue_number = $2`, [app.id, wfIssue]);
    const episodes = () => pool.query(
      `SELECT state, close_reason, issue_number FROM platform_signals
        WHERE fingerprint = 'workflow:merge-queue:faulted:boom' ORDER BY id`);
    await signals.sweep(pool, {}, { deps });
    assert.deepEqual((await episodes()).rows.map((r) => [r.state, r.close_reason]), [['closed', 'closed']],
      'the fixed episode is over');
    assert.equal(calls.comments.length, 0, 'the fix said it all');
    // Still happening after its fix merged: the next pass starts a new
    // episode, which reopens the same request.
    await signals.sweep(pool, {}, { deps });
    const rows = (await episodes()).rows;
    assert.deepEqual(rows.map((r) => [r.state, r.issue_number]), [['closed', wfIssue], ['open', wfIssue]]);
    assert.deepEqual(calls.reopened, [wfIssue]);
  });

  await t.test('the hourly cap and a release under way hold new requests', async () => {
    const { deps, calls } = fakeDeps(pool, seen);
    for (let i = 0; i < signals.MAX_FILED_PER_HOUR; i += 1) {
      await pool.query(
        `INSERT INTO platform_signals (fingerprint, kind, app_id, state, filed_at, issue_number)
         VALUES ($1, 'workflow', $2, 'closed', NOW(), $3)`, [`workflow:filler:${i}`, app.id, 900 + i]);
    }
    seen.items = [limit('sessions')];
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'limit:sessions')).state, 'pending');
    await pool.query(`UPDATE platform_signals SET filed_at = NOW() - interval '2 hours' WHERE fingerprint LIKE 'workflow:filler:%'`);
    await pool.query(`INSERT INTO events (event_type, metadata) VALUES ('platform_booted', '{"pod":"p-1"}')`);
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'limit:sessions')).state, 'pending', 'a process booted minutes ago: a release');
    await pool.query(`UPDATE events SET created_at = NOW() - interval '20 minutes' WHERE event_type = 'platform_booted'`);
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'limit:sessions')).state, 'open');
    assert.ok(calls.created.some((c) => c.title === 'Platform limit full: sessions'));
  });

  await t.test('an alert is pushed: raised and cleared by its source, or stale after three hours', async () => {
    const raised = await signals.raise(pool, {
      kind: 'alert', key: 'KubeAPIDown:cluster', title: 'Infra alert: KubeAPIDown on cluster',
      subject: { alertname: 'KubeAPIDown', severity: 'critical' }, evidence: { lines: ['x'] },
    });
    assert.equal(raised.inserted, true);
    const again = await signals.raise(pool, {
      kind: 'alert', key: 'KubeAPIDown:cluster', title: 'Infra alert: KubeAPIDown on cluster',
      subject: { alertname: 'KubeAPIDown', severity: 'critical' }, evidence: { lines: ['x'] },
    });
    assert.deepEqual([again.id, again.inserted], [raised.id, false], 'one row per problem');
    const cleared = await signals.clear(pool, 'alert:KubeAPIDown:cluster');
    assert.equal(cleared.state, 'closed', 'stopped before it was ever filed: a blip');
  });

  await t.test('the figures read the rows', async () => {
    const figures = require('../src/services/topic-figures');
    figures._resetForTests();
    await pool.query(
      `INSERT INTO platform_signals (fingerprint, kind, app_id, state, first_seen_at, cleared_at, closed_at, subject)
       VALUES ('bot_paused:budget', 'bot_paused', $1, 'closed', NOW() - interval '3 hours', NOW() - interval '2 hours', NOW() - interval '1 hour', '{}'),
              ('alert:X:y', 'alert', $1, 'open', NOW() - interval '1 hour', NULL, NULL, '{"severity":"critical"}'),
              ('alert:W:z', 'alert', $1, 'open', NOW() - interval '1 hour', NULL, NULL, '{"severity":"warning"}')`, [app.id]);
    const strip = await figures.figuresFor(pool, ['bot.paused', 'infra.alerts', 'pipeline.stuck-work', 'pipeline.not-the-change']);
    const byId = new Map(strip.figures.map((f) => [f.id, f]));
    assert.equal(byId.get('bot.paused').value, '1 time');
    assert.match(byId.get('bot.paused').sub, /^1 h in all/);
    assert.equal(byId.get('infra.alerts').value, '1 time', 'critical alerts only');
    assert.notEqual(byId.get('pipeline.stuck-work').state, 'error');
    assert.notEqual(byId.get('pipeline.not-the-change').state, 'error');
  });

  await t.test('security files private requests by upgrade, and the bot an upgrade request that says only what to upgrade', async () => {
    // Real compatibility methods write requests, without a GitHub issue client.
    const requests = require('../src/services/requests');
    const github = require('../src/services/github');
    const audit = require('../src/services/signal-observers/security-audit');
    const { COMPONENTS } = require('../src/services/security-audit-report');
    requests.setPool(pool);
    requests.invalidateApps();
    t.after(() => requests._resetForTests());
    await pool.query('DELETE FROM platform_signals');
    process.env.PLATFORM_SIGNALS = 'shadow';
    const securityEnv = process.env.PLATFORM_SIGNALS_SECURITY_AUDIT;
    process.env.PLATFORM_SIGNALS_SECURITY_AUDIT = 'on';
    t.after(() => {
      if (securityEnv === undefined) delete process.env.PLATFORM_SIGNALS_SECURITY_AUDIT;
      else process.env.PLATFORM_SIGNALS_SECURITY_AUDIT = securityEnv;
    });
    const { deps, calls } = fakeDeps(pool, seen);
    deps.github = { ...github, isEnabled: () => true };
    const now = Date.now();
    // Debian's openssl and libssl3 share their advisories: one upgrade.
    const ssl = (extra = {}) => [
      { id: 'CVE-2026-12345', package: 'libssl3', version: '3.5.0-r0', severity: 'HIGH', fixedVersion: null, ...extra },
      { id: 'CVE-2026-12345', package: 'openssl', version: '3.5.0-r0', severity: 'HIGH', fixedVersion: null, ...extra },
      { id: 'CVE-2026-12346', package: 'openssl', version: '3.5.0-r0', severity: 'HIGH', fixedVersion: null, ...extra },
    ];
    let findings = ssl();
    let complete = true;
    const observe = async () => {
      const previous = (await pool.query("SELECT * FROM platform_signals WHERE kind IN ('security', 'security_audit') AND state <> 'closed'")).rows;
      return audit.itemsFrom({ complete, report: { components: COMPONENTS.map((component) => ({ component, findings })) } }, previous, app, now);
    };
    deps.observers = () => ({ observeAll: observe });
    const boardCount = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM requests WHERE app_id = $1', [app.id])).rows[0].n;
    const privateRow = async (id) => (await pool.query('SELECT * FROM private_requests WHERE id = $1', [id])).rows[0];
    const privateComments = async (id) => (await pool.query(
      'SELECT body FROM private_request_comments WHERE private_request_id = $1 ORDER BY id', [id])).rows.map((r) => r.body);

    await signals.sweep(pool, {}, { deps });
    let row = await rowOf(pool, 'security:libssl3');
    assert.ok(row, 'one row for the upgrade, keyed by its first package');
    assert.equal(await rowOf(pool, 'security:CVE-2026-12345'), null, 'no row per advisory');
    assert.equal(row.fixer, 'person');
    assert.equal(row.issue_number, null, 'nothing on the board');
    assert.equal(await boardCount(), 0);
    const pid = row.private_request_id;
    assert.ok(pid);
    const first = await privateRow(pid);
    assert.equal(first.status, 'open');
    assert.match(first.title, /^Upgrade libssl3 and 1 related package in /);
    assert.match(first.description, /CVE-2026-12345 \(HIGH\), CVE-2026-12346 \(HIGH\)/);
    assert.match(first.description, /Severity: HIGH\. Remediation target: /);
    assert.match(first.description, /no published fix/);
    assert.deepEqual(calls.notified, [`private:${pid}`], 'full admins are told, privately');
    assert.equal(calls.fronted.length, 0);
    assert.deepEqual((await signals.openForTopic(pool, { appId: app.id, topicKey: 'infra' })).signals, [],
      'a private request is not on the topic page for anybody but full admins');
    assert.equal((await signals.openForTopic(pool, { appId: app.id, topicKey: 'infra', fullAdmin: true })).signals.length, 1);
    await signals.sweep(pool, {}, { deps });
    assert.equal((await privateRow(pid)).updated_at.getTime(), first.updated_at.getTime(), 'an unchanged audit changes nothing');

    // A fix is published: the bot gets a request on the board that names the
    // upgrade and nothing private.
    findings = ssl({ fixedVersion: '3.5.1-r0' });
    await signals.sweep(pool, {}, { deps });
    row = await rowOf(pool, 'security:libssl3');
    assert.equal(row.fixer, 'bot');
    const n = row.issue_number;
    assert.ok(n);
    assert.deepEqual(calls.fronted, [n], 'handed to the bot');
    const board = (await pool.query('SELECT * FROM requests WHERE app_id = $1 AND number = $2', [app.id, n])).rows[0];
    assert.equal(board.title, (await privateRow(pid)).title);
    assert.match(board.body, /libssl3 3\.5\.0-r0, upgrade to 3\.5\.1-r0 or later/);
    assert.doesNotMatch(`${board.title}\n${board.body}`, /CVE-|HIGH|Remediation|target|advisor|security/i);
    assert.match((await privateComments(pid)).at(-1), new RegExp(`request #${n}`));
    await signals.sweep(pool, {}, { deps });
    assert.deepEqual(calls.fronted, [n], 'handed on once');
    assert.equal(await boardCount(), 1);

    // The upgrade merges, and the audit still finds the old versions: the row
    // stays open, and a day and a half later a person is told, once.
    await github.closeIssue('Usernode-Labs', 'social-vibecoding', n);
    await pool.query("UPDATE issues SET status = 'closed' WHERE app_id = $1 AND github_issue_number = $2", [app.id, n]);
    await signals.sweep(pool, {}, { deps });
    row = await rowOf(pool, 'security:libssl3');
    assert.equal(row.state, 'open', 'closing the upgrade request does not close the problem');
    assert.ok(row.upgrade_closed_at);
    assert.equal((await privateRow(pid)).status, 'open');
    await pool.query("UPDATE platform_signals SET upgrade_closed_at = NOW() - interval '37 hours' WHERE id = $1", [row.id]);
    calls.notified.length = 0;
    await signals.sweep(pool, {}, { deps });
    await signals.sweep(pool, {}, { deps });
    assert.deepEqual(calls.notified, [`private:${pid}`]);
    assert.match((await privateComments(pid)).at(-1), /still finds this .* needs a person/);
    assert.equal(await boardCount(), 1, 'no second upgrade request while nothing changed');

    // What needs upgrading changes (a newer fix): the bot gets a new request.
    findings = ssl({ fixedVersion: '3.5.2-r0' });
    await signals.sweep(pool, {}, { deps });
    row = await rowOf(pool, 'security:libssl3');
    assert.notEqual(row.issue_number, n);
    assert.equal(await boardCount(), 2);
    assert.equal(row.escalated_at, null);
    const n2 = row.issue_number;

    // Holds, as before: a failed refresh, an incomplete audit and a failed
    // observer all keep it open.
    findings = [];
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'security:libssl3')).state, 'clearing');
    await pool.query("UPDATE platform_signals SET cleared_at = NOW() - interval '1 hour' WHERE id = $1", [row.id]);
    findings = ssl({ fixedVersion: '3.5.2-r0' });
    const query = pool.query;
    pool.query = function (sql, ...args) {
      if (/INSERT INTO platform_signals/.test(sql)) return Promise.reject(new Error('injected refresh failure'));
      return query.call(this, sql, ...args);
    };
    try { await signals.sweep(pool, {}, { deps }); } finally { pool.query = query; }
    assert.equal((await rowOf(pool, 'security:libssl3')).state, 'open', 'observed finding cannot close after a failed refresh upsert');
    findings = [];
    await signals.sweep(pool, {}, { deps });
    await pool.query("UPDATE platform_signals SET cleared_at = NOW() - interval '1 hour' WHERE id = $1", [row.id]);
    complete = false;
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'security:libssl3')).state, 'open', 'incomplete audit restores retained finding');
    complete = true;
    await signals.sweep(pool, {}, { deps });
    await pool.query("UPDATE platform_signals SET cleared_at = NOW() - interval '1 hour' WHERE id = $1", [row.id]);
    deps.observers = () => ({ observeAll: async () => ({ items: [], ok: new Set() }) });
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'security:libssl3')).state, 'open', 'observer failure breaks the quiet window too');
    deps.observers = () => ({ observeAll: observe });
    await signals.sweep(pool, {}, { deps });
    assert.equal((await privateRow(pid)).status, 'open', 'recovery starts a new quiet window');

    // The audit is clean and stays so: both requests close.
    await pool.query("UPDATE platform_signals SET cleared_at = NOW() - interval '1 hour' WHERE id = $1", [row.id]);
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'security:libssl3')).state, 'closed');
    assert.equal((await privateRow(pid)).status, 'closed');
    assert.match((await privateComments(pid)).at(-1), /This stopped/);
    assert.equal((await pool.query('SELECT state FROM requests WHERE app_id = $1 AND number = $2', [app.id, n2])).rows[0].state, 'closed');

    // It comes back within 7 days: the same private request reopens, and the
    // bot gets a new upgrade request.
    findings = ssl({ fixedVersion: '3.5.2-r0' });
    await signals.sweep(pool, {}, { deps });
    row = await rowOf(pool, 'security:libssl3');
    assert.equal(row.private_request_id, pid);
    assert.equal((await privateRow(pid)).status, 'open', 'recurrence reopens the same private request');
    assert.equal(await boardCount(), 3);

    // An admin closes the private request: the problem's episode ends, and
    // so does the bot's request.
    await pool.query("UPDATE private_requests SET status = 'closed', closed_at = NOW() WHERE id = $1", [pid]);
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'security:libssl3')).close_reason, 'closed');
    assert.equal((await pool.query('SELECT state FROM requests WHERE app_id = $1 AND number = $2', [app.id, row.issue_number])).rows[0].state, 'closed');
  });

  await t.test('a request filed per advisory before grouping is retired with a note, once the audit no longer files it', async () => {
    process.env.PLATFORM_SIGNALS = 'file';
    const { deps, calls } = fakeDeps(pool, seen);
    await pool.query('DELETE FROM platform_signals');
    const { rows: [legacy] } = await pool.query(
      `INSERT INTO platform_signals (fingerprint, kind, subject, app_id, topic_key, fixer, state, title, issue_number, filed_at)
       VALUES ('security:CVE-2026-99999', 'security', $1::jsonb, $2, 'infra', 'person', 'open', 'Security: CVE-2026-99999 affects Homeroom', 4321, NOW())
       RETURNING id`,
      [JSON.stringify({ advisory: 'CVE-2026-99999', findings: [], dueAt: new Date().toISOString() }), app.id]);
    deps.observers = () => ({ observeAll: async () => ({ items: [], ok: new Set(['security', 'security_audit']) }) });
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'security:CVE-2026-99999')).state, 'clearing');
    await pool.query("UPDATE platform_signals SET cleared_at = NOW() - interval '1 hour' WHERE id = $1", [legacy.id]);
    await signals.sweep(pool, {}, { deps });
    assert.equal((await rowOf(pool, 'security:CVE-2026-99999')).state, 'closed');
    assert.deepEqual(calls.comments.map((c) => c.n), [4321]);
    assert.match(calls.comments[0].body, /private requests, one per upgrade/);
    assert.doesNotMatch(calls.comments[0].body, /This stopped/);
  });
});
