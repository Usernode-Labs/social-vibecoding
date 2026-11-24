// Settings and Profile in the brand's editorial voice (#7072): the standard
// look's block of app.css, "SETTINGS AND PROFILE, THE EDITORIAL PAGES". It
// holds the block's own rules:
//
//   1. Every rule is scoped to the standard look, so the brand look and the
//      frame's looks keep their own drawing of both pages.
//   2. Every colour is a token, declared once in the block's first rule and
//      given its dark value in the second.
//   3. Source Serif 4 ships its variable weight range; headings use 600.
//   4. Nothing is hidden but the page's head on a phone's open page, whose
//      name the top bar already says.
//
// It also holds the two things the block leans on in the markup: Settings'
// head and the hooks on the profile card.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const css = read('public', 'css', 'app.css');
const SCOPE = 'html:not([data-skin])';

function block() {
  const start = css.indexOf('── SETTINGS AND PROFILE, THE EDITORIAL PAGES');
  const end = css.indexOf('END OF THE EDITORIAL PAGES.');
  assert.ok(start > 0 && end > start, 'app.css has the editorial block, start to end');
  assert.ok(start > css.indexOf('END OF STANDARD (WIP).'), 'after the look\'s own block, which it is no part of');
  return css.slice(css.indexOf('*/', start) + 2, css.lastIndexOf('/*', end)).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `selector { body }` of the block, media queries flattened. */
function rules() {
  const flat = block().replace(/@media[^{]*\{/g, '').replace(/\}\s*\}/g, '}');
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
}

/** A selector list's members: split on the commas outside every bracket. */
function members(selector) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(selector.slice(from, i)); from = i + 1; }
  }
  out.push(selector.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

test('every rule of the editorial pages is the standard look\'s alone', () => {
  const all = rules();
  assert.ok(all.length > 30, 'the block has its rules');
  for (const rule of all) {
    for (const one of members(rule.selector)) {
      assert.ok(one.startsWith(SCOPE), `scoped to the standard look: ${one}`);
    }
  }
  assert.ok(!/data-skin="brand"/.test(block()), 'the brand look keeps its own drawing');
});

test('its colours are tokens, declared once in light and once in dark', () => {
  const all = rules();
  const [light, dark, ...rest] = all;
  assert.equal(light.selector, SCOPE);
  assert.equal(dark.selector, `${SCOPE}.dark`);
  for (const token of ['--ed-serif', '--ed-paper', '--ed-line', '--ed-sky', '--ed-sky-veil', '--ed-sky-ink', '--ed-lit-bg', '--ed-lit-ink', '--ed-stat-bg']) {
    assert.match(light.body, new RegExp(`${token}:`), `${token} is declared`);
  }
  // The words on the sky, the paper and the green row all change in the dark.
  for (const token of ['--ed-paper', '--ed-line', '--ed-sky-veil', '--ed-sky-ink', '--ed-lit-bg', '--ed-lit-ink', '--ed-stat-bg']) {
    assert.match(dark.body, new RegExp(`${token}:`), `${token} has a dark value`);
  }
  for (const rule of rest) {
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(rule.body), `no colour of its own: ${rule.selector}`);
    assert.ok(!/--ed-[a-z-]+\s*:/.test(rule.body), `no token declared outside the first two rules: ${rule.selector}`);
  }
  assert.match(light.body, /--ed-sky: url\('\/brand\/bg\/sky\.webp'\)/, 'the sky is the brand\'s own picture');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'brand', 'bg', 'sky.webp')));
});

test('the editorial serif uses the shipped variable weight', () => {
  const serif = rules().filter((rule) => /font-family: var\(--ed-serif\)/.test(rule.body));
  assert.ok(serif.length >= 6, 'headings on both pages are in the serif');
  for (const rule of serif) {
    assert.match(rule.body, /font-weight: 600;/, `shipped weight: ${rule.selector}`);
  }
  assert.match(css, /@font-face \{\s*font-family: 'Source Serif 4';[^}]*font-weight: 200 900;/, 'the face ships the heading weight');
});

test('nothing is hidden but Settings\' head on a phone\'s open page', () => {
  const hidden = rules().filter((rule) => /display:\s*none|visibility:\s*hidden/.test(rule.body)).map((rule) => rule.selector);
  assert.deepEqual(hidden, [`${SCOPE} #settings-root:has(#settings-section-content:not(.hidden)) > .settings-frame-head`]);
  assert.match(block(), /@media \(max-width: 1023\.98px\) \{\s*html:not\(\[data-skin\]\) #settings-root:has\(#settings-section-content:not\(\.hidden\)\) > \.settings-frame-head \{ display: none; \}/);
});

test('Settings opens under its name on the sky, and its parts are cards', () => {
  const b = block();
  assert.match(b, /html:not\(\[data-skin\]\) #settings-root > \.settings-frame-head \{\s*display: flex;/, 'the head is drawn');
  assert.match(b, /background: var\(--ed-sky-veil\), var\(--ed-sky\) center \/ cover no-repeat;/, 'under a veil, so its words read');
  assert.match(b, /#settings-screen #settings-root \{ max-width: none; \}/, 'the page runs the window\'s width');
  assert.match(b, /#settings-section-content > \[data-settings-section\]:not\(\.hidden\):has\(> :not\(\.hidden\)\) \{[^}]*border: 1px solid var\(--ed-line\);[^}]*background: var\(--ed-paper\);/, 'a part is a paper card');
  // Username, Email & recovery and Password stay one group under "Sign-in" (#5281).
  assert.match(b, /~ :is\(\[data-settings-section="email"\], \[data-settings-section="password"\]\):not\(\.hidden\):has\(> :not\(\.hidden\)\) \{[^}]*border-top: 0;/);
  assert.match(b, /#settings-sidebar-col\.settings-side-sheet \{[^}]*--lit-tint: var\(--ed-lit-bg\);[^}]*--lit-ink: var\(--ed-lit-ink\);/, 'the page you are on is the green row');
  const src = read('frontend', 'src', 'features', 'settings', 'index.tsx');
  assert.match(src, /<header className="settings-frame-head">/, 'the head is in the document for it');
});

test('Profile opens on who you are, across the page', () => {
  const b = block();
  assert.match(b, /#profile-root > div > div:has\(> #profile-identity-card\) \{ display: contents; \}/);
  assert.match(b, /#profile-root #profile-identity-card \{ grid-column: 1 \/ -1; grid-row: 1; \}/);
  assert.match(b, /#profile-root #profile-stats \{ grid-column: 1 \/ -1; grid-row: 2; \}/);
  // Only a page that holds your own card is widened: somebody else's keeps its column.
  assert.match(b, /#profile-screen #profile-root:has\(#profile-identity-card\) \{ max-width: none; \}/);
  // A hidden strip (every figure a zero) stays hidden.
  assert.match(b, /#profile-root #profile-stats:not\(\.hidden\) \{\s*display: flex;/);
  assert.match(b, /#profile-stats > \[data-profile-stat\]:not\(\.hidden\) \{/);
  const view = read('frontend', 'src', 'features', 'profile', 'profile-view.tsx');
  for (const hook of ['profile-id-avatar', 'profile-id-name', 'profile-id-sub', 'profile-id-bio']) {
    assert.ok(view.includes(hook), `the card carries ${hook}`);
    assert.ok(b.includes(`.${hook}`) || hook === 'profile-id-sub', `and the block reads ${hook}`);
  }
  assert.match(b, /#profile-identity-card #profile-edit-btn \{[^}]*background: var\(--wip-btn-1-bg\);/, 'Edit profile is the main action');
});


test('project cards show each real project once and keep its newest change', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { ProfileLiveProjects } = loadTsx('frontend/src/features/profile/profile-live-projects.tsx', {
    stubs: { '../../lib/i18n/react': { useMessages: () => (id, params) => params?.title || id } },
  });
  const html = renderToHtml(createElement(ProfileLiveProjects, { changes: [
    { sessionId: 3, title: 'Newest <change>', appSlug: 'garden', appName: 'Garden' },
    { sessionId: 2, title: 'Another project', appSlug: 'tides', appName: 'Tides' },
    { sessionId: 1, title: 'Older change', appSlug: 'garden', appName: 'Garden' },
  ] }));
  assert.equal((html.match(/class="profile-project-card"/g) || []).length, 2);
  assert.match(html, /Newest &lt;change&gt;/);
  assert.doesNotMatch(html, /Older change/);
  assert.match(html, /href="#app\/garden"/);
  const empty = renderToHtml(createElement(ProfileLiveProjects, { changes: [] }));
  assert.match(empty, /profile:projects.empty/);
  assert.doesNotMatch(empty, /class="profile-project-card"/);
});
