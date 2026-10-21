'use strict';

// The build's own work (design-step3-app-fleet.md, 3c), against the full
// schema:
//
//   - a clock only the newest build runs (`newestOnly`): an older build's
//     run does nothing, and its targets carry the newest release, so only a
//     process of it claims them (the ready-made images' keys, the
//     translations' catalogs are that build's);
//   - the ready-made apps' images: each key owed a build a target, its row
//     building, then ready or failed; one whose build stopped with its
//     process is owed again; one being built is waited for;
//   - the translations: the one pass owed, as a target;
//   - a release whose work waits out a retry while its processes live is
//     not abandoned at its deadline.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-build-work-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the build\'s own work against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_build_work_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 10 });
  pool.on('error', () => {});
  const runtimes = [];
  const gitSha = process.env.GIT_SHA;
  t.after(async () => {
    if (gitSha === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = gitSha;
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { createRuntime } = require('../src/workflow/kernel/index.ts');
  const clockMod = require('../src/workflow/clock/machine.ts');
  const { clockServices, JOBS } = require('../src/workflow/clock/services.ts');
  const release = require('../src/workflow/release/machine.ts');
  const NEW = 'a'.repeat(40);
  const OLD = 'b'.repeat(40);
  // The platform's serving processes, each of a build, the last started last.
  const serving = async (...builds) => {
    await pool.query(`DELETE FROM platform_processes WHERE id LIKE 'b1-%'`);
    for (const [i, sha] of builds.entries()) {
      await pool.query(`INSERT INTO platform_processes (id, release, role, state, started_at)
                        VALUES ($1, $2, 'conductor', 'serving', now() - make_interval(mins => $3))`, [`b1-${i}`, sha, builds.length - i]);
    }
  };

  await t.test('B1: a newest-build clock does nothing in an older build; its targets are claimed only by the newest', async () => {
    const built = [];
    const resumed = [];
    let targets = [{ target: 'key-1', input: { key: 'k1' } }];
    const job = {
      name: 'build-own', everyMs: 60000, newestOnly: true,
      run: async () => ({ items: targets }),
      item: { run: async (ctx) => {
        built.push([process.env.GIT_SHA, ctx.input.release]);
        resumed.push(ctx.steps().get('paid') ?? null);
        return { ok: true };
      } },
    };
    const services = clockServices([job], { config: {}, pool });
    await serving(OLD, NEW);
    // An older build's run: nothing.
    process.env.GIT_SHA = OLD;
    assert.deepEqual(await services['clock.build-own'].run({ input: { n: 1 }, signal: new AbortController().signal }), { skipped: 'older_build' });
    // The newest's: what it found, and its release.
    process.env.GIT_SHA = NEW;
    const found = await services['clock.build-own'].run({ input: { n: 2 }, signal: new AbortController().signal });
    assert.equal(found.release, NEW);
    assert.equal(services['clock.build-own.item'].ownRelease, true, 'its targets are its own build\'s');

    // Through the machine: the target carries the release, and an older
    // build's runtime never claims it.
    const machine = clockMod.clock();
    const mk = (rel) => { const r = createRuntime({ pool, machines: [machine], services, pollMs: 50, release: rel }); runtimes.push(r); return r; };
    const older = mk(OLD);
    const newer = mk(NEW);
    await newer.append(clockMod.MACHINE, clockMod.clockKey('build-own'),
      { type: 'Arm', payload: { job: 'build-own', everyMs: 60000, firstDueAt: null } },
      { requestKey: 'arm:t', source: { kind: 'system', name: 'release' } });
    await newer.drain();
    await newer.fireTimers();
    await newer.drain();
    await newer.runServices();   // the run (GIT_SHA is NEW here)
    await newer.drain();
    const { rows: [item] } = await pool.query(
      `SELECT input FROM wf_work WHERE machine = 'clock' AND kind = 'clock.build-own.item'`);
    assert.equal(item.input.release, NEW, 'the target names the build that found it');
    process.env.GIT_SHA = OLD;
    await older.runServices();
    assert.deepEqual(built, [], 'an older build does not claim it');
    process.env.GIT_SHA = NEW;
    await newer.runServices();
    assert.deepEqual(built, [[NEW, NEW]]);

    // An item an older build's run handed out (its process gone after it
    // paid for something, before it was done) is claimed by no process of
    // this one: the next run gives it up and asks for its target again, as
    // this build's, carrying on from what it did (a paid batch is not asked
    // for twice). One a live process of that build is working is its own.
    await pool.query(`INSERT INTO wf_work (machine, key, kind, work_key, input, status, checkpoint)
                      VALUES ('clock', $1, 'clock.build-own.item', 'item:key-1@run0', $2, 'queued', '{"paid": "batch-1"}')`,
      [clockMod.clockKey('build-own'), JSON.stringify({ job: 'build-own', target: 'key-1', input: { key: 'k1' }, release: OLD })]);
    // Claimed by a live process of the older build: its lease runs.
    const { rows: [worked] } = await pool.query(`INSERT INTO wf_work (machine, key, kind, work_key, input, status)
                      VALUES ('clock', $1, 'clock.build-own.item', 'item:key-2@run0', $2, 'queued') RETURNING id`,
      [clockMod.clockKey('build-own'), JSON.stringify({ job: 'build-own', target: 'key-2', input: { key: 'k2' }, release: OLD })]);
    await pool.query(`WITH a AS (INSERT INTO wf_work_attempts (id, work_id, service_id, number) VALUES (gen_random_uuid(), $1, 'older-pod', 1) RETURNING id)
                      UPDATE wf_work SET status = 'running', claim_id = (SELECT id FROM a), lease_until = now() + interval '1 minute', attempt_count = 1
                       WHERE id = $1`, [worked.id]);
    targets = [{ target: 'key-1', input: { key: 'k1' } }, { target: 'key-2', input: { key: 'k2' } }];
    resumed.length = 0;
    await newer.append(clockMod.MACHINE, clockMod.clockKey('build-own'), { type: 'RunNow', payload: {} },
      { requestKey: 'run-now:b1', source: { kind: 'admin' } });
    await newer.drain();
    await newer.runServices();
    await newer.drain();
    const { rows: items } = await pool.query(
      `SELECT work_key, status, input->>'release' AS release, result FROM wf_work
        WHERE machine = 'clock' AND kind = 'clock.build-own.item' ORDER BY id`);
    const older0 = items.find((i) => i.work_key === 'item:key-1@run0');
    assert.equal(older0.status, 'settled');
    assert.equal(older0.result.cancelled, true, 'the older build\'s item is given up');
    const fresh = items.filter((i) => i.status !== 'settled' && i.release === NEW);
    assert.equal(fresh.length, 1, 'its target asked again, as this build\'s');
    assert.equal(items.find((i) => i.work_key === 'item:key-2@run0').status, 'running', 'a worked item is left to its process');
    await newer.runServices();
    assert.deepEqual(built, [[NEW, NEW], [NEW, NEW]]);
    assert.deepEqual(resumed, ['batch-1'], 'carried on from what the older build\'s item did');
    await pool.query(`DELETE FROM wf_work WHERE work_key = 'item:key-2@run0'`);
    targets = [{ target: 'key-1', input: { key: 'k1' } }];

    // A rollback: the older build serves again, started last. It is the
    // newest now, whatever was booted before it.
    await serving(NEW, OLD);
    process.env.GIT_SHA = NEW;
    assert.deepEqual(await services['clock.build-own'].run({ input: { n: 3 }, signal: new AbortController().signal }), { skipped: 'older_build' });
    process.env.GIT_SHA = OLD;
    assert.equal((await services['clock.build-own'].run({ input: { n: 4 }, signal: new AbortController().signal })).release, OLD);
    // A process that stopped beating is not serving.
    await pool.query(`UPDATE platform_processes SET heartbeat_at = now() - interval '5 minutes' WHERE id = 'b1-1'`);
    process.env.GIT_SHA = NEW;
    assert.equal((await services['clock.build-own'].run({ input: { n: 5 }, signal: new AbortController().signal })).release, NEW);
    await pool.query(`DELETE FROM platform_processes WHERE id LIKE 'b1-%'`);
  });

  // The clock's runs by hand, one step at a time: Arm (or Run now), the run,
  // its targets.
  const step = async (rt, job, n, { arm = false, everyMs = 60000 } = {}) => {
    if (arm) {
      await rt.append(clockMod.MACHINE, clockMod.clockKey(job), { type: 'Arm', payload: { job, everyMs, firstDueAt: null } },
        { requestKey: `arm:${job}:${n}`, source: { kind: 'system', name: 'release' } });
      await rt.drain();
      await rt.fireTimers();
    } else {
      await rt.append(clockMod.MACHINE, clockMod.clockKey(job), { type: 'RunNow', payload: {} },
        { requestKey: `run-now:${job}:${n}`, source: { kind: 'admin' } });
    }
    await rt.drain();
    await rt.runServices();   // the run (its items too, when due)
    await rt.drain();
  };
  const itemsOfJob = async (job) => (await pool.query(
    `SELECT id, work_key, status, input->>'release' AS release, result, checkpoint FROM wf_work
      WHERE machine = 'clock' AND kind = $1 ORDER BY created_at`, [`clock.${job}.item`])).rows;

  await t.test('B6: a target\'s item that did not finish is carried on by its next one; one that succeeded is not', async () => {
    const seen = [];
    let fail = true;
    const job = {
      name: 'carry', everyMs: 60000,
      run: async () => ({ items: [{ target: 'paid-thing', input: {} }] }),
      item: {
        maxAttempts: 1,
        run: async (ctx) => {
          const steps = ctx.steps();
          seen.push(steps.get('paid') ?? null);
          await steps.once('paid', async () => `paid-${seen.length}`);
          if (fail) throw new Error('its record could not be written');
          return { ok: true };
        },
      },
    };
    const rt = createRuntime({ pool, machines: [clockMod.clock()], services: clockServices([job], { config: {}, pool }), pollMs: 50 });
    runtimes.push(rt);
    await step(rt, 'carry', 1, { arm: true });
    await rt.runServices();   // the item: pays, then fails, out of tries
    await rt.drain();
    assert.deepEqual(seen, [null]);
    fail = false;
    await step(rt, 'carry', 2);
    await rt.runServices();
    await rt.drain();
    assert.deepEqual(seen, [null, 'paid-1'], 'the next item carries on from what the last one paid for');
    await step(rt, 'carry', 3);
    await rt.runServices();
    await rt.drain();
    assert.deepEqual(seen, [null, 'paid-1', null], 'after a success the target starts afresh');
  });

  await t.test('B7: an item an older build\'s process is claiming while the newest hands it on stays that process\'s', async () => {
    await serving(OLD, NEW);
    process.env.GIT_SHA = NEW;
    const job = {
      name: 'race', everyMs: 60000, newestOnly: true,
      run: async () => ({ items: [{ target: 'race-1', input: {} }] }),
      item: { run: async () => ({ ok: true }) },
    };
    const services = clockServices([job], { config: {}, pool });
    const rt = createRuntime({ pool, machines: [clockMod.clock()], services, pollMs: 50, release: NEW });
    runtimes.push(rt);
    await step(rt, 'race', 1, { arm: true });
    // Its item, as an older build's run handed it out: queued.
    await pool.query(`UPDATE wf_work SET input = input || jsonb_build_object('release', $1::text) WHERE kind = 'clock.race.item'`, [OLD]);
    const [older] = await itemsOfJob('race');
    assert.equal(older.status, 'queued');
    // The older build's process claims it: its claim's transaction holds the
    // row while the newest build's run hands its target out.
    const claim = await pool.connect();
    try {
      await claim.query('BEGIN');
      await claim.query('SELECT id FROM wf_work WHERE id = $1 FOR UPDATE', [older.id]);
      await rt.append(clockMod.MACHINE, clockMod.clockKey('race'), { type: 'RunNow', payload: {} },
        { requestKey: 'run-now:race:2', source: { kind: 'admin' } });
      await rt.drain();
      await rt.runServices();   // the run; its result's transition waits on the row
      const handing = rt.drain();
      await new Promise((r) => setTimeout(r, 150));
      await claim.query(`WITH a AS (INSERT INTO wf_work_attempts (id, work_id, service_id, number) VALUES (gen_random_uuid(), $1, 'older-pod', 1) RETURNING id)
                         UPDATE wf_work SET status = 'running', claim_id = (SELECT id FROM a), lease_until = now() + interval '1 minute', attempt_count = 1
                          WHERE id = $1`, [older.id]);
      await claim.query('COMMIT');
      await handing;
    } finally { claim.release(); }
    const items = await itemsOfJob('race');
    assert.equal(items.find((i) => i.id === older.id).status, 'running', 'not cancelled under the process that claimed it');
    assert.equal(items.length, 1, 'and its target not handed out a second time');
    await pool.query(`DELETE FROM platform_processes WHERE id LIKE 'b1-%'`);
  });

  await t.test('B8: translations: a batch paid for, unrecorded, is recorded by the newest build after the English changed, never paid for again', async (st) => {
    const runner = require('../src/services/language-sync-runner');
    const llm = require('../src/services/llm');
    const cache = require('../src/services/language-cache');
    const real = { isEnabled: llm.isEnabled, submit: llm.submitCatalogBatch, status: llm.catalogBatchStatus, readSource: cache.readSource };
    st.after(() => {
      Object.assign(llm, { isEnabled: real.isEnabled, submitCatalogBatch: real.submit, catalogBatchStatus: real.status });
      cache.readSource = real.readSource;
    });
    const submitted = [];
    llm.isEnabled = () => true;
    llm.submitCatalogBatch = async () => { submitted.push(1); return { id: `msgbatch_${submitted.length}` }; };
    llm.catalogBatchStatus = async () => ({ status: 'in_progress' });
    const english = real.readSource();
    assert.ok(english, 'the build\'s catalogs');
    let source = english;
    cache.readSource = () => source;
    // The state write fails while the flag is up.
    await pool.query(`CREATE TABLE b8_fail (up BOOLEAN NOT NULL);
      INSERT INTO b8_fail VALUES (false);
      CREATE FUNCTION b8_fail_state() RETURNS trigger AS $$
      BEGIN IF NEW.key = '${runner.STATE_KEY}' AND (SELECT up FROM b8_fail) THEN RAISE EXCEPTION 'the state write failed'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER b8_fail_state BEFORE INSERT OR UPDATE ON platform_settings FOR EACH ROW EXECUTE FUNCTION b8_fail_state();`);
    st.after(() => pool.query(`DROP TRIGGER IF EXISTS b8_fail_state ON platform_settings; DROP FUNCTION IF EXISTS b8_fail_state(); DROP TABLE IF EXISTS b8_fail;
                               DELETE FROM platform_settings WHERE key = '${runner.STATE_KEY}'`));
    const job = JOBS.find((j) => j.name === 'language-sync');
    const services = clockServices([job], { config: {}, pool });
    const older = createRuntime({ pool, machines: [clockMod.clock()], services, pollMs: 50, release: OLD });
    const newer = createRuntime({ pool, machines: [clockMod.clock()], services, pollMs: 50, release: NEW });
    runtimes.push(older, newer);
    // The older build: its pass submits a batch, and the write that records
    // it fails. Its item waits out its retry, with the batch in its steps.
    await serving(OLD);
    process.env.GIT_SHA = OLD;
    await pool.query('UPDATE b8_fail SET up = true');
    await step(older, 'language-sync', 1, { arm: true, everyMs: job.everyMs });
    await older.runServices();
    await older.drain();
    assert.equal(submitted.length, 1);
    const [paid] = await itemsOfJob('language-sync');
    assert.equal(paid.status, 'queued', 'waiting out its retry');
    assert.equal(paid.checkpoint.batch.id, 'msgbatch_1');
    await pool.query('UPDATE b8_fail SET up = false');
    // A new build, whose English changed: its run hands the catalog on.
    source = JSON.parse(JSON.stringify(english));
    const en = Object.keys(source.files).find((f) => f.startsWith('en/'));
    const id = Object.keys(source.files[en])[0];
    source.files[en][id] = { ...source.files[en][id], text: `${source.files[en][id].text} (changed)` };
    await serving(OLD, NEW);
    process.env.GIT_SHA = NEW;
    await step(newer, 'language-sync', 2);
    await newer.runServices();
    await newer.drain();
    assert.equal(submitted.length, 1, 'never paid for twice');
    const { rows: [state] } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [runner.STATE_KEY]);
    assert.equal(JSON.parse(state.value).batch.id, 'msgbatch_1', 'recorded, to be collected');
    await pool.query(`DELETE FROM platform_processes WHERE id LIKE 'b1-%'`);
  });

  await t.test('B2: ready-made images: each key owed a build is a target; its row building, then ready or failed', async () => {
    const starter = require('../src/services/starter-images');
    const runtime = require('../src/services/application-runtime');
    const real = runtime.build;
    t.after(() => { runtime.build = real; });
    process.env.GIT_SHA = NEW;
    const config = { appRuntime: 'docker' };
    const out = await starter.targets(config, pool);
    assert.ok(out.templates > 0);
    assert.equal(out.items.length, out.templates, 'every key is owed a first build');
    const [first, second] = out.items;
    runtime.build = async () => ({ imageRef: 'usernode-starter:1', buildRef: null });
    assert.deepEqual((await starter.buildTarget(config, pool, first.input)).ready, first.input.template);
    runtime.build = async () => { throw new Error('npm ci failed'); };
    assert.deepEqual(await starter.buildTarget(config, pool, second.input), { failed: second.input.template });
    const row = async (input) => (await pool.query('SELECT status, attempts, error FROM starter_images WHERE template = $1 AND context_key = $2',
      [input.template, input.key])).rows[0];
    assert.equal((await row(first.input)).status, 'ready');
    assert.equal((await row(second.input)).status, 'failed');
    assert.match((await row(second.input)).error, /npm ci failed/);
    const next = (await starter.targets(config, pool)).items.map((i) => i.input.template);
    assert.ok(!next.includes(first.input.template), 'a ready key is owed nothing');
    assert.ok(!next.includes(second.input.template), 'a failure waits before it is tried again');
    assert.deepEqual(await starter.buildTarget(config, pool, first.input), { skipped: 'ready_or_building' });
    assert.deepEqual(await starter.buildTarget(config, pool, { template: first.input.template, key: 'not-this-build' }), { skipped: 'not_current' });
    // A row marked building whose build stopped with its process is owed
    // again; one whose build runs (the clock's item, outstanding) is waited for.
    await pool.query(`UPDATE starter_images SET status = 'building' WHERE template = $1 AND context_key = $2`, [second.input.template, second.input.key]);
    assert.ok((await starter.targets(config, pool)).items.some((i) => i.input.key === second.input.key));
    assert.equal(await starter.list(config, pool).then((l) => l.templates.find((x) => x.id === second.input.template).status), 'queued',
      'Admin > Templates: its build stopped');
    await pool.query(`INSERT INTO wf_work (machine, key, kind, work_key, input, status)
                      VALUES ('clock', 'clock:starter-images', 'clock.starter-images.item', 'item:x@run1', $1, 'queued')`,
      [JSON.stringify({ job: 'starter-images', target: 'x', input: { template: second.input.template, key: second.input.key } })]);
    assert.equal(await starter.list(config, pool).then((l) => l.templates.find((x) => x.id === second.input.template).status), 'building');
    const waited = await starter.imageFor(config, pool, { key: second.input.key, slug: 's' }, { waitMs: 50, pollMs: 10 });
    assert.equal(waited, null, 'waited for it, then built its own');
    assert.equal(await starter.requestRebuild(config, pool, second.input.template), false, 'not while its build runs');
    // A row left reading building (its build cut short) is not waited for:
    // the clock's target is the one builder.
    runtime.build = async () => ({ imageRef: 'usernode-starter:2', buildRef: null });
    await pool.query(
      `UPDATE starter_images SET status = 'building'
        WHERE template = $1 AND context_key = $2`, [second.input.template, second.input.key]);
    assert.equal((await starter.buildTarget(config, pool, second.input)).ready, second.input.template);
    assert.equal((await row(second.input)).status, 'ready');
  });

  await t.test('B3: translations: the one pass owed, as a target', async () => {
    const runner = require('../src/services/language-sync-runner');
    const source = { files: { 'en/a.json': { x: { text: 'Hello' } } } };
    const llm = { isEnabled: () => true };
    const digest = runner.sourceDigest(source);
    assert.deepEqual(await runner.look({ pool, deps: { llm, source } }), { items: [{ target: 'catalog', input: {} }] });
    await runner.writeState(pool, { checkedDigest: digest });
    assert.deepEqual(await runner.look({ pool, deps: { llm, source } }), { skipped: 'unchanged' });
    await runner.writeState(pool, { checkedDigest: digest, batch: { id: 'msgbatch_01abc', sourceDigest: digest } });
    assert.deepEqual(await runner.look({ pool, deps: { llm, source } }), { items: [{ target: 'batch:msgbatch_01abc', input: {} }] });
    assert.deepEqual(await runner.look({ pool, deps: { llm: { isEnabled: () => false }, source } }), { skipped: 'no_key' });
    // A pass carried on from one that paid for a batch it never recorded:
    // recorded, whatever the English is now (here a few messages, which a
    // pass would translate directly, paying again).
    await runner.writeState(pool, {});
    const { steps: makeSteps } = require('../src/workflow/kernel/steps.ts');
    const kept = { id: 'msgbatch_9', sourceDigest: 'older', english: {}, submittedAt: '2026-10-20T10:00:00Z', messages: 900 };
    const direct = [];
    const paying = { isEnabled: () => true, translateCatalogDirect: async (r) => { direct.push(r); return []; },
      submitCatalogBatch: async () => assert.fail('submitted again') };
    const steps = makeSteps({ resumeFrom: { batch: kept }, checkpoint: async () => {} });
    assert.deepEqual(await runner.runOnce({ pool, deps: { llm: paying, source, steps } }), { recorded: 'msgbatch_9' });
    assert.deepEqual(direct, []);
    assert.deepEqual((await runner.readState(pool)).batch, kept);
    await pool.query('DELETE FROM platform_settings WHERE key = $1', [runner.STATE_KEY]);
  });

  await t.test('B4: a release whose work waits out a retry is kept while its processes live, abandoned once they are gone', async () => {
    const machine = release.releaseMachine();
    const rt = createRuntime({ pool, machines: [machine], services: {}, pollMs: 50 });
    runtimes.push(rt);
    const sha = 'c'.repeat(40);
    await rt.append(release.MACHINE, release.releaseKey(sha), { type: 'Booted', payload: { release: sha } },
      { requestKey: `booted:${sha}`, source: { kind: 'system', name: 'boot' } });
    await rt.drain();
    // Its work failed a try and waits out its backoff (queued, not running).
    await pool.query(`UPDATE wf_work SET status = 'queued', due_at = now() + interval '5 minutes' WHERE machine = 'release' AND key = $1`, [release.releaseKey(sha)]);
    await pool.query(`INSERT INTO platform_processes (id, release, role, state) VALUES ('p1', $1, 'conductor', 'serving')`, [sha]);
    const expire = async () => {
      const c = await pool.connect();
      try {
        await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await c.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [release.MACHINE, release.releaseKey(sha)]);
        await c.query('COMMIT');
      } finally { c.release(); }
      await rt.fireTimers();
      await rt.drain();
    };
    const state = async () => (await pool.query('SELECT state FROM wf_instances WHERE machine = $1 AND key = $2', [release.MACHINE, release.releaseKey(sha)])).rows[0].state;
    await expire();
    assert.equal(await state(), 'adopting', 'its process lives: its work is still its own');
    await pool.query(`UPDATE platform_processes SET heartbeat_at = now() - interval '5 minutes' WHERE id = 'p1'`);
    await expire();
    assert.equal(await state(), 'abandoned', 'replaced before it ran its work');
  });

  await t.test('B5: a local build (no commit id) is kept while a process of it, which records none, lives', async () => {
    const machine = release.releaseMachine();
    const rt = createRuntime({ pool, machines: [machine], services: {}, pollMs: 50 });
    runtimes.push(rt);
    const dev = 'dev:b5';
    await rt.append(release.MACHINE, release.releaseKey(dev), { type: 'Booted', payload: { release: dev } },
      { requestKey: `booted:${dev}`, source: { kind: 'system', name: 'boot' } });
    await rt.drain();
    await pool.query(`UPDATE wf_work SET status = 'queued', due_at = now() + interval '5 minutes' WHERE machine = 'release' AND key = $1`, [release.releaseKey(dev)]);
    await pool.query(`INSERT INTO platform_processes (id, release, role, state) VALUES ('b5', NULL, 'conductor', 'serving')`);
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [release.MACHINE, release.releaseKey(dev)]);
      await c.query('COMMIT');
    } finally { c.release(); }
    await rt.fireTimers();
    await rt.drain();
    const { rows: [i] } = await pool.query('SELECT state FROM wf_instances WHERE machine = $1 AND key = $2', [release.MACHINE, release.releaseKey(dev)]);
    assert.equal(i.state, 'adopting');
  });
});
