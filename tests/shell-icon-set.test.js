// The shell's glyphs come from ONE module, and one FAMILY.
//
// #1120 slice 4 pulled 36 inline `<svg>` blocks out of frontend/src/features/**
// and into frontend/@/components/ui/icons.tsx. That conversion was worth
// something only because it pinned what makes an icon set rot:
//
//   1. Nothing drifts back. One inline `<svg>` re-added beside the module is
//      how a set ends up with two spellings of the same glyph, which is the
//      state that slice found the tree in (five copies of the close X, four of
//      the back chevron).
//   2. Every `d` in the PRERENDERED document is a string the module exports.
//      That is what makes "the shipped markup matches the source of truth"
//      checkable rather than asserted.
//
// What it could NOT pin is the one that actually bit: the set was Heroicons
// v1 AND v2, so it disagreed with itself — three plusses, two checks, and a
// paperclip drawn twice at different decimal precision. A refactor forbidden
// from changing pixels can only record that.
//
// The set is lucide v1.35.0 now, transcribed rather than imported, so a third
// strand joins the two above: every glyph carries a `// lucide/<slug>`
// provenance comment naming the file it came from. That is what makes a
// redraw distinguishable from a transcription — and the package ban stays,
// because <Glyph>'s two table-driven callers interpolate shapes into markup
// that an imported component cannot supply.
//
// Run with: node --test tests/shell-icon-set.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ICONS = read('frontend/@/components/ui/icons.tsx');
const HTML = read('public/index.html');
const PKG = JSON.parse(read('frontend/package.json'));

/**
 * Every SVG path the module draws. lucide's data lives in JSX `d="…"`
 * attributes (and in `solid()`'s single-quoted argument), and roughly half of
 * its paths open with a relative `m` rather than an absolute `M`.
 */
function modulePaths() {
  const out = new Set();
  for (const m of ICONS.matchAll(/\sd="([Mm][^"]*)"/g)) out.add(m[1]);
  for (const m of ICONS.matchAll(/'([Mm][^'\\\n]*)'/g)) out.add(m[1]);
  return out;
}

/** Each glyph export, paired with its declaration body. */
function moduleBodies() {
  const out = new Map();
  for (const part of ICONS.split(/^export const /m).slice(1)) {
    const name = /^(\w+)/.exec(part)[1];
    if (name.endsWith('Icon')) out.set(name, part);
  }
  return out;
}

/** Each glyph export and the path data it draws (primitives excluded). */
function moduleGlyphs() {
  const out = new Map();
  for (const [name, body] of moduleBodies()) {
    const paths = [];
    for (const m of body.matchAll(/\sd="([Mm][^"]*)"/g)) paths.push(m[1]);
    for (const m of body.matchAll(/'([Mm][^'\\\n]*)'/g)) paths.push(m[1]);
    if (paths.length) out.set(name, paths);
  }
  return out;
}

/** Every `<svg>` opening tag in a source file, brace- and quote-aware. */
function svgTags(src) {
  const out = [];
  for (let at = src.indexOf('<svg'); at !== -1; at = src.indexOf('<svg', at + 1)) {
    out.push(src.slice(at, src.indexOf('>', at) + 1));
  }
  return out;
}

function featureFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  walk('frontend/src');
  return out;
}

test('the set is lucide, transcribed — not an icon package', () => {
  const deps = { ...(PKG.dependencies || {}), ...(PKG.devDependencies || {}) };
  for (const name of Object.keys(deps)) {
    assert.ok(!/lucide|heroicons|react-icons|@tabler\/icons/.test(name),
      `frontend/package.json depends on ${name} — the shell ships its glyphs `
      + 'inline, and <Glyph>’s table-driven callers need shapes as DATA, which '
      + 'an imported component cannot give them');
  }
  assert.ok(!/^\s*import[^\n]*['"]lucide/m.test(ICONS),
    'icons.tsx imports from a lucide package — transcribe the shapes instead');

  // Every glyph names the lucide file it came from. Without this a hand-redraw
  // and a faithful transcription look identical in review, which is how the
  // set drifted the first time.
  const missing = [];
  for (const m of ICONS.matchAll(/^export const (\w+Icon) = (glyph|solid)\(/gm)) {
    // The provenance comment sits on the declaration line or, for a multi-line
    // glyph, on the `(  // lucide/slug` that opens its children.
    const decl = ICONS.slice(m.index, ICONS.indexOf('\n', ICONS.indexOf('(', m.index)) + 1);
    if (!/\/\/ lucide\/[\w-]+/.test(decl)) missing.push(m[1]);
  }
  // Two are the shell's own and say so in prose: the GitHub mark (lucide
  // removed brand icons in 2023) and the filled bookmark (lucide ships no
  // solid variant, so the saved state is its outline path, filled).
  // SpinnerArcIcon is neither — it is not built by a factory at all.
  assert.deepEqual(missing.sort(), ['BookmarkSolidIcon', 'GitHubIcon'],
    'these glyphs carry no `// lucide/<slug>` provenance comment');
});

test('the glyphs live in the module, not inline beside it', () => {
  const offenders = [];
  for (const file of featureFiles()) {
    const src = read(file);
    // A literal `d="M…"` or `d="m…"` is the tell: an inline glyph with its
    // own path data. Both cases matter — roughly half of lucide's paths open
    // with a RELATIVE moveto, so an uppercase-only check misses them.
    // `d={…}` is not a tell: the Dev card and the app card's visibility chip
    // pick their shapes out of a table at render time, and <Glyph> is the
    // escape hatch they use.
    if (/\sd="[Mm]/.test(src)) offenders.push(file);
  }
  // The admin console's own two glyphs — the panel ✕ and a nested screen's
  // back chevron — are the one exception. They are PORTS, not new glyphs, and
  // importing from @/components/ui/icons.tsx is not the alternative:
  // AGENTS.md's density boundary forbids an admin source from reaching into
  // the shell's primitives, and tests/admin-ui-registry.test.js enforces it.
  //
  // These were checkable byte for byte against admin-topochain.js's own
  // _panel() / detail renderer while those existed. #1120 slice 35 retired
  // the last of them — that module renders no markup at all now — so the
  // anchor is structural instead, and it is the one that protects what is
  // left: exactly two paths, each exported as a component, and no other admin
  // source inlining one. A second offender in this list is a copy that will
  // drift, not a third legitimate port.
  const PORTED = 'frontend/src/features/admin/topochain/ui.tsx';
  if (offenders.includes(PORTED)) {
    const src = read(PORTED);
    const ported = src.match(/\sd="([Mm][^"]*)"/g) || [];
    assert.equal(ported.length, 2,
      `${PORTED} may carry exactly the two ported glyphs — the ✕ and the back chevron`);
    for (const fn of ['CloseButton', 'BackButton']) {
      assert.match(src, new RegExp(`export function ${fn}\\(`),
        `${fn} is exported, so the screens have something to import instead of copying`);
    }
    // And they are actually used through those components, not re-declared.
    const screens = fs.readdirSync(path.join(ROOT, 'frontend/src/features/admin/topochain'))
      .filter((f) => f.endsWith('.tsx') && f !== 'ui.tsx');
    for (const f of screens) {
      const s2 = read(`frontend/src/features/admin/topochain/${f}`);
      assert.ok(!/\sd="[Mm]/.test(s2), `${f} imports the glyph rather than inlining it`);
    }
    offenders.splice(offenders.indexOf(PORTED), 1);
  }
  assert.deepEqual(offenders, [],
    'these files inline SVG path data — move the glyph into '
    + 'frontend/@/components/ui/icons.tsx and import it:\n  ' + offenders.join('\n  '));
  // The blanket "no raw <svg>" half is the SHELL's rule. The admin console
  // draws its own data charts and always has — admin-analytics.js,
  // admin-estimator and admin-topochain each emit an <svg> of <rect>s and
  // <line>s — and a bar chart is not a glyph that escaped the module. Those
  // files only became visible here when #1120 started converting console
  // sections to .tsx; the inline-path-data rule above still covers them, which
  // is the half that actually catches a glyph.
  const shellFiles = featureFiles().filter((f) => !f.startsWith('frontend/src/features/admin/'));
  assert.deepEqual(shellFiles.filter((f) => svgTags(read(f)).length > 0), [],
    'a raw <svg> in a feature file is a glyph that escaped the module');
});

test('every path the shell prerenders is one the module exports', () => {
  const shipped = new Set(HTML.match(/\sd="[^"]*"/g).map((s) => s.slice(4, -1)));
  const exported = modulePaths();
  const strays = [...shipped].filter((d) => !exported.has(d));
  assert.deepEqual(strays, [],
    `${strays.length} path(s) in public/index.html are not in icons.tsx. Either a glyph `
    + 'was re-inlined, or a transcription drifted by a character — which is a silent '
    + 'visual change, since the wrong path still draws something.');
  // Was 24 before THE UI OVERHAUL. Five glyphs stopped prerendering when the
  // surfaces that drew them were retired — see the expected-absent list in the
  // next test, which names each one — and two were added with the Improve
  // panel's rows.
  // 21 before the #1367 follow-up removed the notifications disclosure, which
  // was ChevronRightIcon's last prerendered call site (see the expected-absent
  // list in the next test, which records its full history).
  assert.ok(shipped.size >= 20,
    `only ${shipped.size} glyph paths in the prerendered document — the shell ships 20, `
    + 'so something stopped rendering');
});

test('the string-building callers draw the module’s paths, not their own', () => {
  // Three shell surfaces build their markup as HTML strings rather than JSX,
  // so they cannot render a component — `public/js/**` are classic scripts
  // that are never bundled, and home.js's card menu and dev-chat.js's draft
  // row are string builders inside the bundle. Seven glyph copies live there.
  //
  // Moving them is not available, so the property worth having is the weaker
  // one that still catches the bug: whatever they draw has to be a path the
  // module also exports. A copy that is CHECKED against the source of truth
  // cannot drift silently, which is the whole risk — the wrong path still
  // draws something, so nothing fails at runtime.
  //
  // This is what keeps a family migration honest. Re-point icons.tsx at a new
  // set and forget one of these seven, and the mismatch surfaces here instead
  // of as one stale glyph nobody looks at.
  const files = [];
  const walk = (dir, skip) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (skip && skip(rel)) continue;
      if (entry.isDirectory()) walk(rel, skip);
      else if (entry.name.endsWith('.js')) files.push(rel);
    }
  };
  walk('public/js');
  // The admin console is excluded on purpose, not overlooked. AGENTS.md's
  // density boundary forbids an admin source from importing the shell's
  // primitives, so its 29 nav glyphs cannot be checked against this module —
  // they are their own set at their own weight, and admin-ui-registry.test.js
  // is what holds them together.
  walk('frontend/src', (rel) => rel.startsWith('frontend/src/features/admin'));

  const exported = modulePaths();
  const strays = [];
  for (const file of files) {
    // A literal `d="M…"` / `d="m…"` in MARKUP. Two things are deliberately
    // not caught here. `d="${…}"` is a table lookup, not a path. And a
    // `d: '…'` inside a shape TABLE (app-card.js's VIS_CHIP_SHAPES,
    // app-view.js's DEV_CARD_ICONS) is a glyph this module does not export —
    // those two tables hold lucide glyphs of their own, on purpose.
    for (const m of read(file).matchAll(/\sd="([Mm][^"$]*)"/g)) {
      if (!exported.has(m[1])) strays.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(strays, [],
    `${strays.length} inline path(s) are not in icons.tsx:\n  ${strays.join('\n  ')}\n`
    + 'Either the module moved and this copy did not, or the copy drifted.');
});

test('the glyphs that do NOT prerender are the ones that render behind state', () => {
  // Not every export lands in the static document, and that is fine — but it
  // has to be a KNOWN list, or "my new icon is missing from index.html" reads
  // as normal instead of as the hydration bug it usually is.
  //
  // This is checked per GLYPH rather than per path. Under Heroicons a glyph
  // was almost always one path, so a list of path strings named its glyphs
  // legibly; a lucide glyph is two to six, and the same 30 absences spelled
  // out that way are 71 anonymous strings nobody can review.
  const shipped = new Set(HTML.match(/\sd="[^"]*"/g).map((s) => s.slice(4, -1)));
  const absent = [...moduleGlyphs()]
    .filter(([, paths]) => paths.every((d) => !shipped.has(d)))
    .map(([name]) => name)
    .sort();

  const expected = [
    // The Dev board frame is mounted by lib/interim-root.ts on the Dev route
    // rather than by <Shell/>, so its glyphs never reach the cold document.
    'Bars3Icon',
    // Messages: the drawer, its composer and its rows all render from thread
    // data.
    'PaperclipIcon', 'SendIcon', 'ArrowUpTrayIcon', 'UserGroupIcon',
    'BookmarkIcon', 'BookmarkSolidIcon',
    // The dev chat's banners and draft rows — all behind session state.
    'CheckIcon', 'ClockIcon', 'WarningTriangleIcon', 'SpinnerArcIcon',
    'SaveDraftIcon', 'DraftEditIcon', 'DraftTrashIcon', 'PencilSparklesIcon',
    // The home panels and widget strip populate from the app list.
    'InfoCircleIcon', 'TrophyIcon',
    // Session screens: the staging preview toggle and the title edit.
    'EyeIcon', 'EyeOffIcon', 'PencilSquareIcon',
    // LockIcon — the landing screen's waitlist badge, rendered only once the
    // waitlist form is open. WalletIcon — a NATIVE row, hidden until the
    // bridge reports the capability. GitHubIcon — the profile link.
    'LockIcon', 'WalletIcon', 'GitHubIcon',
    // ArrowPathIcon — the "a new version is here, reload onto it" glyph
    // (#1474). It draws on the Improve button and in that panel's footer
    // button, and BOTH are behind the ready state: a cold document is by
    // definition running the build it was served, so there is nothing to
    // reload onto.
    //
    // LightBulbIcon is the third state's glyph and is NOT on this list, which
    // is the whole shape of that state machine in one line: idle is what a
    // cold document is in, so the bulb is the one of the three that ships.
    // (SpinnerArcIcon is the second and IS absent — see the dev-chat group
    // above, which is where its other call sites live.)
    'ArrowPathIcon',
  ].sort();
  assert.deepEqual(absent, expected);
});

test('three glyphs draw no path at all, and that is deliberate', () => {
  // lucide draws primitives as primitives. Three glyphs are made entirely of
  // <rect>/<circle>/<line>, so the path-based checks above cannot see them —
  // worth naming, because "my glyph is not covered" should be a known set
  // rather than a silent gap.
  const pathless = [];
  for (const [name, body] of moduleBodies()) {
    if (!/\sd="[Mm]/.test(body) && !/'[Mm][^'\n]*'/.test(body)) pathless.push(name);
  }
  assert.deepEqual(pathless.sort(),
    ['EllipsisHorizontalIcon', 'EllipsisVerticalIcon', 'ShareIcon'],
    'a glyph with no path data is invisible to the prerender check above');
});

test('the two renderers keep lucide’s frame', () => {
  const glyph = ICONS.slice(ICONS.indexOf('function glyph('), ICONS.indexOf('function solid('));
  const solid = ICONS.slice(ICONS.indexOf('function solid('), ICONS.indexOf('// ── Navigation'));

  assert.match(glyph, /fill="none"/, 'an outline glyph must not fill');
  assert.match(glyph, /stroke="currentColor"/, 'a glyph inherits its colour');
  assert.match(glyph, /viewBox="0 0 24 24"/, 'lucide draws on the 24×24 grid');
  assert.match(glyph, /strokeWidth=\{strokeWidth\}/, 'strokeWidth rides on the <svg>');
  // Caps and joins sit on the <svg>, where lucide puts them, so a glyph can
  // hold <circle>/<rect>/<line> children without repeating them on each. 35
  // of the set's glyphs have such a child.
  assert.match(glyph, /strokeLinecap="round"\s*\n?\s*strokeLinejoin="round"/,
    'the rounded caps every lucide glyph is drawn with');
  assert.ok(!/<path[^>]*strokeLinecap/.test(glyph),
    'caps belong on the <svg> now — a primitive child cannot carry them');
  assert.equal(/const STROKE = '(\d(?:\.\d)?)'/.exec(ICONS)?.[1], '2',
    'lucide is drawn for stroke 2; changing the default restyles the shell');

  assert.match(solid, /fill="currentColor"/);
  assert.ok(!/stroke=/.test(solid), 'a solid glyph is filled, not stroked');

  // id and className are rendered before the spread at both renderers: React
  // serialises in prop order, and the prerendered document is compared to the
  // shell attribute by attribute.
  for (const [name, body] of [['glyph', glyph], ['solid', solid]]) {
    const tag = body.slice(body.indexOf('<svg'), body.indexOf('>', body.indexOf('<svg')));
    assert.ok(tag.indexOf('id={id}') < tag.indexOf('className={className}')
      && tag.indexOf('className={className}') < tag.indexOf('{...rest}'),
      `${name} must render id, then className, then the spread`);
  }
});
