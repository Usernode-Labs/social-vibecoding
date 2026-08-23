// The admin console's NINE heavy sections, seen through the React seam
// (#1082 chunk E, step 2).
//
// Chunk E's step 1 moved all ten admin modules into the shell bundle in one
// commit, because they were a single <script>-order cluster: admin-topochain.js
// reads AdminUI.card at module-evaluation time, and /shell/assets/shell.js is a
// module script that evaluates after every classic <script>, so retiring
// admin-console.js on its own would have left nine modules reading an undefined
// global. That move is mechanical; what it can silently break is not.
//
// This file pins the nine heavy sections — Health & status, Node & chain,
// Analytics, Estimator accuracy, Merge debug, Screenshot gallery, Maintenance
// campaigns, Push delivery, Email delivery — against the four ways the move could have cost
// something with every grep still passing:
//
//  1. AN ANCHOR STOPS BEING PRODUCED. dapp.json's declared #admin/* checks
//     select on ids these modules render. The ids are read OUT of dapp.json
//     here rather than hand-listed, so the two cannot drift apart and a
//     newly-declared check is covered the moment it lands. This is the half
//     tests/dapp-selectors-resolve.test.js deliberately cannot cover: it
//     exempts every id the pre-migration document also lacked as
//     "runtime-injected before and after", and all of these are — they only
//     ever existed once a section rendered. That exemption is what this file
//     pays for.
//
//  2. A POLL OUTLIVES ITS SECTION. #860's whole lifecycle rule. Health &
//     status polls /api/status every 5s (which shells out to `docker stats`
//     server-side) and Node & chain polls /api/node-status every 2s, so a
//     section left mounted is a server load leak for the life of the tab.
//     AdminConsole._teardownActiveSection is the single choke point; each
//     module's destroy() has to actually clear what it started.
//
//  3. A MODULE WRITES INTO REACT-OWNED DOM. The chassis (#admin-root, the
//     sidebar host, the view-only banner, the temp-password dialog) is React's
//     now. AGENTS.md's rule is that no public/js/** — or, here, bundled —
//     module may write inside a React-owned subtree. #admin-section-content is
//     the seam: React renders it empty and never looks inside again.
//
//  4. A demo=1 FLAG IS LOST. ~12 declared checks get their staging fixtures
//     through a client-side ?demo=1 passthrough. Losing one shows up as an
//     empty page in a PR preview, not as an error.
//
// Run with: node --test tests/admin-heavy-sections-island.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ADMIN_DIR = path.join(root, 'frontend/src/features/admin');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// A section is a `.js` (innerHTML) or a `.tsx` (React) module — #1120 is
// converting them one at a time, and every rule in this file is about the
// section's CONTRACT with the console, which the renderer does not change.
const modExt = (name) => (fs.existsSync(path.join(ADMIN_DIR, `${name}.tsx`)) ? 'tsx' : 'js');
const readMod = (name) => fs.readFileSync(path.join(ADMIN_DIR, `${name}.${modExt(name)}`), 'utf8');

const islandTsx = read('frontend/src/features/admin/index.tsx');
const consoleJs = readMod('admin-console');
const manifest = JSON.parse(read('dapp.json'));

// The nine, with the SECTION_MODULES key and window global each one answers
// to. Seasons/topochain is step 3's subject and admin-console.js is step 1's.
const HEAVY = [
  { key: 'status', file: 'admin-status', global: 'AdminStatus' },
  { key: 'node', file: 'admin-node', global: 'AdminNode' },
  { key: 'analytics', file: 'admin-analytics', global: 'AdminAnalytics' },
  { key: 'estimator', file: 'admin-estimator', global: 'AdminEstimator' },
  { key: 'merges', file: 'admin-merges', global: 'AdminMerges' },
  { key: 'gallery', file: 'admin-gallery', global: 'AdminGallery' },
  { key: 'campaigns', file: 'admin-campaigns', global: 'AdminCampaigns' },
  { key: 'push', file: 'admin-push', global: 'AdminPush' },
  { key: 'mail', file: 'admin-mail', global: 'AdminMail' },
];

const SRC = new Map(HEAVY.map((s) => [s.file, readMod(s.file)]));

// ── 1. The seam itself ──────────────────────────────────────────────────

test('each heavy section is imported by the island and reachable through window', () => {
  for (const { key, file, global } of HEAVY) {
    // The island imports it for its side effect: evaluating the module is
    // what publishes the global.
    assert.ok(islandTsx.includes(`import './${file}.${modExt(file)}';`),
      `the console island must import ${file}.${modExt(file)}`);
    // AdminConsole._renderSection dispatches through window[modName], so the
    // publication is the actual contract — and it must be guarded, because
    // the SSG prerender pass evaluates this module in Node.
    // `(window as any).X = X` in a converted section — same publication, the
    // cast is only TypeScript's price for writing to the global object.
    assert.match(SRC.get(file),
      new RegExp(`if \\(typeof window !== 'undefined'\\) \\(?window(?: as any\\))?\\.${global} = ${global};`),
      `${file} must publish window.${global}, guarded for the prerender pass`);
    assert.match(consoleJs, new RegExp(`${key}: '${global}'`),
      `SECTION_MODULES must still map ${key} -> ${global}`);
  }
});

test('each heavy section imports the class registry instead of finding it', () => {
  // Before the move this was a bare global read that happened to work because
  // admin-console.js's <script> came first. Inside the bundle the order is not
  // a document detail any more, so the dependency is declared.
  for (const { file } of HEAVY) {
    assert.match(SRC.get(file), /^import \{ AdminUI \} from '\.\/admin-console\.js';$/m,
      `${file}.js must import AdminUI rather than rely on load order`);
  }
  assert.match(consoleJs, /^export const AdminUI = Object\.freeze\(\{$/m,
    'admin-console.js must export the registry it used to only publish');
});

test('every heavy section still honours the render(host) / destroy() contract', () => {
  for (const { file } of HEAVY) {
    const src = SRC.get(file);
    // The parameter name varies across the nine (host / hostEl / sectionHost);
    // what the console's dispatcher relies on is that there is exactly one, and
    // that the section takes its root from it rather than from the document.
    // `render(el: Element)` in a converted section — one parameter either way.
    assert.match(src, /\n\s*render\(\w+(?:: [\w.<>[\] |]+)?\) \{/,
      `${file} must expose render(<host>)`);
    assert.match(src, /\n\s*destroy\(\) \{/, `${file}.js must expose destroy()`);
  }
});

// ── 2. Anchors, read out of dapp.json ───────────────────────────────────

// Which module owns which section, for the checks below. The console's own
// self-rendered sections and Seasons are excluded: they are steps 1 and 3.
const SECTION_OWNER = Object.fromEntries(HEAVY.map((s) => [s.key, s.file]));

// Pull `#some-id` out of a selector, ignoring pseudo-classes and attribute
// selectors — the declared checks use both.
function idsIn(selector) {
  return [...(selector || '').matchAll(/#([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

test('every id a declared #admin check selects on is produced by its section', () => {
  const declared = (manifest.tests || []).filter((t) => /^\/(\?[^#]*)?#admin\//.test(t.path || ''));
  assert.ok(declared.length >= 20,
    `expected the console's declared checks to still be there, saw ${declared.length}`);

  let asserted = 0;
  for (const t of declared) {
    const key = (t.path.split('#admin/')[1] || '').split('/')[0];
    const file = SECTION_OWNER[key];
    if (!file) continue;                       // a step 1 or step 3 section
    for (const id of idsIn(t.expectSelector)) {
      // #admin-screen / #admin-section-content are the chassis, which React
      // renders — those are pinned by tests/shell-id-inventory.test.js.
      if (id === 'admin-screen' || id === 'admin-section-content' || id === 'admin-root') continue;
      assert.ok(
        SRC.get(file).includes(`id="${id}"`),
        `dapp.json's ${t.path} check selects #${id}, which ${file}.js no longer renders`,
      );
      asserted += 1;
    }
  }
  // A selector-parsing slip would make the loop above vacuous rather than red.
  assert.ok(asserted >= 10, `expected to have checked at least 10 anchors, checked ${asserted}`);
});

test('the anchors the chunk brief names by hand are all still rendered', () => {
  // Belt and braces over the derived check: these are the ids the issue calls
  // out, including ones no declared check happens to select today.
  const NAMED = {
    'admin-status-root': 'admin-status',
    'admin-node-root': 'admin-node',
    'admin-gallery-root': 'admin-gallery',
    'admin-campaigns-root': 'admin-campaigns',
    'admin-estimator-root': 'admin-estimator',
    'admin-estimator-card': 'admin-estimator',
    'admin-mail-status': 'admin-mail',
    'admin-mail-send': 'admin-mail',
    'spend-distribution': 'admin-analytics',
    'gu-mau': 'admin-analytics',
    'pu-l4': 'admin-analytics',
  };
  for (const [id, file] of Object.entries(NAMED)) {
    assert.ok(SRC.get(file).includes(`id="${id}"`), `${file}.js must still render #${id}`);
  }
  // #admin-credit-balance belongs to a console-rendered section (limits), so
  // it lives in the chassis module rather than one of the nine.
  assert.ok(consoleJs.includes('id="admin-credit-balance"'),
    'admin-console.js must still render #admin-credit-balance');
});

// ── 3. Lifecycle: nothing outlives its section ──────────────────────────

test('every interval a heavy section starts is cleared in its destroy()', () => {
  for (const { file } of HEAVY) {
    const src = SRC.get(file);
    const starts = (src.match(/setInterval\(/g) || []).length;
    if (!starts) continue;
    const clears = (src.match(/clearInterval\(/g) || []).length;
    assert.ok(clears >= 1,
      `${file} starts ${starts} interval(s) and never clears one — a section left `
      + 'mounted would poll for the life of the tab (#860)');
    const destroy = src.slice(src.indexOf('destroy() {'));
    if (modExt(file) === 'tsx') {
      // A converted section (#1120) owns its poll in an effect, so the chain
      // is: destroy() drops the portal -> React unmounts -> the effect's
      // cleanup clears the timer. Both links are asserted, because either one
      // missing leaves the same 2s poll running for the life of the tab.
      assert.match(destroy.slice(0, 900), /unmountLegacyPortal\(/,
        `${file}'s destroy() must drop its portal — that is what unmounts the effect`);
      assert.match(src, /return \(\) => \{[^}]*clearInterval\(/,
        `${file} must clear its interval from an effect CLEANUP, not merely somewhere`);
    } else {
      // Either destroy() clears directly (status, campaigns) or it calls the
      // one function that owns the timer (merges' setLive(false), which clears
      // before deciding whether to restart). Both are the same guarantee.
      assert.match(destroy.slice(0, 900), /clearInterval\(|setLive\(false\)/,
        `${file}.js's destroy() must stop its poll`);
    }
  }
});

test('the two body-level tooltips are removed by their own destroy()', () => {
  // Analytics and Estimator append <div id="dc-tip"> to <body> so the tooltip
  // can escape the section's overflow. That node is OUTSIDE both the section
  // host and every React-owned subtree, so only destroy() can reclaim it.
  for (const file of ['admin-analytics', 'admin-estimator']) {
    const src = SRC.get(file);
    assert.ok(src.includes('document.body.appendChild'),
      `${file}.js is expected to escape the section host with a body-level tip`);
    const destroy = src.slice(src.indexOf('destroy() {'), src.indexOf('destroy() {') + 700);
    assert.match(destroy, /getElementById\('dc-tip'\)/, `${file}.js's destroy() must find the tip`);
    assert.match(destroy, /\.remove\(\)/, `${file}.js's destroy() must remove it`);
  }
});

test('teardown stays a single choke point in the console', () => {
  assert.match(consoleJs, /_teardownActiveSection\(\)\s*\{/,
    'the console must still own one teardown path');
  // Both routes into a section switch pass through it: the desktop sidebar
  // switch and the phone's level-2 -> level-1 back press.
  const renderSection = consoleJs.slice(consoleJs.indexOf('  _renderSection() {'));
  assert.match(renderSection.slice(0, 600), /_teardownActiveSection\(\)/,
    'rendering a section must tear the outgoing one down first');
  const renderContent = consoleJs.slice(consoleJs.indexOf('  _renderContent() {'));
  assert.match(renderContent.slice(0, 600), /_teardownActiveSection\(\)/,
    'returning to the phone menu must tear the outgoing section down too');
});

// ── 4. The React boundary ───────────────────────────────────────────────

test('no heavy section reaches into the React-owned chassis', () => {
  // The island renders #admin-root and everything in it except the contents of
  // #admin-section-content. A module writing inside any of the rest would be
  // reconciled over on the next render — the exact failure AGENTS.md's
  // "a region may become stateful only when its entire subtree is React-owned"
  // rule exists to prevent.
  const OFF_LIMITS = ['admin-root', 'admin-nav-desktop', 'admin-view-only-banner',
    'admin-temp-pw-modal', 'admin-temp-pw-value', 'admin-temp-pw-username'];
  for (const { file } of HEAVY) {
    for (const id of OFF_LIMITS) {
      assert.ok(!SRC.get(file).includes(id),
        `${file}.js references #${id}, which is React-owned chassis — sections own only `
        + 'the host they are handed');
    }
  }
});

test('sections render into the host they are given, not by id lookup', () => {
  // render(host) receives #admin-section-content; re-finding it by id would
  // couple the nine to a chassis id that is now React's to choose.
  for (const { file } of HEAVY) {
    assert.ok(!SRC.get(file).includes("getElementById('admin-section-content')"),
      `${file}.js must use its host argument rather than looking the host up`);
  }
});

// ── 5. The demo=1 inventory ─────────────────────────────────────────────

test('every client-side demo=1 passthrough survived the move, and is prerender-safe', () => {
  // The whole inventory, grepped rather than trusted: exactly six read sites
  // across the console. Four of the nine heavy sections read the page-level
  // flag for themselves; the other two sites are the chassis module's rollover
  // and staging-reap reads. Health & status, Node & chain, Campaigns, Push and Mail
  // have no demo path at all and must not grow one here.
  const OWN_FLAG = ['admin-analytics', 'admin-estimator', 'admin-gallery', 'admin-merges'];
  for (const file of OWN_FLAG) {
    const src = SRC.get(file);
    // Guarded because this runs at module-EVALUATION time and the SSG
    // prerender pass evaluates the module graph in Node. The browser answer is
    // unchanged: an absent flag already meant false.
    assert.match(src,
      /const DEMO = typeof window !== 'undefined'\s*\n?\s*&& new URLSearchParams\(location\.search\)\.get\('demo'\) === '1'/,
      `${file}.js must still read the page-level demo flag, guarded`);
    // And the flag has to actually reach a URL, or it is decoration.
    assert.match(src, /if \(DEMO\)|DEMO \?/, `${file}.js must use DEMO to build its request`);
  }
  for (const file of ['admin-status', 'admin-node', 'admin-campaigns', 'admin-push', 'admin-mail']) {
    assert.ok(!/\bdemo\b/.test(SRC.get(file)),
      `${file}.js had no demo passthrough before the move and must not have grown one`);
  }
  const demoQS = (consoleJs.match(/const demoQS = new URLSearchParams\(location\.search\)/g) || []);
  assert.equal(demoQS.length, 2,
    'admin-console.js must still carry the flag onto the rollover and staging-reap reads');
});

test('no section grew a server-side demo gate of its own', () => {
  // The client flag only ever selects a payload the SERVER decides to
  // fabricate, and only on staging. A module inventing its own fixtures would
  // put mock data one query parameter away on production.
  for (const { file } of HEAVY) {
    assert.ok(!/USERNODE_ENV/.test(SRC.get(file)),
      `${file}.js must not read the environment — the demo payload is the server's call`);
  }
});
