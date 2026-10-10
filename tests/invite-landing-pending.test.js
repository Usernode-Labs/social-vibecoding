'use strict';

// An invite link's landing never shows the waitlist pitch first (4 October
// 2026 first-session run-through). Signed out on /invite/<token>, the old
// pitch ("Opening gradually", "Join the waitlist") drew for about two seconds
// before the "Made for you" cards replaced it, because the pitch was hidden
// only once a LIVE preview was back. Now the pitch stays hidden while the
// preview is on its way, a quiet placeholder stands where the cards go, and
// the pitch comes back only for a dead link or a preview that cannot be read.
//
// tests/community-invites.test.js pins the card's words and the landing's
// pitch wiring. This file RUNS useInvitePreview (frontend/src/features/auth/
// invite-card.tsx) against a hand-stepped React, effects included, which
// renderToStaticMarkup never runs, and renders the placeholder.
//
// Run with: node --test tests/invite-landing-pending.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CARD_PATH = 'frontend/src/features/auth/invite-card.tsx';
const TOKEN = 'YigKXxtTzBB_TFZVTkjEtg';
const LIVE = {
  live: true, reason: null,
  project: { name: 'Flat 4B Chores', iconEmoji: '🧹', iconUrl: null, description: null, picture: null },
  inviter: 'jordan_t1004', inviterName: 'jordan_t1004', inviterMadeIt: true, note: null, memberCount: 1,
};

// ── A React small enough to step through: useState and useEffect only ────

function createFakeReact() {
  const slots = [];
  let cursor = 0;
  let renderFn = null;
  let passive = [];
  const React = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) {
        const state = { value: typeof initial === 'function' ? initial() : initial };
        state.set = (next) => {
          const value = typeof next === 'function' ? next(state.value) : next;
          if (Object.is(value, state.value)) return;
          state.value = value;
          render();
        };
        slots[i] = state;
      }
      return [slots[i].value, slots[i].set];
    },
    useEffect(effect, deps) {
      const i = cursor++;
      // Every effect here runs once ([] deps), as on a mount.
      if (i in slots) return;
      slots[i] = { deps };
      passive.push(() => { slots[i].cleanup = effect(); });
    },
  };
  function render() {
    cursor = 0;
    passive = [];
    renderFn();
    for (const run of passive) run();
  }
  return {
    React,
    mount(fn) { renderFn = fn; render(); },
    unmount() { for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup(); },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Mount useInvitePreview at `pathname` with `fetchImpl` as the page's fetch,
 * and return a reader for its latest answer.
 */
function mountHook({ pathname, fetchImpl }) {
  const fake = createFakeReact();
  // The hook under test draws nothing; the card's text components are not
  // rendered here, so the React half of the language runtime is stubbed with
  // the English reader and the stepped React stays two hooks small.
  const card = loadTsx(CARD_PATH, {
    stubs: {
      react: fake.React,
      '../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t, Message: () => null, RichMessage: () => null },
    },
  });
  const calls = [];
  globalThis.location = { pathname };
  globalThis.fetch = (url) => { calls.push(url); return fetchImpl(url); };
  let latest = null;
  fake.mount(() => { latest = card.useInvitePreview(); });
  return { read: () => latest, calls, unmount: fake.unmount, card };
}

function answering(body) {
  return () => Promise.resolve({ json: () => Promise.resolve(body) });
}

const realFetch = globalThis.fetch;
test.afterEach(() => {
  delete globalThis.location;
  globalThis.fetch = realFetch;
});

test('on an invite link the preview is pending from the first render until a live one is back', async () => {
  const hook = mountHook({ pathname: `/invite/${TOKEN}`, fetchImpl: answering(LIVE) });
  // The first render already knows: no frame of the pitch before the fetch.
  assert.deepEqual(hook.read(), { preview: null, pending: true });
  assert.deepEqual(hook.calls, [`/api/public/invites/${TOKEN}`]);
  await flush();
  assert.equal(hook.read().pending, false);
  assert.equal(hook.read().preview.live, true);
  assert.equal(hook.read().preview.project.name, 'Flat 4B Chores');
  hook.unmount();
});

test('a dead link ends the wait with its reason, so the landing shows why above the pitch', async () => {
  const hook = mountHook({ pathname: `/invite/${TOKEN}`, fetchImpl: answering({ live: false, reason: 'expired' }) });
  assert.equal(hook.read().pending, true);
  await flush();
  assert.deepEqual(hook.read(), { preview: { live: false, reason: 'expired' }, pending: false });
  hook.unmount();
});

test('a preview that cannot be read ends the wait with nothing, so the pitch comes back', async () => {
  for (const fetchImpl of [
    () => Promise.reject(new TypeError('Failed to fetch')),
    answering({ error: 'Internal server error' }),
    () => Promise.resolve({ json: () => Promise.reject(new SyntaxError('Unexpected token')) }),
  ]) {
    const hook = mountHook({ pathname: `/invite/${TOKEN}`, fetchImpl });
    assert.equal(hook.read().pending, true);
    await flush();
    assert.deepEqual(hook.read(), { preview: null, pending: false });
    hook.unmount();
  }
});

test('a preview that hangs stops holding the pitch back after the wait, and still lands if it comes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve;
  const hook = mountHook({
    pathname: `/invite/${TOKEN}`,
    fetchImpl: () => new Promise((r) => { resolve = r; }),
  });
  assert.equal(hook.card.INVITE_PREVIEW_WAIT_MS, 8000);
  t.mock.timers.tick(7999);
  assert.equal(hook.read().pending, true);
  t.mock.timers.tick(1);
  assert.deepEqual(hook.read(), { preview: null, pending: false });
  resolve({ json: () => Promise.resolve(LIVE) });
  await flush();
  assert.equal(hook.read().preview.live, true, 'a late live preview still turns the screen into Made for you');
  assert.equal(hook.read().pending, false);
  hook.unmount();
});

test('anywhere else nothing is pending and nothing is fetched', async () => {
  for (const pathname of ['/', '/invite/nope', `/invite/${TOKEN}/extra`]) {
    const hook = mountHook({ pathname, fetchImpl: answering(LIVE) });
    assert.deepEqual(hook.read(), { preview: null, pending: false }, pathname);
    await flush();
    assert.deepEqual(hook.calls, [], pathname);
    hook.unmount();
  }
});

test('the first render reads the path the way onInvitePath does; the prerender, with no location, is not pending', () => {
  // The real React, through renderToStaticMarkup, which runs no effects: the
  // answer is the initializer's alone.
  const { useInvitePreview } = loadTsx(CARD_PATH);
  const Probe = () => createElement('i', null, String(useInvitePreview().pending));
  assert.equal('location' in globalThis, false, 'node has no location, like the prerender pass');
  assert.equal(renderToHtml(createElement(Probe)), '<i>false</i>');
  globalThis.location = { pathname: `/invite/${TOKEN}` };
  assert.equal(renderToHtml(createElement(Probe)), '<i>true</i>');
  globalThis.location = { pathname: '/' };
  assert.equal(renderToHtml(createElement(Probe)), '<i>false</i>');
  // The same initializer the landing's onInvitePath uses.
  const initializer = /useState\(\s+\(\) => typeof location !== 'undefined' && !!inviteTokenFrom\(location\.pathname\),\s+\);/;
  assert.match(read(CARD_PATH), new RegExp(`const \\[pending, setPending\\] = ${initializer.source}`));
  assert.match(read('frontend/src/features/auth/landing.tsx'), new RegExp(`const \\[onInvitePath, setOnInvitePath\\] = ${initializer.source}`));
});

test('the placeholder stands where the cards go: one status line, quiet geometry, no pitch', () => {
  const { InvitePending } = loadTsx(CARD_PATH);
  const html = renderToHtml(createElement(InvitePending, {}));
  assert.match(html, /<div class="sr-only" role="status">Opening your invite<\/div>/);
  assert.match(html, /<div class="animate-pulse" aria-hidden="true" data-landing-invite="pending">/);
  // The first card's tile and two lines, then the picture's 340px frame.
  assert.match(html, /h-12 w-12 rounded-xl/);
  assert.match(html, /mt-3 h-\[340px\]/);
  assert.doesNotMatch(html, /waitlist|Opening gradually|Sign in/i);
});

test('the landing hides its pitch while the preview is pending and draws the placeholder in the cards\' place', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /const \{ preview: invite, pending: invitePending \} = useInvitePreview\(\);/);
  assert.match(landing, /const pitchHidden = madeForYou \|\| storyOn \|\| invitePending;/);
  // Only until a preview is in hand, and above the live and dead cards.
  const pending = landing.indexOf('{invitePending && !invite ? <InvitePending /> : null}');
  const live = landing.indexOf('{madeForYou ? <MadeForYou ');
  const dead = landing.indexOf('{invite && !invite.live ? <DeadInvite preview={invite} /> : null}');
  assert.ok(pending > 0, 'the placeholder renders');
  assert.ok(pending < live && live < dead, 'placeholder, then the live cards, then a dead link\'s line');
  // A dead link still keeps the pitch: pitchHidden carries no dead-link term.
  assert.doesNotMatch(landing, /pitchHidden = [^;]*!invite\.live/);
});
