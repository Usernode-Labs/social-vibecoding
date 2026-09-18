'use strict';

// #1688: "Thank evan for putting this up" (features/leaderboard/kudos.js).
//
// On a fresh proposal the kudos slot used to be a bare 👏 with a count. Now,
// while the viewer has neither voted nor thanked, the slot spells out what
// it is for, with the author's name; once they have done either it is the
// count pill again. Pins:
//
//   1. `thanksVariant`: the author's name on a fresh, promoted proposal the
//      viewer did not write; null otherwise — voted, thanked, own, not up
//      for a vote, read-only, no author to name;
//   2. `renderButton`: the thanks face in the compact slot, the count still
//      riding along hidden so the live counter has somewhere to land; the
//      count pill everywhere else and whenever the button is disabled.
//
// Run with: node --test tests/kudos-thanks-variant.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

if (!globalThis.window) globalThis.window = globalThis;
// kudos.js escapes through a scratch element, as the shell does.
globalThis.document = {
  createElement: () => ({
    _t: '',
    set textContent(v) { this._t = String(v); },
    get innerHTML() { return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  }),
};
globalThis.App = { user: { id: 1, username: 'alice' } };
globalThis.AppView = { readOnly: false };
loadTsx('frontend/src/features/leaderboard/kudos.js');
const Kudos = globalThis.window.Kudos;

const fresh = (over) => ({
  id: 9, status: 'promoted', my_vote: null, user_id: 2, username: 'evan',
  kudos_count: 0, my_kudos: false, my_kudos_direct: false, ...(over || {}),
});

test('thanksVariant: the author\'s name on a fresh proposal, null once there is nothing to prompt', () => {
  assert.equal(Kudos.thanksVariant(fresh()), 'evan');
  assert.equal(Kudos.thanksVariant(fresh({ id: 10, my_vote: 'yes' })), null, 'already voted');
  assert.equal(Kudos.thanksVariant(fresh({ id: 11, my_vote: 'no' })), null);
  assert.equal(Kudos.thanksVariant(fresh({ id: 12, my_kudos: true, my_kudos_direct: true })), null, 'already thanked');
  assert.equal(Kudos.thanksVariant(fresh({ id: 13, user_id: 1 })), null, 'your own');
  assert.equal(Kudos.thanksVariant(fresh({ id: 14, status: 'merged' })), null, 'not up for a vote');
  assert.equal(Kudos.thanksVariant(fresh({ id: 15, username: '  ' })), null, 'nobody to name');
  assert.equal(Kudos.thanksVariant(null), null);
  globalThis.AppView.readOnly = true;
  try {
    assert.equal(Kudos.thanksVariant(fresh({ id: 16 })), null, 'a read-only viewer cannot thank');
  } finally {
    globalThis.AppView.readOnly = false;
  }
});

test('renderButton: the thanks face in the compact slot, the count pill everywhere else', () => {
  Kudos.primeFromPr(fresh({ id: 20, my_kudos: false, my_kudos_direct: false }));
  const html = Kudos.renderButton(fresh({ id: 20, kudos_count: 3 }), { compact: true });
  assert.match(html, /class="kudos-wrap relative inline-block" data-kudos-session="20" data-kudos-variant="thanks"/);
  assert.match(html, /<button class="gc-vote-btn dev-thanks-pill"\s+data-kudos-action="give" data-kudos-session-id="20">/);
  assert.match(html, /<span aria-hidden="true">👏<\/span><span class="dev-thanks-label">Thank evan for putting this up<\/span><span data-kudos-count class="hidden">3<\/span>/);
  assert.doesNotMatch(html, /disabled/);

  const escaped = Kudos.renderButton(fresh({ id: 21, username: 'a<b' }), { compact: true });
  assert.match(escaped, /Thank a&lt;b for putting this up/, 'the name is escaped like any other');

  const regular = Kudos.renderButton(fresh({ id: 22 }), {});
  assert.match(regular, /data-kudos-variant="count"/, 'the regular button is the count pill');
  assert.doesNotMatch(regular, /dev-thanks-pill|dev-thanks-label/);
  assert.match(regular, /<span data-kudos-count>0<\/span>/);

  const voted = Kudos.renderButton(fresh({ id: 23, my_vote: 'yes', kudos_count: 2 }), { compact: true });
  assert.match(voted, /data-kudos-variant="count"/);
  assert.match(voted, /<span data-kudos-count>2<\/span>/, 'the count shows once the prompt has done its work');

  const own = Kudos.renderButton(fresh({ id: 24, user_id: 1 }), { compact: true });
  assert.match(own, /data-kudos-variant="count"/);
  assert.match(own, /disabled/, 'no thanking yourself, as before');

  const off = Kudos.renderButton(fresh({ id: 25 }), { compact: true, disabled: true, disabledReason: 'Not yet' });
  assert.match(off, /data-kudos-variant="count"/, 'a disabled slot never prompts');
  assert.match(off, /title="Not yet"/);
});
