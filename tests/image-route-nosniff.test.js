'use strict';

// #2515 (first item of the bundle): the binary routes that serve a STORED
// content type must send `X-Content-Type-Options: nosniff`.
//
// Each of these reads `content_type` out of a row and hands it straight to
// `res.set('Content-Type', …)`. That value was recorded at upload time, so a
// file whose row says `image/png` while its bytes are markup is a document
// the browser may sniff and render as HTML — on the platform's own origin,
// with the platform's cookies. `nosniff` is what forecloses that, and these
// four files had it nowhere.
//
// The rest of the platform already does this, which is what makes the gap a
// defect rather than a policy question: app-files, app-illustrations, chat,
// internal and sessions all set it at the send, and conversations sets it
// for a whole path prefix through its `privateJson` middleware.
//
// Scoped to the ONE named item. #2515 also lists "latent attribute-escaping
// defects, dead traversal helper, qs advisory, and three hardening nits",
// none of which the issue body describes — it is empty. Guessing at
// unspecified security items is worse than leaving them, so they are left,
// and this does not close the issue.
//
// Run with: node --test tests/image-route-nosniff.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES = path.join(__dirname, '..', 'src', 'routes');
const read = (f) => fs.readFileSync(path.join(ROUTES, f), 'utf8');

/** Files that send a content type taken from a stored row. */
const SERVE_STORED_TYPE = ['app-icons.js', 'avatars.js', 'issue-images.js', 'visuals.js'];

test('every route serving a stored content type also sends nosniff', () => {
  const missing = SERVE_STORED_TYPE.filter((f) => !/X-Content-Type-Options'?,?\s*'nosniff'/.test(read(f)));
  assert.deepEqual(missing, [],
    'a stored content_type is attacker-influenced; without nosniff the bytes decide');
});

test('nosniff is set on the same response as the stored type, not merely present in the file', () => {
  for (const f of SERVE_STORED_TYPE) {
    const src = read(f);
    for (const m of src.matchAll(/res\.set\('Content-Type',\s*([^)]*)\)/g)) {
      if (!/row|content_type|contentType/.test(m[1])) continue;
      // The next few statements must include the header.
      const after = src.slice(m.index, m.index + 400);
      assert.match(after, /X-Content-Type-Options/,
        `${f}: the send at ${m[1].trim()} must carry nosniff`);
    }
  }
});

test('the platform-wide habit this restores is still in place elsewhere', () => {
  // Named so that if one of these stops setting it, this test says where the
  // convention used to live rather than silently shrinking.
  for (const f of ['app-files.js', 'app-illustrations.js', 'chat.js', 'internal.js', 'sessions.js']) {
    assert.match(read(f), /nosniff/, `${f} is one of the routes that already did this`);
  }
  assert.match(read('conversations.js'), /function privateJson[\s\S]{0,200}nosniff/,
    'and conversations does it for a whole path prefix');
});
