// Source pins for the landing page's two-CTA header + full app directory:
//   - the CTA row offers exactly Sign in + Join waitlist (Create account
//     is deferred to the waitlist journey / gated-app taps),
//   - the directory grid matches the authed homescreen's launcher shape,
//   - gated tiles dim, badge a lock, and route taps to #signup with the
//     app deep link remembered,
//   - the shell probe is wired at boot and its columns exist in schema.
//
// These are content pins (same style as tests/chromeless-share-links
// .test.js): they hold the contract in place so a refactor that silently
// drops a piece fails loudly here.
//
// Run with: node --test tests/landing-directory.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ─── index.html: CTA row ──────────────────────────────────────────

test('landing CTAs: Sign in + Join waitlist only — no Create account', () => {
  const html = read('public/index.html');
  const ctas = html.match(/id="landing-ctas"[\s\S]*?<\/div>/);
  assert.ok(ctas, 'landing-ctas block exists');
  assert.match(ctas[0], /href="#login"/);
  assert.match(ctas[0], /id="landing-waitlist-cta"/);
  assert.doesNotMatch(ctas[0], /Create account/);
  assert.doesNotMatch(ctas[0], /href="#signup"/);
});

test('landing waitlist CTA scrolls to the on-page form', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /landing-waitlist-cta/);
  assert.match(js, /scrollIntoView/);
});

// ─── index.html: directory grid ───────────────────────────────────

test('landing directory uses the homescreen launcher-grid shape', () => {
  const html = read('public/index.html');
  const grid = html.match(/id="landing-apps"[^>]*class="([^"]*)"/);
  assert.ok(grid, 'landing-apps grid exists');
  // Same column progression as the authed #app-list grid.
  assert.match(grid[1], /grid-cols-2/);
  assert.match(grid[1], /md:grid-cols-3/);
});

// ─── auth-screens.js: tile renderer ───────────────────────────────

test('landing tiles mirror home cards and gate on requires_login', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /_buildLandingAppTile/);
  // Gated presentation: dimmed + lock + caption.
  assert.match(js, /opacity-50 grayscale/);
  assert.match(js, /Account required/);
  // Gated tap: remember the app deep link, then the signup flow.
  assert.match(js, /rememberDeepLink\('#app\/' \+ \(app\.slug \|\| ''\)\)/);
  assert.match(js, /location\.hash = '#signup'/);
  // Icon priority mirrors home.js iconTileFor: image > emoji > letter.
  assert.match(js, /data-icon', 'image'/);
  assert.match(js, /data-icon', 'emoji'/);
  assert.match(js, /data-icon', 'letter'/);
});

// ─── probe wiring ─────────────────────────────────────────────────

test('shell probe starts at boot and its columns are in schema', () => {
  assert.match(read('server.js'), /shell-probe'\)\.start\(config\)/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ADD COLUMN IF NOT EXISTS anon_shell VARCHAR\(10\) NOT NULL DEFAULT 'unknown'/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS anon_shell_checked_at TIMESTAMPTZ/);
});

// ─── public API contract ──────────────────────────────────────────

test('public apps API exposes the home-card fields the landing consumes', () => {
  const src = read('src/routes/public-api.js');
  for (const field of ['icon_emoji', 'icon_url', 'active_users', 'requires_login']) {
    assert.match(src, new RegExp(field), `public-api carries ${field}`);
  }
  // Fail-safe mapping: only a positive 'public' classification is open.
  assert.match(src, /a\.anon_shell !== 'public'/);
});
