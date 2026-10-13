'use strict';

// #3654: the benchmark's statistics. Pure functions over plain numbers, so
// every figure on the results screen is reproducible from the trials.
//
//   accuracy   passes over graded trials (pass + fail). Trials still waiting
//              for a grade, or for their task's reference, are counted apart,
//              and platform faults never count against a model.
//   pass^k     the share of tasks on which ALL k attempts passed: the measure
//              of a model you can rely on run after run, reported beside the
//              mean, which says how often it gets a thing right at all.
//   paired     each task scored for both models (the mean of its attempts),
//              the difference averaged over the tasks both were graded on,
//              with a 95% bootstrap interval that resamples APPS, not tasks:
//              tasks of one app are not independent of each other, and
//              treating them as if they were would make the interval look
//              surer than it is. Seeded, so the same trials give the same
//              interval.
//   pareto     the models no other model beats on both cost and accuracy.

function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

/** The p-th percentile (0..100), linear between ranks. Null for no data. */
function percentile(xs, p) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return v[0];
  const rank = (p / 100) * (v.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return v[lo] + (v[hi] - v[lo]) * (rank - lo);
}

/**
 * pass^k over tasks: `attempts` maps a task to its attempts' verdicts
 * ('pass' | 'fail' | anything else, which is not graded). A task counts only
 * when it has exactly k graded attempts. { k, tasks, passAll, value }.
 */
function passHatK(attemptsByTask, k) {
  let tasks = 0;
  let passAll = 0;
  for (const verdicts of attemptsByTask.values()) {
    const graded = verdicts.filter((v) => v === 'pass' || v === 'fail');
    if (graded.length !== k || verdicts.length !== k) continue;
    tasks += 1;
    if (graded.every((v) => v === 'pass')) passAll += 1;
  }
  return { k, tasks, passAll, value: tasks ? passAll / tasks : null };
}

/**
 * Paired difference between a model and the baseline, per task, with a 95%
 * bootstrap interval clustered by app. `pairs` is [{ task, app, a, b }] with
 * a and b each model's score on that task (0..1). Deterministic for a seed.
 */
function pairedDiff(pairs, { iterations = 2000, seed = 3654, level = 0.95 } = {}) {
  const valid = pairs.filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b));
  if (!valid.length) return { n: 0, apps: 0, diff: null, low: null, high: null };
  const diff = mean(valid.map((p) => p.a - p.b));
  const byApp = new Map();
  for (const p of valid) {
    if (!byApp.has(p.app)) byApp.set(p.app, []);
    byApp.get(p.app).push(p.a - p.b);
  }
  const apps = [...byApp.keys()].sort();
  const rand = mulberry32(seed);
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < apps.length; j += 1) {
      const d = byApp.get(apps[Math.floor(rand() * apps.length)]);
      for (const x of d) { sum += x; count += 1; }
    }
    samples.push(count ? sum / count : 0);
  }
  const tail = ((1 - level) / 2) * 100;
  return {
    n: valid.length,
    apps: apps.length,
    diff,
    low: percentile(samples, tail),
    high: percentile(samples, 100 - tail),
  };
}

/**
 * The points no other point dominates: nothing cheaper (or as cheap) that is
 * at least as accurate, and better on one of the two. `points` is
 * [{ key, cost, accuracy }]; points missing either figure are left out.
 * Returns the set of frontier keys.
 */
function paretoFrontier(points) {
  const usable = points.filter((p) => Number.isFinite(p.cost) && Number.isFinite(p.accuracy));
  const frontier = new Set();
  for (const p of usable) {
    const dominated = usable.some((q) => q !== p
      && q.cost <= p.cost && q.accuracy >= p.accuracy
      && (q.cost < p.cost || q.accuracy > p.accuracy));
    if (!dominated) frontier.add(p.key);
  }
  return frontier;
}

module.exports = {
  mulberry32,
  mean,
  percentile,
  passHatK,
  pairedDiff,
  paretoFrontier,
};
