'use strict';

// Render the dev chat's composer the way the browser does.
//
// The bar used to be one block of `renderChatView`'s template with six
// writers reaching into it afterwards, and the tests that cover it drove
// `DevChat` in a `vm` and read the resulting DOM stub. #1078's composer chunk
// split that in two: dev-chat.js builds a plain view MODEL (`_composerView`)
// and frontend/src/features/dev-chat/composer.tsx renders it.
//
// So a test that used to say
//
//     h.render(); return h.sendBtn().className;
//
// says
//
//     h.render(); return h.html();
//
// and keeps its assertions. The MODEL is the more precise place to read a
// decision from — `t.state().send.kind` is exactly the branch
// `_setStreamingUI` used to paint by hand — so most of the re-pointed
// assertions moved there, with the html checked for what actually ships.
//
// Same limits as ./dev-transcript-html.js: effects do not run, React escapes
// text children, and attribute order is React's.

const { loadTsx, renderToHtml, createElement } = require('./render-tsx');

let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/dev-composer-api.ts')));

const EMPTY = {
  venueNoteHtml: '', hidden: false, models: null, openRouter: null,
  drafts: { rows: [], busy: false }, attachError: null, placeholder: '',
  saveDraft: { hidden: true, disabled: true, title: '' },
  send: { kind: 'send' }, shortcutHintHtml: '',
};

/** The whole composer, as html. `state` may be a cross-realm object. */
function composerHtml(state) {
  const m = mod();
  return renderToHtml(createElement(m.DevComposerView, {
    s: JSON.parse(JSON.stringify(state || EMPTY)),
  }));
}

/**
 * The `window.UsernodeReact.devChat` a sandbox publishes into.
 *
 * Every method of the real bridge is here; only the composer's record
 * anything. The four strips INSIDE the composer publish through their own
 * stores, which is why this sets them rather than stashing their state.
 */
function makeComposerBridge() {
  let state = EMPTY;
  let mounts = 0;
  let view = null;
  const noop = () => {};
  const bridge = {
    // #1078: `renderChatView` mounts the whole SCREEN and every region
    // below publishes into it, so a harness that drives it needs this
    // method to exist or the render bails on its first line.
    mountDevView: (_h, s) => { view = s; },
    publishDevView: (s) => { view = s; },
    mountComposer: (_h, s) => { mounts += 1; state = s; },
    publishComposer: (s) => { state = s; },
    publishAttachStrip: (s) => mod().attachStripStore.set(JSON.parse(JSON.stringify(s))),
    publishBudgetPill: (s) => mod().budgetPillStore.set(JSON.parse(JSON.stringify(s))),
    publishQuickReplies: (s) => mod().quickRepliesStore.set(JSON.parse(JSON.stringify(s))),
    publishRunner: (s) => mod().runnerStore.set(JSON.parse(JSON.stringify(s))),
    mountTranscript: noop, publishTranscript: noop, publishStream: noop, publishNow: noop,
    mountSessionList: noop, publishSessionList: noop,
    mountSessionHeader: noop, publishSessionHeader: noop,
    publishSpecViewer: noop,
    mountBanners: noop, publishBanners: noop,
  };
  return {
    bridge,
    /** The last published view model, as plain same-realm data. */
    state: () => JSON.parse(JSON.stringify(state)),
    /** How many times the portal was (re-)mounted rather than republished. */
    mounts: () => mounts,
    /** The whole screen's last published model. */
    view: () => (view ? JSON.parse(JSON.stringify(view)) : null),
    /** The last published model, rendered. */
    html: () => composerHtml(state),
  };
}

module.exports = { composerHtml, makeComposerBridge, api: mod };
