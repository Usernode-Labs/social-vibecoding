// The confirmation mails lead with one obvious action (#1540).
//
// The confirm step used to be a sentence followed by the raw URL printed as
// its own link text: sixty-odd characters of
// `https://…/api/public/waitlist/confirm/<48 hex>` wrapping across two lines.
// That is not a call to action, it is a machine address a person is asked to
// aim at — and sitting next to a large six-digit code it read as the lesser of
// two chores rather than the one-tap path it is.
//
// What this does NOT do is remove the code. #1516 put it first deliberately:
// on a phone, leaving for the mail app and coming back loses the WebView's
// place, so typing six digits beats following a link. The code is the primary
// path and the button is the one-tap alternative; "one clear CTA" here means
// the link stops being a URL, not that a path is deleted.
//
// Run with: node --test tests/mail-cta.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const templates = require(path.join(ROOT, 'src/services/mail/templates.js'));

const CONFIRM = 'https://x.invalid/api/public/waitlist/confirm/' + 'b'.repeat(48);
const MORE = 'https://x.invalid/#more/' + 'b'.repeat(48);

/** The href and inner text of every anchor in a rendered mail. */
function anchors(html) {
  return Array.from(html.matchAll(/<a\s+href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g),
    (m) => ({ href: m[1], attrs: m[2], text: m[3] }));
}

test('the confirm link is a button, not a printed URL', () => {
  const { html } = templates.buildMessage('waitlist_joined',
    { code: '123456', confirmUrl: CONFIRM, url: MORE });
  const confirm = anchors(html).find((a) => a.href === CONFIRM);
  assert.ok(confirm, 'the confirm link is still there');
  assert.equal(confirm.text, 'Confirm my email', 'it reads as an action');
  assert.notEqual(confirm.text, CONFIRM, 'and never as the address itself');
  assert.match(confirm.attrs, /padding:11px 20px/, 'styled as a control');
  assert.match(confirm.attrs, /text-decoration:none/);
});

test('the same treatment on the resend mail', () => {
  const { html } = templates.buildMessage('waitlist_code',
    { code: '424242', confirmUrl: CONFIRM });
  const confirm = anchors(html).find((a) => a.href === CONFIRM);
  assert.ok(confirm);
  assert.equal(confirm.text, 'Confirm my email');
});

test('the status-code mail leads with the code and offers one action (#1538)', () => {
  // Same six digits, different errand: a confirmed address asking to read
  // where it stands. The code stays first for the same reason it is first
  // everywhere else, and the single button goes to a query spelling (#1545),
  // never to a capability token.
  const STATUS = 'https://x.invalid/?status=1';
  const { html, text, subject } = templates.buildMessage('waitlist_code',
    { code: '424242', confirmed: true, statusUrl: STATUS });

  assert.match(subject, /status code/i, 'the subject says what the code is for');
  assert.match(html, /font-size:28px[^>]*>424242</, 'the code is the code block');
  assert.ok(html.indexOf('424242') < html.indexOf(STATUS), 'and it comes first');

  const links = anchors(html);
  assert.equal(links.length, 1, 'one action, not a choice of two');
  assert.equal(links[0].href, STATUS);
  assert.equal(links[0].text, 'Check my status');
  assert.match(links[0].attrs, /padding:11px 20px/, 'styled as a control');

  // No confirm link: there is nothing left to confirm, and a mail nobody
  // asked for must not carry a capability anyone can act on.
  assert.doesNotMatch(html, /waitlist\/confirm\//);
  assert.doesNotMatch(text, /Confirm my email/);
  // The text part still carries the address for a reader with no HTML.
  assert.match(text, /https:\/\/x\.invalid\/\?status=1/);
  // And it says the older code is dead, because it is.
  assert.match(text, /earlier code has stopped working/i);
});

test('the status-code mail renders without a link at all', () => {
  // statusUrl is derived, so a deployment without an origin to build one
  // from must still get a usable mail rather than "undefined".
  const { html, text } = templates.buildMessage('waitlist_code',
    { code: '424242', confirmed: true });
  assert.equal(anchors(html).length, 0);
  assert.doesNotMatch(text, /undefined|null/);
  assert.match(text, /424242/);
});

test('the access-ready mail names its action too', () => {
  const create = templates.buildMessage('waitlist_released',
    { url: 'https://x.invalid/?signup=1', hasAccount: false });
  assert.equal(anchors(create.html)[0].text, 'Create my account');
  const signIn = templates.buildMessage('waitlist_released',
    { url: 'https://x.invalid/?login=1', hasAccount: true });
  assert.equal(anchors(signIn.html)[0].text, 'Sign in');
});

test('the CODE is still the primary path, and still first (#1516)', () => {
  // The button must not have displaced it: on a phone the code is the path
  // that does not lose the reader's place.
  const { html, text } = templates.buildMessage('waitlist_joined',
    { code: '123456', confirmUrl: CONFIRM, url: MORE });
  assert.match(html, /font-size:28px[^>]*>123456</);
  assert.ok(html.indexOf('123456') < html.indexOf(CONFIRM),
    'the code comes before the button');
  assert.ok(text.indexOf('123456') < text.indexOf('Thanks for joining'));
});

test('the text part still carries the URL itself', () => {
  // A reader with no HTML has nothing to tap; the address is the only thing
  // that helps them, so shortening the SENTENCE must not drop the link.
  for (const [kind, payload] of [
    ['waitlist_joined', { code: '1', confirmUrl: CONFIRM, url: MORE }],
    ['waitlist_code', { code: '1', confirmUrl: CONFIRM }],
    ['waitlist_released', { url: 'https://x.invalid/?signup=1' }],
  ]) {
    const { text } = templates.buildMessage(kind, payload);
    assert.match(text, /https:\/\/x\.invalid/, `${kind}: the URL is in the text part`);
  }
});

test('a mail with no confirm link renders no button and no stray placeholder', () => {
  const { html, text } = templates.buildMessage('waitlist_joined', { code: '123456' });
  assert.equal(anchors(html).length, 0);
  assert.doesNotMatch(text, /one tap/);
  assert.doesNotMatch(text, /undefined|null/);
});
