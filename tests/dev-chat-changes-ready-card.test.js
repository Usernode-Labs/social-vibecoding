// #361: the "Changes ready" card (dc-pr-card) + "Propose to group" button
// must render whenever a turn produced a reviewable commit — driven by the
// staging-independent `changesReady` marker — NOT only when a staging
// preview built. This guards the three render shapes:
//   - changesReady + stagingFailed (no URL) → card, DISABLED Preview, Propose
//   - changesReady + stagingUrl            → full card (live Preview), Propose
//   - neither (a plain no-changes/spec/question status line) → NO card
//
// dev-chat.js is a plain browser script (`const DevChat = {…}`). We load its
// source into a vm context, stub the browser globals it reaches at load
// (localStorage / document / window / fetch / navigator) plus the shared
// `escapeHtml`, drive DevChat.renderMessages() against a fake #dc-messages
// element whose innerHTML setter records the HTML, and assert on it.
//
// Run with: node --test tests/dev-chat-changes-ready-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

// Build a DevChat in a sandbox with a fake #dc-messages whose innerHTML is
// captured. renderMessages() reads DevChat.messages + DevChat.currentSession.
function makeDevChat() {
  let captured = '';
  const messagesEl = {
    set innerHTML(v) { captured = v; },
    get innerHTML() { return captured; },
    querySelectorAll: () => ({ forEach: () => {} }),
    scrollTop: 0, scrollHeight: 0,
  };
  const noopEl = {
    style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
    appendChild: () => {}, innerHTML: '', textContent: '',
  };
  const sandbox = {
    console,
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    document: {
      getElementById: (id) => (id === 'dc-messages' ? messagesEl : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild: () => {} },
    },
    // #558: fetch is delegated through a mutable holder so promote tests can
    // swap in a deferred / failing implementation per-case; defaults to an
    // OK empty response (the shape the render tests rely on).
    fetch: async (...args) => sandbox.__fetchImpl(...args),
    // #558: promotePR() calls alert() on both failure paths; record calls so
    // tests can assert the message without a real dialog.
    alert: (msg) => { sandbox.__alerts.push(msg); },
    // Native-kit adoption: promotePR failure feedback is a PlatformUI
    // toast now — record it through the same __alerts sink.
    PlatformUI: {
      isTouch: () => false,
      hasKit: () => false,
      toast: (msg) => { sandbox.__alerts.push(msg); },
      alert: async (o) => { sandbox.__alerts.push((o && (o.message || o.title)) || o); return {}; },
      confirm: async () => true,
      transition: (fn) => fn(),
      attachScreenFx: () => {},
      detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }),
      swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    navigator: { sendBeacon: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.__fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  sandbox.__alerts = [];
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  // renderMarkdown is irrelevant to the card path; keep it cheap + safe.
  DevChat.renderMarkdown = (t) => String(t || '');
  return {
    DevChat,
    alerts: sandbox.__alerts,
    setFetch(fn) { sandbox.__fetchImpl = fn; },
    getHtml() { return captured; },
    render(messages, session) {
      DevChat.messages = messages;
      DevChat.currentSession = session || null;
      DevChat.renderMessages();
      return captured;
    },
  };
}

// #558: a minimal stand-in for the <button> the inline onclick passes as
// `this`. Tracks disabled state + innerHTML the way promotePR() drives them.
function makeButton() {
  return {
    disabled: false,
    innerHTML: 'Propose to group',
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    removeAttribute(k) { delete this._attrs[k]; },
    getAttribute(k) { return this._attrs[k] ?? null; },
  };
}

const activeSession = (over) => ({
  id: 7, status: 'active', pr_url: null, pr_number: null, ...over,
});

test('a CLI handoff reload derives the missing card from authoritative session state', () => {
  const { DevChat, render } = makeDevChat();
  const session = activeSession({
    id: 2969,
    source: 'cli_handoff',
    handoff_head_sha: 'a'.repeat(40),
    checks_commit_sha: 'a'.repeat(40),
    check_state: 'passing',
    checks_checked_at: '2026-08-04T10:00:00.000Z',
    staging_url: 'https://crypto-predictions--s2969.example.test',
    pr_number: 4,
    pr_url: 'https://github.com/usernode-bot/crypto-predictions/pull/4',
  });

  const hydrated = DevChat._hydrateChangesReadyFromSession(session, [
    { role: 'assistant', content: 'Local test results reported by the CLI agent.' },
  ]);
  assert.equal(hydrated.length, 2);
  assert.equal(hydrated[1]._derivedFromSession, true);
  assert.equal(hydrated[1].stagingUrl, session.staging_url);
  assert.equal(hydrated[1].changesReady, true);

  const html = render(hydrated, session);
  assert.match(html, /dc-pr-card/, 'the repaired session renders its Changes ready card');
  assert.match(html, /Preview staging/, 'the authoritative preview is available');
  assert.match(html, /PR #4/, 'the authoritative proposal link is available');
});

test('authoritative hydration never duplicates a persisted Changes ready card', () => {
  const { DevChat } = makeDevChat();
  const persisted = {
    id: 88, role: 'system', content: 'Staging deployed!',
    changesReady: true, stagingUrl: 'https://persisted.example.test',
  };
  const messages = [persisted];
  const hydrated = DevChat._hydrateChangesReadyFromSession(
    activeSession({ staging_url: 'https://current.example.test' }), messages
  );

  assert.equal(hydrated, messages, 'the original history array wins unchanged');
  assert.equal(hydrated.filter((m) => m.changesReady || m.stagingUrl).length, 1);
});

test('CLI terminal checks derive a card without a preview, but drafts and pending builds do not', () => {
  const { DevChat } = makeDevChat();
  const submitted = activeSession({
    source: 'cli_handoff', handoff_head_sha: 'b'.repeat(40), staging_url: null,
  });

  const failed = DevChat._hydrateChangesReadyFromSession(
    { ...submitted, check_state: 'error' }, []
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].changesReady, true);
  assert.equal(failed[0].stagingUrl, null);
  assert.match(failed[0].content, /checks need attention/i);

  assert.equal(DevChat._hydrateChangesReadyFromSession(
    { ...submitted, check_state: 'pending' }, []
  ).length, 0, 'an in-flight build does not claim changes are ready');
  assert.equal(DevChat._hydrateChangesReadyFromSession(
    activeSession({ source: 'cli_handoff', check_state: null, staging_url: null }), []
  ).length, 0, 'an untouched CLI draft does not get a card');
  assert.equal(DevChat._hydrateChangesReadyFromSession(
    activeSession({ check_state: 'passing', checks_commit_sha: 'c'.repeat(40) }), []
  ).length, 0, 'a non-CLI session needs an actual preview or persisted card');
  assert.equal(DevChat._hydrateChangesReadyFromSession(
    { ...submitted, status: 'archived', check_state: 'passing', staging_url: 'https://leaked.example.test' }, []
  ).length, 0, 'an archived teardown leak does not become a fresh interactive card');
});

test('changesReady WITHOUT stagingUrl renders the card with Propose + an ACTIVE (rebuild-on-click) Preview (#439)', () => {
  const { render } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging build failed',
      changesReady: true, stagingFailed: true,
      stagingErrorName: 'MissingSecretsError', stagingMissingKeys: ['EXAMPLE_KEY'],
      _slug: 'aaa111',
    },
  ], activeSession());

  assert.match(html, /dc-pr-card/, 'the Changes ready card renders');
  assert.match(html, /Propose to group/, 'Propose to group button present');
  // #439: the Preview button is now ACTIVE — clicking it triggers an
  // on-demand rebuild rather than being a disabled "proposing will rebuild
  // it" dead-end. The fallback URL is empty (no live/message URL yet).
  assert.doesNotMatch(html, /disabled[^>]*>Preview staging</, 'Preview staging is NOT disabled');
  assert.match(html, /previewStaging\('', false\)/, 'Preview wired to rebuild-on-click');
  // The old inline "proposing will rebuild it" note is gone — any failure
  // reason now surfaces in the preview loader on click instead.
  assert.doesNotMatch(html, /proposing will rebuild it/i, 'no stale disabled note');
});

test('a merged (previewGone) card keeps Preview disabled with the now-live tooltip (#439)', () => {
  const { render } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging deployed!',
      changesReady: true, stagingUrl: 'https://preview.example.org',
      _slug: 'aaa222',
    },
  ], activeSession({ status: 'merged', merged_at: '2026-06-26T00:00:00Z' }));

  assert.match(html, /dc-pr-card/, 'card still renders post-merge');
  assert.match(html, /disabled[^>]*>Preview staging</, 'Preview is disabled once merged');
  assert.match(html, /now live in the app/i, 'tooltip explains the change is now live');
  assert.doesNotMatch(html, /previewStaging\(/, 'no rebuild handler on a merged card');
});

test('stagingUrl renders the FULL card with a live Preview + Propose', () => {
  const { render } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging deployed!',
      changesReady: true, stagingUrl: 'https://preview.example.org',
      _slug: 'bbb222',
    },
  ], activeSession());

  assert.match(html, /dc-pr-card/, 'card renders');
  assert.match(html, /Propose to group/, 'Propose to group present');
  assert.match(html, /previewStaging\('https:\/\/preview\.example\.org', false\)/, 'live Preview button wired');
  assert.doesNotMatch(html, /disabled[^>]*>Preview staging</, 'Preview is NOT disabled when a URL exists');
});

test('a plain no-changes status line renders NO card', () => {
  const { render } = makeDevChat();
  const html = render([
    { role: 'system', content: 'No changes were made by Claude Code.', _slug: 'ccc333' },
  ], activeSession());

  assert.doesNotMatch(html, /dc-pr-card/, 'no card for a no-changes status');
  assert.doesNotMatch(html, /Propose to group/, 'no Propose button');
});

test('a spec/question status line (no marker) renders NO card', () => {
  const { render } = makeDevChat();
  const html = render([
    { role: 'system', content: 'Auto session drafted a spec.', _slug: 'ddd444' },
  ], activeSession());
  assert.doesNotMatch(html, /dc-pr-card/, 'spec/question outcomes keep their non-card guidance');
});

test('View on GitHub uses the message-carried prUrl when the session row lacks one', () => {
  const { render } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging build failed',
      changesReady: true, stagingFailed: true,
      prNumber: 123, prUrl: 'https://github.com/x/y/pull/123',
      _slug: 'eee555',
    },
  ], activeSession({ pr_url: null, pr_number: null }));
  assert.match(html, /View on GitHub/, 'GitHub link rendered from the marker');
  assert.match(html, /pull\/123/, 'links to the carried PR url');
});

// ── #558: Propose-to-group button disable + spinner on click ──────────────
// promotePR(btn) must, the instant it's clicked, disable the button and swap
// its label for a spinner so a slow request can't be double-submitted; the
// success path re-renders the card away, and both failure paths restore the
// button so the user can retry.

test('promotePR disables the button and shows the spinner while the request is in flight (#558)', async () => {
  const h = makeDevChat();
  h.DevChat.currentSession = { id: 7, status: 'active' };
  // Deferred fetch so we can inspect the button mid-flight.
  let release;
  h.setFetch(() => new Promise((res) => { release = () => res({ ok: true, json: async () => ({}) }); }));

  const btn = makeButton();
  const p = h.DevChat.promotePR(btn);

  // Pending: greyed out (disabled) + spinner swapped in, aria-busy set.
  assert.equal(btn.disabled, true, 'button is disabled while pending');
  assert.match(btn.innerHTML, /dc-status-spinner-arc/, 'spinner shown while pending');
  assert.match(btn.innerHTML, /Proposing/, 'label reads "Proposing…" while pending');
  assert.equal(btn.getAttribute('aria-busy'), 'true', 'aria-busy set while pending');

  release();
  await p;
});

test('promotePR re-entry guard: a second click while pending is a no-op (#558)', async () => {
  const h = makeDevChat();
  h.DevChat.currentSession = { id: 7, status: 'active' };
  let calls = 0;
  let release;
  h.setFetch(() => { calls++; return new Promise((res) => { release = () => res({ ok: true, json: async () => ({}) }); }); });

  const btn = makeButton();
  const p1 = h.DevChat.promotePR(btn);   // disables btn, fetch #1
  await h.DevChat.promotePR(btn);        // btn.disabled → early return, no fetch
  assert.equal(calls, 1, 'the disabled button blocks a second submit');

  release();
  await p1;
});

test('promotePR success re-renders the card without the Propose button (#558)', async () => {
  const h = makeDevChat();
  // A changes-ready card is on screen for the active session.
  h.render([
    { role: 'system', content: 'Staging deployed!', changesReady: true,
      stagingUrl: 'https://preview.example.org', _slug: 'prm001' },
  ], activeSession({ id: 7 }));
  assert.match(h.getHtml(), /Propose to group/, 'button present before promote');

  h.setFetch(async () => ({ ok: true, json: async () => ({ prNumber: 42, prUrl: 'https://github.com/x/y/pull/42' }) }));
  await h.DevChat.promotePR(makeButton());

  // status flipped to 'promoted' → renderMessages drops the (active-only) button.
  assert.equal(h.DevChat.currentSession.status, 'promoted', 'session promoted');
  assert.doesNotMatch(h.getHtml(), /Propose to group/, 'button gone after success re-render');
});

test('promotePR failure (non-OK) re-enables the button and restores its label (#558)', async () => {
  const h = makeDevChat();
  h.DevChat.currentSession = { id: 7, status: 'active' };
  h.setFetch(async () => ({ ok: false, json: async () => ({ error: 'Nope' }) }));

  const btn = makeButton();
  await h.DevChat.promotePR(btn);

  assert.equal(btn.disabled, false, 'button re-enabled after a failed response');
  assert.equal(btn.innerHTML, 'Propose to group', 'original label restored');
  assert.equal(btn.getAttribute('aria-busy'), null, 'aria-busy cleared');
  assert.deepEqual(h.alerts, ['Nope'], 'server error surfaced via alert');
});

test('promotePR failure (network error) re-enables the button and restores its label (#558)', async () => {
  const h = makeDevChat();
  h.DevChat.currentSession = { id: 7, status: 'active' };
  h.setFetch(async () => { throw new Error('boom'); });

  const btn = makeButton();
  await h.DevChat.promotePR(btn);

  assert.equal(btn.disabled, false, 'button re-enabled after a thrown error');
  assert.equal(btn.innerHTML, 'Propose to group', 'original label restored');
  assert.deepEqual(h.alerts, ['Network error'], 'network error surfaced via alert');
});
