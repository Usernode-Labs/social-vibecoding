'use strict';

// #2236's intermittent "1 console error on load" on the demo issue page
// (`NotFoundError: Failed to execute 'removeChild' … [island
// portal:dev-topic-thread]`).
//
// `#gc-thread-head` is two different nodes: the thread panel's empty slot,
// which AppView._renderTopicHead mounts an issue's (or a governance topic's)
// head into, and the change page's, which React renders with its own
// TopicHead inside. Opening an issue from a change page leaves the change
// page in `#dev-topic-thread` until `_mountTopicThread` swaps it, after the
// topic's data load. A repaint inside that window used to adopt the change
// page's head: mountLegacyPortal's first-mount `replaceChildren()` pulled
// another portal's DOM out from under React, the publish then removeChild()ed
// a node that was gone, and the caught error left the issue's discussion
// blank. The checks runner hits it because it moves between routes by hash
// (a change page's cohort, then the issue's); a cold load never does.
//
// The head paint skipped a head that belonged to a change page when the
// topic was not one, until #4455 made a change's page a thread as well.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function harness() {
  const els = {};
  const calls = { mount: [], publish: [] };
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 7 } },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ aiEnabled: true }) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    UsernodeReact: {
      devBoard: {
        mountTopicHead: (host) => { calls.mount.push(host); },
        publishTopicHead: (state) => { calls.publish.push(state); },
        publishAiEnabled: () => {},
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._ensureAiAvailability = () => Promise.resolve(true);
  AppView._refreshAiAvailability = () => {};
  AppView._fillKudosHosts = () => {};
  AppView._loadIssueComments = () => {};
  AppView._loadGovVoteRoster = () => {};
  AppView._topicViewFor = () => ({ card: {}, body: {} });
  return { AppView, els, calls };
}

// A #gc-thread-head inside the thread panel's shell.
function head() {
  return {
    closest: (selector) => (selector === '.dev-thread' || selector === '.dev-request' ? {} : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// #4455 retired the race at its root: a change's page is a thread too, so
// `#gc-thread-head` is ONE kind of node again, the thread panel's slot, and
// every topic's head is mounted into it per paint. There is no second
// TopicHead for an issue's paint to land in, and so no guard to keep.
for (const kind of ['issue', 'gov', 'proposal', 'session']) {
  test(`a ${kind} topic paints into the thread panel's slot`, () => {
    const { AppView, els, calls } = harness();
    AppView._devTopic = { kind, id: 900008 };
    AppView._findTopicItem = () => ({ id: 900008, number: 900008, state: 'open', status: kind === 'session' ? 'active' : 'promoted' });
    els['gc-thread-head'] = head();
    AppView._renderTopicHead();
    assert.deepEqual(calls.mount, [els['gc-thread-head']]);
    assert.equal(calls.publish.length, 1);
  });
}

test('the change page\'s own head and its guard are gone (#4455)', () => {
  const src = SRC.slice(SRC.indexOf('  _renderTopicHead() {'));
  assert.doesNotMatch(SRC, /dev-change-overview|mountChangePage/);
  assert.match(src, /react\.mountTopicHead\(head\);/);
  const mount = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-board', 'mount.ts'), 'utf8');
  assert.doesNotMatch(mount, /mountChangePage|dev-change-overview/);
});
