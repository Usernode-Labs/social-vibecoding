// `_renderTopicHead` paints only into the surface the current topic owns.
//
// Two surfaces render a `#gc-thread-head`. The change page's
// (features/dev-board/mount.ts `mountChangePage`) is an ordinary React
// element whose TopicHead is its own child; a thread's
// (features/group-chat/thread-shell.tsx) is an empty host that
// `mountTopicHead` takes over — and a first portal mount starts by clearing
// its host.
//
// Moving from a proposal to an issue left the proposal's vote-roster fetch
// in flight. When it landed, its repaint read the NEW topic (the issue) but
// found the OLD surface's head (the change page's) still in the document,
// mounted the issue's head there, and cleared React's own node out from
// under it. React's next commit on the change page then threw
// `NotFoundError: Failed to execute 'removeChild' on 'Node'`, reported as
// `[island portal:dev-topic-thread]` — the intermittent "1 console error on
// load" on /?demo=1#app/usernode-2d5619/dev/issues/900008, whose checks
// run straight after a cold load of proposal 9000013.
//
// Run with: node --test tests/topic-head-surface.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const MERGE_STATUS_SRC = read('merge-status.js');
const APP_VIEW_SRC = read('app-view.js');
const SESSION_TRANSCRIPT_SRC = read('session-transcript.js');

// A `#gc-thread-head` inside one of the two surfaces.
function headIn(surfaceClass) {
  return {
    id: 'gc-thread-head',
    closest: (sel) => (sel === `.${surfaceClass}` ? { className: surfaceClass } : null),
    querySelectorAll: () => [],
  };
}

function makeAppView(head) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' },
    DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: (id) => (id === 'gc-thread-head' ? head : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${MERGE_STATUS_SRC}\n${SESSION_TRANSCRIPT_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`,
    sandbox
  );
  const AppView = sandbox.__AppView;
  const calls = { mounted: [], published: 0 };
  AppView._reactDevBoard = () => ({
    mountTopicHead: (host) => calls.mounted.push(host),
    publishTopicHead: () => { calls.published += 1; },
  });
  AppView._findTopicItem = () => ({ id: 1, status: 'open' });
  AppView._topicViewFor = () => ({ card: {}, body: {} });
  AppView._refreshAiAvailability = () => {};
  AppView._fillKudosHosts = () => {};
  AppView._loadIssueComments = () => {};
  AppView._loadGovVoteRoster = () => {};
  return { AppView, calls };
}

test("an issue's repaint never mounts into the change page's head", () => {
  const head = headIn('dev-change-overview');
  const { AppView, calls } = makeAppView(head);
  AppView._devTopic = { kind: 'issue', id: 900008 };

  AppView._renderTopicHead();

  assert.deepEqual(calls.mounted, [], 'the change page keeps its own node');
  assert.equal(calls.published, 0, "and the issue's model is not published into it");
});

test("an issue's repaint mounts into its thread's head", () => {
  const head = headIn('dev-thread');
  const { AppView, calls } = makeAppView(head);
  AppView._devTopic = { kind: 'issue', id: 900008 };

  AppView._renderTopicHead();

  assert.deepEqual(calls.mounted, [head]);
  assert.equal(calls.published, 1);
});

test("a change page's repaint publishes into its own head without mounting", () => {
  const { AppView, calls } = makeAppView(headIn('dev-change-overview'));
  AppView._devTopic = { kind: 'proposal', id: 9000013 };

  AppView._renderTopicHead();

  assert.deepEqual(calls.mounted, []);
  assert.equal(calls.published, 1);
});

test("a change page's repaint leaves a thread's head to that thread", () => {
  const { AppView, calls } = makeAppView(headIn('dev-thread'));
  AppView._devTopic = { kind: 'proposal', id: 9000013 };

  AppView._renderTopicHead();

  assert.deepEqual(calls.mounted, []);
  assert.equal(calls.published, 0, "the issue's head is not overwritten with the proposal's card");
});
