'use strict';

// #1585's check had no route that could show what it asserts.
//
// The claim — "feed issue rows show recent comments with relative ages" — is
// true of the product. What was not reachable from a plain URL is the STATE.
// Two facts combine:
//
//   * the comment slots fill from an IntersectionObserver, because thirty
//     issues must not fire thirty requests on paint; and
//   * the feed is a chronological merge of issues, proposals, governance
//     rows, shared sessions, the discussion and merged work.
//
// So on a busy app the first ISSUE row sits well below the fold, nothing
// scrolls to it, nothing fills it, and the check read a screen on which its
// own claim was not being made. It passed or failed on how much had happened
// in the app that hour: green on one commit, red on the next with no feed
// change between them. That is not a flake to re-run, it is a check with no
// route.
//
// `?shot=feed-comments` is the route. It is the platform's own mechanism for
// a screen only reachable by interacting, and it is the same one the ⋯ menu
// and the secrets modal already use.
//
// Run with: node --test tests/feed-comments-deeplink.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_VIEW = read('public/js/app-view.js');
const DAPP = JSON.parse(read('dapp.json'));

/** The deep link's handler body. */
function handler() {
  const at = APP_VIEW.indexOf("if (shot === 'feed-comments') {");
  assert.ok(at > 0, "app-view.js handles ?shot=feed-comments");
  return APP_VIEW.slice(at, APP_VIEW.indexOf('\n      }\n', at));
}

test('the check points at the deep link, not at the bare feed', () => {
  const check = DAPP.tests.find((t) => (t.name || '').includes('#1585'));
  assert.ok(check, "the #1585 feed-comments check still exists");
  assert.match(check.path, /shot=feed-comments/,
    'the bare /?demo=1&view=feed route cannot show a filled comment slot — '
    + 'that is what made this check depend on the app\'s activity that hour');
  assert.match(check.path, /view=feed/, 'and it is still the feed, not the kanban');
  assert.match(check.expectSelector, /\.dev-feed-comment-time/,
    'the assertion itself is unchanged: a comment with a relative age');
});

test('it fills the slot directly rather than racing the observer', () => {
  const body = handler();
  // The observer is an OPTIMISATION. Scrolling and hoping it fires is what
  // made this flaky; calling the same function it calls is deterministic.
  assert.match(body, /AppView\._fillFeedComments\(slot\)/,
    'it calls the product\'s own fill, through the same cache and endpoint');
  assert.match(body, /scrollIntoView/,
    'and scrolls, because a before/after capture has to SHOW the row');
  assert.match(body, /#dev-feed \.dev-feed-comments\[data-comments-for\]/,
    'it looks for the slot the check looks for');
});

test('it stops: on arrival, on a route change, on a real gesture, and on a cap', () => {
  const body = handler();
  assert.match(body, /if \(slot\.querySelector\('\.dev-feed-comment-time'\)\) \{ done\(\); return; \}/,
    'arrival ends it — a capture must not keep re-scrolling under itself');
  assert.match(body, /App\.currentApp !== slug/, 'a navigate-away ends it');
  assert.match(body, /tries \+= 1\) > 40/, 'and it cannot poll forever in a real tab');
  // A human who opens the link must not be scrolled around afterwards. Same
  // guard the ⋯ menu deep link uses, and `isTrusted` is what tells a real
  // gesture from the synthetic ones this file's own machinery makes.
  assert.match(body, /e\.isTrusted/, 'a real gesture ends it, a synthetic one does not');
});

test('it writes nothing — so the BEFORE side of a capture works too', () => {
  const body = handler();
  // One GET, the one the observer would have made anyway. A deep link that
  // wrote something would make the before/after pair incomparable, and could
  // not be shipped ungated the way this one is.
  assert.doesNotMatch(body, /method:\s*'(POST|PATCH|PUT|DELETE)'/);
  assert.doesNotMatch(body, /IS_STAGING|USERNODE_ENV/,
    'not env-gated: it renders the same in every environment');
});
