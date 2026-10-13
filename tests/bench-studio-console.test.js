'use strict';

// The Benchmark area's Studio place (frontend/src/features/admin/
// admin-bench-studio.tsx): its address, its words, and the first render of a
// build card and the gallery. tests/lib/render-tsx.js runs no effects, so
// what the place fetches is covered against the full schema in
// tests/bench-studio-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const ADMIN_UI = {
  './admin-console.js': {
    AdminUI: new Proxy({}, { get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)) }),
  },
};

function load(entry) {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx } = require('./lib/render-tsx');
  return loadTsx(entry, { stubs: ADMIN_UI });
}
const loadStudio = () => load('frontend/src/features/admin/admin-bench-studio.tsx');

const build = (extra = {}) => ({
  trialId: 41, runId: 7, taskId: 3, ref: 'bread', appName: 'Bread Bot',
  arm: { kind: 'platform', model: 'z-ai/glm-5.3-flash', reference: null, pack: { id: 2, name: 'warm', version: 3 } },
  armLabel: 'z-ai/glm-5.3-flash + warm v3', attempt: 1, status: 'ok', step: null,
  startedAt: null, finishedAt: null, elapsedMs: 200000, costUsd: 0.4123,
  activity: [], skills: { invoked: ['warm'], read: ['homeroom-theme'] }, built: true, booted: true,
  shots: [{ caption: 'phone · light · populated', artifactId: '9' }, { caption: 'desktop · dark · populated', artifactId: '10' }, { caption: 'x', artifactId: '11' }],
  code: { branch: 'bench/r7-t41', sha: 'b'.repeat(40), treeUrl: 'https://github.com/o/r/tree/bench/r7-t41', compareUrl: 'https://github.com/o/r/compare/a...b', kept: false },
  preview: null, error: null, final: 'pass', critique: 'Clear and warm.', criteria: { held: 10, of: 12 },
  ...extra,
});

test('the Studio place has an address of its own below the Benchmark tab\'s', () => {
  const { benchRouteFromHash, benchHash } = load('frontend/src/features/admin/admin-homeroom-bench.tsx');
  assert.deepEqual(benchRouteFromHash('#admin/homeroom-bot/benchmark/studio'), { view: 'studio' });
  assert.deepEqual(benchRouteFromHash('#admin/homeroom-bot/benchmark/studio/'), { view: 'studio' });
  assert.equal(benchHash({ view: 'studio' }), '#admin/homeroom-bot/benchmark/studio');
  assert.deepEqual(benchRouteFromHash('#admin/homeroom-bot/benchmark/studio/3'), { view: 'overview' });
});

test('a studio run and a build say their state in plain words', () => {
  const { studioRunWords, elapsedWords, buildState } = loadStudio();
  const w = studioRunWords({ status: 'running', counts: { ok: 3, model_fail: 1, running: 2, pending: 4, awaiting: 1 } });
  assert.equal(w.label, 'Running');
  assert.equal(w.open, true);
  assert.equal(w.line, '4 of 11 built · 2 running · 1 awaiting a reference');
  assert.equal(studioRunWords({ status: 'done', counts: { ok: 2 } }).open, false);
  assert.equal(studioRunWords({ status: 'done', counts: { ok: 2, awaiting: 1 } }).open, true, 'a reference still to come keeps it open');
  assert.equal(elapsedWords(45000), '45s');
  assert.equal(elapsedWords(200000), '3m 20s');
  assert.equal(elapsedWords(3840000), '1h 4m');
  assert.equal(elapsedWords(null), '');
  assert.deepEqual(buildState({ status: 'running', step: 'build', final: '', booted: null }), { text: 'Running: build', tone: 'secondary' });
  assert.deepEqual(buildState({ status: 'ok', step: null, final: 'pending', booted: false }), { text: 'Did not boot', tone: 'destructive' });
  assert.deepEqual(buildState({ status: 'ok', step: null, final: 'pass', booted: true }), { text: 'Pass', tone: 'success' });
  assert.deepEqual(buildState({ status: 'ok', step: null, final: 'pending', booted: true }), { text: 'Built, waiting for the judge', tone: 'warn' });
  assert.deepEqual(buildState({ status: 'infra_fail', step: null, final: '', booted: null }), { text: 'infra fail', tone: 'destructive' });
});

test('a build card shows two screenshots, the verdict, the skills and, to a full admin only, its actions', () => {
  const { BuildCard } = loadStudio();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const html = renderToHtml(createElement(BuildCard, { b: build(), canWrite: true, act: () => {} }));
  assert.match(html, /data-studio-build="41"/);
  assert.equal((html.match(/<img /g) || []).length, 2, 'two screenshots');
  assert.match(html, /src="\/api\/admin\/homeroom-bot\/bench\/artifacts\/9"/);
  assert.match(html, /10 of 12 criteria held · \$0\.41 · 3m 20s/);
  assert.match(html, /Skills: warm, homeroom-theme \(read\)/);
  for (const label of ['Code', 'Preview for a day', 'Keep', 'Run again']) assert.ok(html.includes(`>${label}<`), label);
  assert.ok(!html.includes('>Stop<'));
  const viewer = renderToHtml(createElement(BuildCard, { b: build(), canWrite: false, act: () => {} }));
  for (const label of ['Preview for a day', 'Keep', 'Run again']) assert.ok(!viewer.includes(`>${label}<`), `${label} is a write`);
  const live = renderToHtml(createElement(BuildCard, {
    b: build({ preview: { id: 1, status: 'live', url: 'https://s.example', path: '/#app/app-bench-1/dev/proposals/5', expiresAt: null, error: null } }), canWrite: true, act: () => {},
  }));
  assert.match(live, /href="\/#app\/app-bench-1\/dev\/proposals\/5"[^>]*>Open preview</);
  assert.ok(!live.includes('>Preview for a day<'));
  const running = renderToHtml(createElement(BuildCard, { b: build({ status: 'running', step: 'spec', final: '', code: null, shots: [] }), canWrite: true, act: () => {} }));
  assert.ok(running.includes('>Stop<'));
  assert.ok(!running.includes('>Run again<'));
});

test('the gallery groups builds under their brief, and says when there are none', () => {
  const { StudioGallery } = loadStudio();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  assert.match(renderToHtml(createElement(StudioGallery, { briefs: null, canWrite: true, act: () => {} })), /class="loading"/);
  assert.match(renderToHtml(createElement(StudioGallery, { briefs: [], canWrite: true, act: () => {} })), /No studio briefs yet/);
  const html = renderToHtml(createElement(StudioGallery, {
    briefs: [{ taskId: 3, ref: 'bread', appName: 'Bread Bot', brief: 'I set the kind of bread', builds: [build(), build({ trialId: 42, arm: { kind: 'reference', model: null, reference: 'ref-v1', pack: null }, armLabel: 'reference ref-v1' })] }],
    canWrite: true, act: () => {},
  }));
  assert.match(html, /data-studio-brief="bread"/);
  assert.match(html, /Bread Bot/);
  assert.match(html, /reference ref-v1/);
  assert.equal((html.match(/data-studio-build=/g) || []).length, 2);
});

test('the Benchmark header carries the Studio tab, a real link', () => {
  const { BenchmarkArea } = load('frontend/src/features/admin/admin-homeroom-bench.tsx');
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const html = renderToHtml(createElement(BenchmarkArea, { canWrite: true }));
  assert.match(html, /href="#admin\/homeroom-bot\/benchmark\/studio" id="admin-homeroom-bench-tab-studio"/);
});
