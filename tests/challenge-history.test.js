// #6967: the Challenges screen's History tab.
//
// WHAT THIS PINS. `historyView` (frontend/src/features/leaderboard/
// topochain-challenges.js) lists the challenges the viewer has points on or
// has finished — Done first, then In progress, each by its newest credit —
// with every action behind those points, the ones that did not count
// included and a plain reason why. A finished challenge keeps its earned
// points; one still running says "so far". The change a credit came from is
// linked only on the same guard "What counted" uses, and the controller
// publishes a History descriptor wherever it publishes the grid.
//
// The pane half renders ./challenge-history.tsx over that descriptor: the
// summary, the How points work card, and the two groups, with the catalog's
// own words (tests/lib/platform-i18n `message()`), so an English literal in
// the component would not pass.
//
// The real controller runs in a vm with a stub store, as in
// tests/challenge-groups.test.js.
//
// Run with: node --test tests/challenge-history.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');
const HISTORY_PATH = 'frontend/src/features/leaderboard/challenge-history.tsx';
const History = loadTsx(HISTORY_PATH);

function loadController() {
  const sandbox = { window: {}, console, setTimeout, clearTimeout, URLSearchParams, location: { hash: '', search: '' } };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(SRC, sandbox, { filename: 'topochain-challenges.js' });
  const pane = sandbox.window.TopochainChallenges;
  const state = { mounted: true, grid: null, history: null, detail: null };
  pane._store = { get: () => state, set: (patch) => Object.assign(state, patch) };
  pane._open = true;
  pane._challengesLoading = false;
  pane._challengesError = null;
  pane._onboarding = null;
  return { pane, state };
}

const ch = (id, goal, extra = {}) => ({ id, card_preview: { goal }, ...extra });
const DONE = { progress: { done: true } };

const credit = (extra = {}) => ({
  points: 250, description: 'A report', activity_at: '2026-11-11T14:05:00.000Z',
  activity_time_precision: 'instant', credited_at: '2026-11-11T14:05:00.000Z',
  change: null, counts: true, not_counted_reason: null, grade_reason: null, ...extra,
});

function build({ challenges, mine }) {
  const { pane } = loadController();
  pane._challenges = challenges;
  pane._mine = mine;
  return { pane, view: pane.historyView(pane._ordered()) };
}

test('History groups Done then In progress, and leaves out a challenge with no points', () => {
  const { view } = build({
    challenges: [
      ch(1, 'Join a community', DONE),
      ch(2, 'Send useful feedback'),
      ch(3, 'Use apps'),
      ch(4, 'Produce blocks', DONE),
    ],
    mine: new Map([
      [1, { activities_total: 500, activities: [credit({ points: 500, activity_at: '2026-11-02T09:10:00.000Z' })] }],
      [2, { activities_total: 250, activities: [credit()] }],
      // 4 is done with no ledger rows (block production counts from snapshots).
    ]),
  });
  assert.equal(view.kind, 'list');
  assert.deepEqual([...view.done.map((c) => c.key)], ['1', '4'], 'finished, newest credit first');
  assert.deepEqual([...view.progressGroup.map((c) => c.key)], ['2']);
  assert.ok(!JSON.stringify(view).includes('Use apps'), 'a challenge with no points stays on Challenges');
  assert.equal(view.done[0].points, '500 pts', 'a finished challenge says what it earned');
  assert.equal(view.progressGroup[0].points, '250 pts so far');
  assert.equal(view.done[1].points, null, 'nothing earned, nothing said');
  assert.deepEqual({ ...view.progress }, { done: 2, total: 4, points: 750 });
});

test('every action behind a challenge is listed newest first, the ones that did not count too', () => {
  const { view } = build({
    challenges: [ch(2, 'Send useful feedback')],
    mine: new Map([[2, {
      activities_total: 750,
      activities: [
        credit({ description: 'Newer', points: 250, activity_at: '2026-11-20T10:00:00.000Z' }),
        credit({ description: 'Older, earlier week', points: 250, activity_at: '2026-11-10T10:00:00.000Z', counts: false, not_counted_reason: 'earlier_week' }),
        credit({ description: 'Oldest', points: 250, activity_at: '2026-11-09T10:00:00.000Z' }),
      ],
    }]]),
  });
  const cards = view.progressGroup;
  assert.deepEqual([...cards[0].credits.map((c) => c.text)], ['Newer', 'Older, earlier week', 'Oldest']);
  assert.equal(cards[0].credits[1].note, message('leaderboard:history.reason.earlierWeek'));
  assert.equal(cards[0].credits[0].note, null, 'a counting action says nothing');
  assert.equal(cards[0].credits[0].creditedAt, '2026-11-11T14:05:00.000Z', 'when the points were written');
});

test('an older server that sends counts:false alone still gets the earlier-week note', () => {
  const { view } = build({
    challenges: [ch(2, 'Send useful feedback')],
    mine: new Map([[2, { activities_total: 250, activities: [credit({ counts: false })] }]]),
  });
  assert.equal(view.progressGroup[0].credits[0].note, message('leaderboard:history.reason.earlierWeek'));
  assert.equal(view.progressGroup[0].credits[0].not_counted_reason, undefined);
});

test('a First challenge\'s earlier-season credit says so', () => {
  const { view } = build({
    challenges: [ch(5, 'First steps', DONE)],
    mine: new Map([[5, {
      activities_total: 400,
      activities: [credit({ points: 200, activity_at: '2026-11-15T10:00:00.000Z' })],
      earlier_activities: [credit({ points: 200, description: 'Last season', activity_at: '2025-11-15T10:00:00.000Z' })],
    }]]),
  });
  assert.deepEqual([...view.done[0].credits.map((c) => c.text)], ['A report', 'Last season']);
  assert.equal(view.done[0].credits[1].note, message('leaderboard:history.reason.earlierSeason'));
});

test('a credit links to its change only on the guard "What counted" uses', () => {
  const { view } = build({
    challenges: [ch(2, 'Send useful feedback')],
    mine: new Map([[2, {
      activities_total: 500,
      activities: [
        credit({ description: 'Linked', change: { app_slug: 'run-club', session_id: 42, pr_number: 7, title: 'Add a streak' } }),
        credit({ description: 'No session', change: { app_slug: 'run-club', session_id: 0, title: 'Bad' } }),
        credit({ description: 'Plain', change: null }),
      ],
    }]]),
  });
  const byText = Object.fromEntries(view.progressGroup[0].credits.map((c) => [c.text, c]));
  assert.deepEqual({ ...byText['Add a streak'].change }, { slug: 'run-club', sessionId: 42, prNumber: 7 });
  assert.equal(byText['Add a streak'].text, 'Add a streak', 'the change\'s title is the row');
  assert.equal(byText['No session'].change, null);
  assert.equal(byText.Plain.change, null);
});

test('the controller publishes a History descriptor wherever it publishes the grid', () => {
  const { pane, state } = loadController();
  pane._challenges = [ch(1, 'Join a community', DONE)];
  pane._mine = new Map([[1, { activities_total: 500, activities: [credit()] }]]);
  pane._renderGrid();
  assert.equal(state.grid.kind, 'cards');
  assert.equal(state.history.kind, 'list');

  pane._challengesLoading = true;
  pane._challenges = [];
  pane._renderGrid();
  assert.deepEqual({ ...state.history }, { kind: 'loading' });

  pane._challengesLoading = false;
  pane._challengesError = 'Failed';
  pane._renderGrid();
  assert.equal(state.history.kind, 'error');
  assert.equal(state.history.message, 'Failed');

  pane._challengesError = null;
  pane._renderGrid();
  assert.deepEqual({ ...state.history }, { kind: 'empty' });
});

const VIEW = {
  kind: 'list',
  progress: { done: 1, total: 2, points: 750 },
  done: [{
    key: '1',
    goal: 'Build for your community',
    done: true,
    points: '500 pts',
    credits: [{
      text: 'Add a streak counter',
      points: 500,
      at: '2026-11-12T16:32:00.000Z',
      precision: 'instant',
      creditedAt: '2026-11-12T17:00:00.000Z',
      change: { slug: 'run-club', sessionId: 42, prNumber: 7 },
      reason: 'Merged by the group',
      note: null,
    }],
  }],
  progressGroup: [{
    key: '2',
    goal: 'Send useful feedback',
    done: false,
    points: '250 pts so far',
    credits: [{
      text: 'Reported a broken map tile',
      points: 250,
      at: '2026-11-11T14:05:00.000Z',
      precision: 'instant',
      creditedAt: '2026-11-11T14:05:00.000Z',
      change: null,
      reason: null,
      note: message('leaderboard:history.reason.earlierWeek'),
    }],
  }],
};

const render = (view) => renderToHtml(createElement(History.ChallengeHistory, { view }));

test('the tab draws the summary, the How points work card and both groups', () => {
  const html = render(VIEW);
  assert.match(html, /id="tc-se-history-summary"/);
  assert.match(html, /id="tc-se-history-how"/);
  assert.ok(html.includes('>How points work<'), 'the How points work title');
  assert.ok(html.includes('Points are credited when Homeroom counts what you did'));
  assert.ok(html.includes('An action qualifies when it matches what the challenge counts'));
  assert.ok(html.includes('Standings catch up within about 10 minutes'));
  assert.match(html, /id="tc-se-history-done"/);
  assert.match(html, /id="tc-se-history-progress"/);
  assert.match(html, new RegExp(`>${message('leaderboard:history.groups.done')}<`));
  assert.match(html, new RegExp(`>${message('leaderboard:history.groups.progress')}<`));
  assert.match(html, /data-history-challenge="1"/);
  assert.match(html, /data-history-challenge="2"/);
  assert.match(html, />Build for your community</);
  assert.match(html, />500 pts</);
  assert.match(html, />250 pts so far</);
  assert.match(html, /data-activity-credited=""/);
  assert.match(html, /Credited /);
  assert.match(html, /data-activity-note=""/);
  assert.match(html, /data-activity-reason=""/);
  assert.match(html, /href="#app\/run-club\/dev\/changes\/7\/42"/, 'the credit links to its change');
  assert.ok(html.includes('From an earlier week.'), 'the earlier-week note');
});

test('with nothing earned the tab says so, and offers the hint', () => {
  const html = render({ kind: 'empty' });
  assert.match(html, /data-history-empty=""/);
  assert.ok(html.includes('>Nothing earned yet<'));
  assert.ok(html.includes('Points you earn in challenges show here'));
  assert.doesNotMatch(html, /tc-se-history-how/);
});

test('a challenge with no credits still lists under Done, with its points', () => {
  const html = render({
    kind: 'list',
    progress: { done: 1, total: 1, points: 0 },
    done: [{ key: '4', goal: 'Produce blocks', done: true, points: null, credits: [] }],
    progressGroup: [],
  });
  assert.match(html, /data-history-challenge="4"/);
  assert.doesNotMatch(html, /<ul class="space-y-1">/, 'no empty list');
  assert.doesNotMatch(html, /id="tc-se-history-progress"/, 'no empty group');
});
