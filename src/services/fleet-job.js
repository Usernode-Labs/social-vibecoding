'use strict';

// An admin's fleet job (a container rollover, a reap of previews now): one
// run of an on-demand clock (src/workflow/clock/: an admin's RunNow starts
// it, on whichever process runs the workflow, one at a time across every
// process). Its units are listed once and each is a step of the run's work
// item (kernel/steps.ts), so a restart carries the job on after the units it
// finished, and its progress is that checkpoint, which any process reads
// (snapshotOf). Before, the job was an object in the memory of the web
// process whose route started it: two presses on two processes ran two
// sweeps, and a restart lost the job and its progress.
//
// A job's own module says what a unit is: `list` (the units, as small JSON),
// `keyOf` (a unit's stable key), `rowOf` (what the console shows of it
// before it ran) and `unit` (its work: resolves { outcome, error }, never
// throws for a unit's own failure). `publish` hands every progress snapshot
// to the console's sockets; `finish` records the job's end once.

const log = require('./logger');

const FAILED = 'failed';

// Fixed-width drain: a slow unit never holds up the next one, and at most
// `limit` run at once.
async function drain(items, limit, worker) {
  if (!items.length) return;
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = [];
  for (let i = 0; i < width; i++) {
    runners.push((async () => {
      for (;;) {
        const idx = next++;
        if (idx >= items.length) return;
        await worker(items[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
}

const unitKey = (key) => `unit:${key}`;

/**
 * The console's snapshot of a job, from its run (platform.clockRunOf): what
 * its checkpoint holds while it runs, its result once it ended. `rowsField`
 * names the list ('apps', 'previews'). Null when the job never ran.
 */
function snapshotOf(run, { rowsField, keyOf, rowOf, concurrency }) {
  if (!run) return null;
  const kept = (run.checkpoint && typeof run.checkpoint === 'object') ? run.checkpoint : {};
  const result = (run.result && typeof run.result === 'object') ? run.result : null;
  const items = Array.isArray(kept.items) ? kept.items : [];
  const running = new Set(Array.isArray(kept.running) ? kept.running : []);
  const rows = items.map((item) => {
    const done = kept[unitKey(keyOf(item))];
    return { ...rowOf(item), state: done ? done.state : (running.has(keyOf(item)) ? 'running' : 'pending'),
      ms: done ? done.ms : null, error: done ? done.error : null };
  });
  const done = rows.filter((r) => r.state !== 'pending' && r.state !== 'running').length;
  return {
    id: run.n,
    startedAt: kept.started || run.startedAt,
    startedBy: (run.input && run.input.asked && run.input.asked.by) || null,
    finishedAt: run.running ? null : (kept.finished || run.endedAt || null),
    concurrency: (result && result.concurrency) || concurrency,
    total: items.length,
    done,
    failed: rows.filter((r) => r.state === FAILED).length,
    // A run that ended without finishing its units (a failure it could not
    // carry on from): what it got to, as it stands.
    stale: !run.running && !kept.finished,
    [rowsField]: rows,
  };
}

/**
 * The job's run: its units listed once, each run once across restarts.
 * Resolves the job's tally, which is the run's result.
 */
async function run(ctx, { name, list, keyOf, rowOf, unit, concurrency, publish, finish, rowsField }) {
  const steps = ctx.steps({ owner: `fleet-job/${name}` });
  const started = await steps.once('started', () => new Date().toISOString());
  const items = await steps.once('items', list);
  const running = new Set();
  const snapshot = async () => snapshotOf({
    n: ctx.input.n, running: true, startedAt: started, endedAt: null, input: ctx.input,
    checkpoint: { started, items, running: [...running], ...Object.fromEntries(items.map((it) => [unitKey(keyOf(it)), steps.get(unitKey(keyOf(it)))]).filter(([, v]) => v)) },
    result: null,
  }, { rowsField, keyOf, rowOf, concurrency });
  const tell = async () => { try { publish(await snapshot()); } catch (err) { log.warn('fleet-job', 'progress not told', { name, err: err.message }); } };
  log.info('fleet-job', 'Job started', { name, run: ctx.input.n, total: items.length, concurrency, by: ctx.input.asked?.by ?? null });
  await tell();

  const startedMs = Date.now();
  await drain(items, concurrency, async (item) => {
    const key = unitKey(keyOf(item));
    if (steps.has(key)) return;
    running.add(keyOf(item));
    await tell();
    const unitStarted = Date.now();
    await steps.once(key, async () => {
      let outcome = FAILED;
      let error = null;
      try {
        const r = await unit(item);
        outcome = r.outcome;
        error = r.error || null;
      } catch (err) {
        // A unit catches its own failures: reaching here is a bug, still
        // isolated to the unit.
        error = err && err.message ? err.message : 'failed';
        log.error('fleet-job', 'A unit threw outside its own guard', { name, key, err: error });
      }
      return { state: outcome, error, ms: Date.now() - unitStarted };
    });
    running.delete(keyOf(item));
    await tell();
  });

  const job = await snapshot();
  job.finishedAt = await steps.once('finished', () => new Date().toISOString());
  await steps.once('recorded', async () => { await finish(job, { durationMs: Date.now() - startedMs }); return true; });
  try { publish(job); } catch (err) { log.warn('fleet-job', 'progress not told', { name, err: err.message }); }
  const tally = job[rowsField].reduce((acc, r) => { acc[r.state] = (acc[r.state] || 0) + 1; return acc; }, {});
  log.info('fleet-job', 'Job finished', { name, run: ctx.input.n, total: job.total, failed: job.failed, tally });
  return { total: job.total, failed: job.failed, concurrency, tally };
}

module.exports = { run, snapshotOf, drain, FAILED };
