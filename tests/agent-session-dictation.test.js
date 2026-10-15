'use strict';

// Exercise the real composer's busy callback and rendered controls without
// a microphone or a model request. Hardware transcription is tested in Brave.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) return tree.map((child) => find(child, predicate)).find(Boolean) || null;
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}

function composerHarness() {
  const React = require(require.resolve('react', { paths: [path.join(__dirname, '..', 'frontend')] }));
  let slots = [];
  let cursor = 0;
  const slot = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial();
    return index;
  };
  // Effects do not affect these button states. Keep hooks between renders,
  // then drive the same onChange/onBusyChange callbacks the UI uses.
  const react = {
    ...React,
    useState(initial) {
      const index = slot(() => typeof initial === 'function' ? initial() : initial);
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef: (current) => slots[slot(() => ({ current }))],
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useEffect() {},
    useLayoutEffect() {},
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const state = {
    id: 6, phase: 'ready', session: { id: 6, status: 'open', focusApp: null },
    draft: null, returnedText: null, composerFill: null, handoff: null,
    drafts: [], attachments: [], messages: [], actions: [], outbox: [],
    credits: null, error: null, drawerOpen: false, specSheet: null, preview: null,
    catalog: null, choosing: false, turn: { running: false, stopping: false, phase: null },
  };
  const calls = [];
  const api = loadTsx('frontend/src/features/agent-session/index.tsx', { stubs: {
    react,
    '../../lib/i18n/react': { useMessages: () => message },
    './store': {
      useAgentSessionPick: (pick) => pick(state),
      useAgentSessionSelector: (pick) => pick(state),
      composerId: () => 'test-agent-composer',
      sendAgentMessage: (text) => { calls.push(['send', text]); },
      saveComposerDraft: (text) => { calls.push(['save', text]); return true; },
      stopAgentTurn: () => { calls.push(['stop']); },
    },
  } });
  // Obtain the private composer from the actual panel's element tree rather
  // than exposing a production API solely for the regression test.
  const panel = api.AgentSessionPanel({ embedded: true });
  const composer = find(panel, (node) => node.props?.id === 'test-agent-composer');
  assert.ok(composer, 'the real panel mounts its composer');
  slots = [];
  function render() {
    cursor = 0;
    return composer.type(composer.props);
  }
  const field = (tree) => find(tree, (node) => node.type === 'textarea');
  const speak = (tree) => find(tree, (node) => node.props?.scope === 'agent:6');
  const button = (tree, kind) => find(tree, (node) => node.props?.['data-agent-session-send'] === kind);
  function disabled(node) {
    assert.ok(node, 'the expected control is present');
    return /\sdisabled=""/.test(renderToHtml(createElement(node.type, node.props)));
  }
  return { state, calls, render, field, speak, button, disabled,
    form: (tree) => find(tree, (node) => node.type === 'form'),
    stop: (tree) => find(tree, (node) => node.props?.['aria-label'] === 'Stop' && node.props?.type === 'button'),
  };
}

test('agent Send and Save draft follow dictation busy state, while Stop remains available', () => {
  const h = composerHarness();
  let tree = h.render();
  h.field(tree).props.onChange({ target: { value: 'Keep these typed words.' } });
  tree = h.render();
  assert.equal(h.disabled(h.button(tree, 'send')), false);

  // Busy covers permission, recording and transcription through one callback.
  h.speak(tree).props.onBusyChange(true);
  tree = h.render();
  assert.equal(h.disabled(h.button(tree, 'send')), true, 'Send is natively disabled during dictation');
  h.form(tree).props.onSubmit({ preventDefault() {} });
  h.field(tree).props.onKeyDown({ key: 'Enter', metaKey: true, nativeEvent: {}, preventDefault() {} });
  assert.deepEqual(h.calls, [], 'form and keyboard submission preserve the draft while busy');
  assert.equal(h.field(tree).props.value, 'Keep these typed words.');

  h.speak(tree).props.onBusyChange(false);
  tree = h.render();
  assert.equal(h.disabled(h.button(tree, 'send')), false, 'Send recovers when dictation ends');

  h.state.turn.running = true;
  h.state.turn.phase = 'mayor';
  tree = h.render();
  assert.equal(h.disabled(h.button(tree, 'save')), false);
  h.speak(tree).props.onBusyChange(true);
  tree = h.render();
  assert.equal(h.disabled(h.button(tree, 'save')), true, 'Save draft is natively disabled during dictation');
  assert.equal(h.disabled(h.stop(tree)), false, 'a live agent can still be stopped beside Save draft');
  h.form(tree).props.onSubmit({ preventDefault() {} });
  assert.deepEqual(h.calls, [], 'no partial draft is saved');

  h.speak(tree).props.onBusyChange(false);
  tree = h.render();
  assert.equal(h.disabled(h.button(tree, 'save')), false, 'Save draft recovers when dictation ends');
  h.form(tree).props.onSubmit({ preventDefault() {} });
  assert.deepEqual(h.calls, [['save', 'Keep these typed words.']]);

  tree = h.render();
  h.speak(tree).props.onBusyChange(true);
  tree = h.render();
  assert.equal(h.disabled(h.button(tree, 'stop')), false, 'Stop is available in the empty running composer too');
  h.button(tree, 'stop').props.onClick();
  assert.deepEqual(h.calls.at(-1), ['stop']);
  for (const turn of [{ stopping: true, phase: 'mayor' }, { stopping: false, phase: 'mayor2' }]) {
    Object.assign(h.state.turn, turn);
    tree = h.render();
    assert.equal(h.disabled(h.button(tree, 'stop')), true, 'existing Stop restrictions still apply');
  }
});
