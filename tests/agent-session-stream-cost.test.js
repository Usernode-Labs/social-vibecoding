'use strict';

// Streaming a reply in an agent session re-rendered the whole screen, and
// three screens beside it, for every token (#3104 follow-up, the phone
// smoothness audit). A reply arrives a token at a time, dozens a second, and
//
//   1. each token was a publish of the store (store.ts `patchTurn`), with no
//      frame between them;
//   2. every reader subscribed to the WHOLE snapshot: the panel, the composer,
//      each card, and the inbox, Recents and the app sheet, which draw only
//      the list of sessions;
//   3. no transcript row was memoized, and each past reply's markdown was a
//      fresh `{ __html }` object, so React 19 rewrote every earlier reply's
//      innerHTML on every token;
//   4. the live turn's one-second clock re-rendered the reply so far, and
//      re-parsed it, every second of a turn.
//
// Each is pinned here: the first by driving the real store, the rest by what
// the modules are made of.
//
// Run with: node --test tests/agent-session-stream-cost.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const STORE = 'frontend/src/features/agent-session/store.ts';

const SESSION = {
  id: 3, title: 'RSS Reader', status: 'open', focusApp: null, focusContext: {}, activeChange: null,
  doneUnseen: false, lastActivityAt: null, createdAt: null, busy: true,
};

/**
 * The real store, against a server that says the session is busy (so the
 * turn is running when it opens), and a hand-cranked animation frame.
 */
async function withStreamingStore(run, { stubs } = {}) {
  const frames = [];
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {} }, UsernodeReact: {} };
  globalThis.EventSource = class { close() {} };
  globalThis.requestAnimationFrame = (cb) => { frames.push({ cb, live: true }); return frames.length; };
  globalThis.cancelAnimationFrame = (handle) => { if (frames[handle - 1]) frames[handle - 1].live = false; };
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (/\/messages\?/.test(url)) return { messages: [], nextAfter: null };
      if (/\/actions$/.test(url)) return { actions: [] };
      if (/\/drafts/.test(url)) return { drafts: [] };
      return { session: SESSION, turn: { phase: 'mayor', startedAt: 1 } };
    },
  });
  const tick = () => {
    const due = frames.filter((frame) => frame.live);
    for (const frame of due) { frame.live = false; frame.cb(); }
    return due.length;
  };
  const pending = () => frames.filter((frame) => frame.live).length;
  try {
    const store = loadTsx(STORE, { stubs });
    await store.openAgentSession({ id: 3, host: 'messages' });
    assert.equal(store.getAgentSessionState().turn.running, true, 'opened on a running turn');
    await run(store, { tick, pending });
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
}

const token = (text, seq) => ({ type: 'token', text, _seq: `t-${seq}` });

test('a frame of tokens is ONE publish, landed on the next animation frame', async () => {
  await withStreamingStore(async (store, { tick, pending }) => {
    const before = store.getAgentSessionState();
    const words = Array.from({ length: 40 }, (_, i) => `w${i} `);
    words.forEach((word, i) => store.handleEvent(3, token(word, i)));
    assert.equal(store.getAgentSessionState(), before, 'forty tokens published nothing yet');
    assert.equal(pending(), 1, 'one frame is asked for, however many tokens arrive before it');
    assert.equal(tick(), 1);
    const after = store.getAgentSessionState();
    assert.notEqual(after, before, 'the frame publishes');
    assert.equal(after.turn.streamText, words.join(''), 'every token, in order');
    assert.equal(tick(), 0, 'and nothing is left over for another frame');
  });
});

test('the first words of a turn show at once, and mark it running', async () => {
  await withStreamingStore(async (store, { pending }) => {
    store.handleEvent(3, { type: 'done', _seq: 'd-0' });
    assert.equal(store.getAgentSessionState().turn.running, false);
    store.handleEvent(3, token('Hello', 1));
    const { turn } = store.getAgentSessionState();
    assert.equal(turn.running, true);
    assert.equal(turn.streamText, 'Hello', 'published without waiting for a frame');
    assert.equal(pending(), 0);
  });
});

test('any other event lands AFTER the words before it, never ahead of them', async () => {
  // A tool, a card, an error: the buffered words are flushed first.
  await withStreamingStore(async (store, { tick }) => {
    store.handleEvent(3, token('Reading ', 1));
    store.handleEvent(3, token('the app', 2));
    store.handleEvent(3, { type: 'tool', state: 'running', name: 'read_app', _seq: 'x-1' });
    const { turn } = store.getAgentSessionState();
    assert.equal(turn.streamText, 'Reading the app', 'the words are in before the tool');
    assert.ok(turn.activity, 'and the tool is applied');
    assert.equal(tick(), 0, 'the frame that was waiting has nothing left to do');

    store.handleEvent(3, token(' and more', 3));
    store.handleEvent(3, {
      type: 'confirmation_required',
      card: { id: 'c1', toolName: 'propose', title: 'Propose', input: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      _seq: 'x-2',
    });
    assert.equal(store.getAgentSessionState().turn.streamText, 'Reading the app and more');
    assert.equal(store.getAgentSessionState().turn.cards.length, 1);

    store.handleEvent(3, token(' then', 4));
    store.handleEvent(3, { type: 'error', error: 'boom', _seq: 'x-3' });
    assert.equal(store.getAgentSessionState().turn.streamText, 'Reading the app and more then');
    assert.equal(store.getAgentSessionState().error, 'boom');
  });
});

test('a phase change reads the reply as it stands, words still in the buffer included', async () => {
  // `phase` builds its patch from state.turn.streamText; read before the
  // flush, the buffered words would be dropped by the patch.
  await withStreamingStore(async (store) => {
    store.handleEvent(3, token('Planning ', 1));
    store.handleEvent(3, token('it', 2));
    store.handleEvent(3, { type: 'phase', phase: 'mayor', _seq: 'p-1' });
    assert.equal(store.getAgentSessionState().turn.streamText, 'Planning it');
    // The wrap-up starts its own reply.
    store.handleEvent(3, token(' now', 3));
    store.handleEvent(3, { type: 'phase', phase: 'mayor2', _seq: 'p-2' });
    assert.equal(store.getAgentSessionState().turn.streamText, '');
  });
});

test('the turn ending, or the screen closing, leaves no words to land later', async () => {
  await withStreamingStore(async (store, { tick }) => {
    store.handleEvent(3, token('last words', 1));
    store.handleEvent(3, { type: 'done', _seq: 'd-1' });
    assert.equal(store.getAgentSessionState().turn.running, false);
    assert.equal(tick(), 0);
    assert.equal(store.getAgentSessionState().turn.streamText, '', 'an idle turn, not a reply revived by a late frame');
  });
  await withStreamingStore(async (store, { tick }) => {
    store.handleEvent(3, token('mid-reply', 1));
    store.deactivateAgentSession();
    assert.equal(tick(), 0);
    assert.equal(store.getAgentSessionState().turn.streamText, '');
  });
});

test('a reader that picks fields keeps its snapshot while the reply streams', async () => {
  // useAgentSessionPick hands back the SAME object until a picked field
  // changes, which is what lets useSyncExternalStore skip the render. Driven
  // with a React whose hooks are run by hand.
  const refs = [];
  let at = 0;
  const react = {
    useRef: (initial) => { const i = at; at += 1; if (!refs[i]) refs[i] = { current: initial }; return refs[i]; },
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
  await withStreamingStore(async (store, { tick }) => {
    const render = (select) => { at = 0; return store.useAgentSessionPick(select); };
    const composer = (s) => ({ id: s.id, running: s.turn.running, stopping: s.turn.stopping, drafts: s.drafts });
    const first = render(composer);
    store.handleEvent(3, token('Hello', 1));
    store.handleEvent(3, token(' there', 2));
    tick();
    assert.equal(store.getAgentSessionState().turn.streamText, 'Hello there');
    assert.equal(render(composer), first, 'a frame of the reply is not a change the composer draws');
    store.handleEvent(3, { type: 'stopping', _seq: 's-1' });
    assert.notEqual(render(composer), first, 'a field it picked is');
    assert.equal(store.useAgentSessions(), store.getAgentSessionState().sessions);
  }, { stubs: { react } });
});

test('the screen reads the stream in two places only, and past replies keep their markup', () => {
  const panel = read('frontend/src/features/agent-session/index.tsx');
  // No component on the screen subscribes to the whole snapshot any more.
  assert.doesNotMatch(panel.replace(/^export \{ useAgentSessionState \} from '\.\/store';$/m, ''), /useAgentSessionState\(/,
    'every reader selects what it draws');
  // Only the live turn and the scroll follower read the streamed text.
  const readers = panel.split(/\n(?=(?:export )?(?:function|const) \w+)/)
    .filter((chunk) => /s\.turn\.streamText|s\.turn\)|turn\.streamText/.test(chunk))
    .map((chunk) => /(?:function|const) (\w+)/.exec(chunk)[1]);
  assert.deepEqual(readers.sort(), ['FollowOutput', 'LiveTurn']);
  // Rows are memo()'d and a reply's markdown keeps its wrapper.
  assert.match(panel, /^const Item = memo\(function Item\(/m);
  assert.match(panel, /^const MayorText = memo\(function MayorText\(/m);
  const mayor = panel.slice(panel.indexOf('const MayorText'), panel.indexOf('function appInitial'));
  assert.match(mayor, /const inner = useInnerHtml\(html \|\| ''\);/);
  assert.match(mayor, /dangerouslySetInnerHTML=\{inner\}/);
  for (const name of ['SpecCard', 'SpecMarkdown']) {
    const body = panel.slice(panel.indexOf(`function ${name}(`));
    assert.doesNotMatch(body.slice(0, body.indexOf('\n}\n')), /dangerouslySetInnerHTML=\{\{/, `${name} keeps its wrapper`);
  }
  // The live turn's clock ticks only while it is drawn, for a build.
  const live = panel.slice(panel.indexOf('function LiveTurn('), panel.indexOf('function EmptyState('));
  assert.match(live, /const ticking = turn\.running && turn\.phase === 'cc';/);
  assert.match(live, /\}, \[ticking\]\);/);
});

test('the readers outside the conversation read the list of sessions, not the snapshot', () => {
  for (const file of [
    'frontend/src/features/messages/index.tsx',
    'frontend/src/features/nav/recents-list.tsx',
    'frontend/src/features/app-context/app-context-sheet.tsx',
  ]) {
    const src = read(file);
    assert.match(src, /useAgentSessions\(\)/, `${file} reads the list`);
    assert.doesNotMatch(src, /useAgentSessionState\(/, `${file} does not re-render per token`);
  }
  const layout = read('frontend/src/features/agent-session/spec-layout.ts');
  assert.doesNotMatch(layout, /useAgentSessionState\(/, 'the side-pane flag the inbox reads is a selected boolean');
});
