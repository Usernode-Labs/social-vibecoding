'use strict';

// A run whose screen comparison fails still gets screens, and the comparison
// is tried again (23 Nov 2026).
//
// PR 7037's shots published for two phone claims with `screens: []`: its
// comparison, in the 14-proposal burst on busy nodes with large phone
// close-ups, met a busy comparer or its five-second deadline, and
// compareScreens published the verdict with no screens, so the change page
// fell back to the older whole-screen viewer. Pinned here:
//   - shots-diff.fallbackScreens: a screen per change and screen size, read
//     off the PNGs' headers, with nothing outlined and each change's frame
//     where its browser measured it;
//   - compareScreens publishes those when the comparison fails, marks no
//     change unchanged, and says it fell back;
//   - the shots machine then asks for the comparison again (shots.recompare),
//     and its screens replace the stand-ins on the same published run;
//   - recompareScreens reads the published shots (the workspace is gone);
//   - the card's chooser draws such a run with the current viewer.
// The busy comparer that waits is tests/shots-diff-worker.test.js.
//
// Run with: node --test tests/shots-screens-fallback.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const diff = require('../src/services/shots-diff');
const orchestrator = require('../src/services/shots-orchestrator');
const control = require('../src/services/shots-control');
const view = require('../src/services/shots-view');
const { shots, WORK, RECOMPARE_AFTER_MS } = require('../src/workflow/shots/machine.ts');

const png = (width, height) => {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return PNG.sync.write(image);
};
const file = (storyId, viewport, side, variant, data, extra = {}) => ({
  storyId, viewport, side, variant, media: 'png', data,
  sha256: require('node:crypto').createHash('sha256').update(data).update(`${storyId}:${side}:${variant}`).digest('hex'), ...extra,
});
const PHONE = { name: 'mobile', width: 384, height: 774 };
const DESKTOP = { name: 'desktop', width: 1280, height: 800 };

// ── The stand-in screens ────────────────────────────────────────────────

test('when nothing can be compared, each change and screen size still gets a screen, outlining nothing', () => {
  const stories = [
    { id: 'badge', viewports: [PHONE, DESKTOP] },
    { id: 'sheet', viewports: [PHONE] },
  ];
  const files = [
    // A phone still at device density 3, as the run saved it.
    file('badge', 'mobile', 'base', 'context', png(384 * 3, 1500 * 3)),
    file('badge', 'mobile', 'head', 'context', png(384 * 3, 1620 * 3)),
    file('badge', 'mobile', 'head', 'focus', png(60 * 3, 24 * 3), { focusRect: { x: 300, y: 40, w: 60, h: 24 } }),
    file('badge', 'desktop', 'base', 'context', png(1280, 800)),
    file('badge', 'desktop', 'head', 'context', png(1280, 800)),
    // A recorded place off its screen is not believed.
    file('badge', 'desktop', 'head', 'focus', png(40, 40), { focusRect: { x: 1270, y: 10, w: 40, h: 40 } }),
    file('sheet', 'mobile', 'base', 'context', png(384 * 3, 900 * 3)),
    file('sheet', 'mobile', 'head', 'context', png(384 * 3, 900 * 3)),
    // Not read: a clip, and a still with no PNG header.
    { storyId: 'sheet', viewport: 'mobile', side: 'head', variant: 'animation', media: 'webm', data: Buffer.from('x') },
  ];
  const screens = diff.fallbackScreens(stories, files);
  assert.deepEqual(screens, [
    { viewport: 'mobile', stories: ['badge'], shot: 'badge', foldedAfter: [], width: 384, heightBefore: 1500, heightAfter: 1620,
      density: 3, regions: [], frames: [{ story: 'badge', b: null, a: [300, 40, 60, 24] }] },
    { viewport: 'mobile', stories: ['sheet'], shot: 'sheet', foldedAfter: [], width: 384, heightBefore: 900, heightAfter: 900,
      density: 3, regions: [], frames: [] },
    { viewport: 'desktop', stories: ['badge'], shot: 'badge', foldedAfter: [], width: 1280, heightBefore: 800, heightAfter: 800,
      density: 1, regions: [], frames: [] },
  ]);
  // Nothing outlined means nothing known: a change is never "unchanged" here.
  assert.deepEqual(screens.flatMap((screen) => screen.regions), []);
});

test('changes share a stand-in screen only when their before and after are the very same images', () => {
  const before = png(1280, 800);
  const after = png(1280, 900);
  const same = (id) => [
    { ...file(id, 'desktop', 'base', 'context', before), sha256: 'b'.repeat(64) },
    { ...file(id, 'desktop', 'head', 'context', after), sha256: 'a'.repeat(64) },
  ];
  const stories = [{ id: 'one', viewports: [DESKTOP] }, { id: 'two', viewports: [DESKTOP] },
    { id: 'new-page', viewports: [DESKTOP], intent: { baseState: 'not_present' } }];
  const screens = diff.fallbackScreens(stories, [...same('one'), ...same('two'), ...same('new-page')]);
  assert.deepEqual(screens.map((screen) => screen.stories), [['one', 'two'], ['new-page']],
    'a change declared as not there before never shares one');
  assert.deepEqual(diff.fallbackScreens(stories, [same('one')[0]]), [], 'a change with only one side has no screen');
});

// ── Publishing ──────────────────────────────────────────────────────────

function stubbed(t, files, comparer) {
  t.mock.method(control, 'read', async () => ({ intent: { stories: [{ id: 'badge', viewports: [PHONE] }] } }));
  t.mock.method(control, 'filesFor', async () => files);
  t.mock.method(require('../src/services/logger'), 'warn', () => {});
  return { shotsDiff: { screensFor: comparer, unchangedStories: () => new Set(['badge']) } };
}

test('a comparison that fails publishes stand-in screens, marks nothing unchanged, and says it fell back', async (t) => {
  const files = [
    file('badge', 'mobile', 'base', 'context', png(384, 1500)),
    file('badge', 'mobile', 'head', 'context', png(384, 1600)),
  ];
  const verdict = { stories: [{ id: 'badge', status: 'ready' }] };
  const seen = [];
  for (const code of ['shots_diff_busy', 'shots_diff_timeout']) {
    const injected = stubbed(t, files, async (stories, given, options) => {
      seen.push(options);
      throw Object.assign(new Error('comparison failed'), { code });
    });
    const out = await orchestrator.compareScreens(null, { runId: 'run', verdict }, injected);
    assert.equal(out.screensFallback, true, code);
    assert.equal(out.screens.length, 1, code);
    assert.deepEqual(out.screens[0].regions, []);
    assert.deepEqual(out.stories, verdict.stories, `${code}: no change is "unchanged" because the comparison failed`);
    assert.equal(out.stories[0].unchanged, undefined);
  }
  assert.equal(seen[0].wait, true, 'the run\'s own comparison waits for a worker instead of being refused');
});

test('a comparison that works publishes its screens as before, with no fallback mark', async (t) => {
  const compared = [{ viewport: 'mobile', shot: 'badge', stories: ['badge'], regions: [], frames: [] }];
  const injected = stubbed(t, [], async () => compared);
  const out = await orchestrator.compareScreens(null, { runId: 'run', verdict: { stories: [{ id: 'badge', status: 'ready' }] } }, injected);
  assert.equal(out.screensFallback, undefined);
  assert.deepEqual(out.screens, compared);
  assert.equal(out.stories[0].unchanged, true, 'a real comparison still marks what came out the same');
});

// ── The machine ─────────────────────────────────────────────────────────

const SHA = (c) => c.repeat(40);
const RUN = 'r'.repeat(32);
const machine = shots({ execute: true, agentBudgetMs: 480000, runBudgetMs: 1440000 });
const ctx = { now: new Date('2026-11-23T17:32:00Z'), key: 'session:42', version: 7 };
const facts = { session: { id: 42, appId: 10, appSlug: 'usernode-2d5619', status: 'promoted', source: null, head: SHA('b'),
  pins: { imported: null, reviewed: SHA('b'), handoff: null }, readyHeads: [SHA('b')], agentBusy: false,
  slot: { state: null, runId: null, detail: null, run: null }, temporaryWorker: false } };
const AGENT_VERDICT = { mode: 'shots', stories: [{ id: 'badge', status: 'ready' }] };
function publishing({ afterOnly = false } = {}) {
  return { name: 'publishing', data: {
    sessionId: 42, appId: 10, appSlug: 'usernode-2d5619', declared: { intent: { version: 1, stories: [] }, required: true },
    head: SHA('b'), n: 1, last: null, cleaning: [],
    run: { id: RUN, n: 1, head: SHA('b'), base: SHA('a'), trigger: 'preview-ready', startedAt: '2026-11-23T17:20:00Z',
      busy: 0, died: 0, dispatches: 1, copiesAt: '2026-11-23T17:22:00Z', agentStartedAt: '2026-11-23T17:22:00Z', agentWaitUntil: null,
      platformRetry: false, afterOnly, publish: { verdict: AGENT_VERDICT, manifestHash: 'h'.repeat(64), slots: ['s1'] } },
  } };
}
const done = (type, kind, workKey, result) => ({ id: 11, type, source: { kind: 'service', workId: 'w1' },
  payload: { sessionId: 42, kind, workKey, attempt: 1, ...(result !== undefined ? { result } : { error: { message: 'x', code: null } }) } });
const apply = (s, e) => machine.entryFor(s.name, e.type).to(s, e, facts, ctx);

test('a run published with stand-in screens is compared again in the background; one compared is not', () => {
  const fallback = { ...AGENT_VERDICT, screens: [{ viewport: 'mobile', shot: 'badge', regions: [] }], screensFallback: true };
  const out = apply(publishing(), done('WorkSucceeded', WORK.publish, 'publish:1', { verdict: fallback }));
  assert.equal(out.next.name, 'published');
  assert.deepEqual(out.writes.find((w) => w.type === 'published').verdict, fallback, 'published at once, with the stand-ins');
  const again = out.work.find((w) => w.kind === WORK.recompare);
  assert.deepEqual(again && { key: again.key, input: again.input }, { key: `recompare:${RUN}`, input: { runId: RUN } });
  assert.equal(again.notBefore.getTime(), ctx.now.getTime() + RECOMPARE_AFTER_MS, 'a little later, not into the same busy moment');

  const compared = { ...AGENT_VERDICT, screens: [{ viewport: 'mobile', shot: 'badge', regions: [{ story: 'badge' }] }] };
  const fine = apply(publishing(), done('WorkSucceeded', WORK.publish, 'publish:1', { verdict: compared }));
  assert.equal(fine.work.some((w) => w.kind === WORK.recompare), false);

  // The comparison step that failed for good publishes the agent's verdict,
  // marked so it is compared again.
  const lost = apply(publishing(), done('WorkExhausted', WORK.publish, 'publish:1'));
  assert.equal(lost.writes.find((w) => w.type === 'published').verdict.screensFallback, true);
  assert.ok(lost.work.some((w) => w.kind === WORK.recompare));

  // A run that took only its after side has nothing to compare.
  const afterOnly = apply(publishing({ afterOnly: true }), done('WorkExhausted', WORK.publish, 'publish:1'));
  assert.equal(afterOnly.work.some((w) => w.kind === WORK.recompare), false);
  assert.equal(afterOnly.writes.find((w) => w.type === 'published').verdict.screensFallback, undefined);
});

test('the comparison made again replaces the stand-ins on that run; one that never succeeds leaves them', () => {
  const s = apply(publishing(), done('WorkSucceeded', WORK.publish, 'publish:1',
    { verdict: { ...AGENT_VERDICT, screens: [], screensFallback: true } })).next;
  const real = { ...AGENT_VERDICT, screens: [{ viewport: 'mobile', shot: 'badge', regions: [{ story: 'badge' }] }] };
  const out = apply(s, done('WorkSucceeded', WORK.recompare, `recompare:${RUN}`, { verdict: real }));
  assert.equal(out.next, s, 'the slot\'s state is unchanged');
  assert.deepEqual(out.writes, [{ type: 'recompared', runId: RUN, verdict: real }]);
  assert.deepEqual(apply(s, done('WorkExhausted', WORK.recompare, `recompare:${RUN}`)).writes, undefined);
  assert.deepEqual(apply(s, done('WorkSucceeded', WORK.recompare, `recompare:${RUN}`, { skipped: true })).writes, undefined);

  // The write is fenced on the run still being published with the stand-ins.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/shots/machine.ts'), 'utf8');
  assert.match(src, /UPDATE shot_runs SET hard_verdict = \$2::jsonb, updated_at = NOW\(\)\s+WHERE id = \$1 AND state = 'verified' AND hard_verdict->>'screensFallback' = 'true'/);
});

test('the comparison is tried again a bounded number of times, spaced out, one at a time', () => {
  const { shotsServices, RECOMPARE_ATTEMPTS, RECOMPARE_BACKOFF_MS } = require('../src/workflow/shots/services.ts');
  const handler = shotsServices({ config: {}, pool: {} })[WORK.recompare];
  assert.equal(handler.maxAttempts, RECOMPARE_ATTEMPTS);
  assert.equal(RECOMPARE_ATTEMPTS, 4);
  assert.deepEqual([1, 2, 3, 4].map(handler.backoffMs), [...RECOMPARE_BACKOFF_MS, RECOMPARE_BACKOFF_MS.at(-1)]);
  assert.equal(handler.concurrency, 1);
});

// ── Comparing again ─────────────────────────────────────────────────────

function runPool(row) {
  return { async query(sql, values) { assert.match(sql, /FROM shot_runs WHERE id = \$1/); assert.deepEqual(values, [RUN]); return { rows: row ? [row] : [] }; } };
}

test('comparing again reads the published shots and returns the real screens in place of the stand-ins', async () => {
  const verdict = { mode: 'shots', stories: [{ id: 'badge', status: 'ready' }, { id: 'gone', status: 'skipped' }],
    screens: [{ viewport: 'mobile', shot: 'badge', regions: [] }], screensFallback: true };
  const intent = { stories: [{ id: 'badge', viewports: [PHONE] }, { id: 'gone', viewports: [PHONE] }] };
  const published = [file('badge', 'mobile', 'base', 'context', png(4, 4))];
  const real = [{ viewport: 'mobile', shot: 'badge', stories: ['badge'], regions: [{ story: 'badge', a: [0, 0, 2, 2], b: [0, 0, 2, 2] }], frames: [] }];
  const asked = [];
  const out = await orchestrator.recompareScreens(runPool({ id: RUN, state: 'verified', intent, hard_verdict: verdict }), { runId: RUN }, {
    publishedFilesFor: async (pool, runId) => { asked.push(runId); return published; },
    shotsDiff: {
      screensFor: async (stories, files, options) => { asked.push(stories.map((s) => s.id), files, options.wait); return real; },
      unchangedStories: () => new Set(),
    },
  });
  assert.deepEqual(asked, [RUN, ['badge'], published, true]);
  assert.deepEqual(out.verdict.screens, real);
  assert.equal(out.verdict.screensFallback, undefined, 'compared now');
  assert.deepEqual(out.verdict.stories, verdict.stories);
});

test('comparing again does nothing for a run no longer published with stand-ins, and throws when it fails again', async () => {
  const intent = { stories: [{ id: 'badge', viewports: [PHONE] }] };
  const ready = { mode: 'shots', stories: [{ id: 'badge', status: 'ready' }], screens: [], screensFallback: true };
  const never = { publishedFilesFor: async () => assert.fail('nothing to read'), shotsDiff: { screensFor: async () => assert.fail('nothing to compare') } };
  for (const row of [
    null,
    { id: RUN, state: 'stale', intent, hard_verdict: ready },
    { id: RUN, state: 'verified', intent, hard_verdict: { ...ready, screensFallback: undefined } },
  ]) {
    assert.deepEqual(await orchestrator.recompareScreens(runPool(row), { runId: RUN }, never), { skipped: true });
  }
  const busy = Object.assign(new Error('Screenshot comparisons are at this process\'s limit'), { code: 'shots_diff_busy' });
  await assert.rejects(orchestrator.recompareScreens(runPool({ id: RUN, state: 'verified', intent, hard_verdict: ready }), { runId: RUN }, {
    publishedFilesFor: async () => [], shotsDiff: { screensFor: async () => { throw busy; } },
  }), (error) => error === busy, 'thrown, for the work item to try again later');
});

// ── The card ────────────────────────────────────────────────────────────

test('the card draws a run with stand-in screens with the current viewer, framing the whole screen', () => {
  const screens = diff.fallbackScreens([{ id: 'badge', viewports: [PHONE] }], [
    file('badge', 'mobile', 'base', 'context', png(384, 1500)),
    file('badge', 'mobile', 'head', 'context', png(384, 1600)),
  ]);
  const shown = view.cleanScreens(screens, [{ id: 'badge' }]);
  assert.equal(shown.length, 1, 'the view keeps it');
  assert.deepEqual(shown[0].regions, []);
  // The chooser: a verified run is the one before & after viewer's.
  const change = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/dev-board/topic/change-head.tsx'), 'utf8');
  assert.match(change, /if \(s\.state === 'verified' && s\.source\) \{/);
  // ...which frames a screen with nothing outlined without falling over.
  const { pictureFrame } = require('./lib/render-tsx').loadTsx('frontend/src/features/review-flow/shots-viewer.tsx');
  const frame = pictureFrame({ viewport: 'mobile', width: 384, before: { url: '/b', height: 1500 }, after: { url: '/a', height: 1600 },
    regions: [], changes: [1] }, 360);
  assert.ok(Number.isFinite(frame.height) && frame.height > 0, `height ${frame.height}`);
  assert.ok(Number.isFinite(frame.place.scale) && frame.place.scale > 0);
});
