// The shell's glyphs come from ONE module, and their path data never moves.
//
// #1120 slice 4 pulled 36 inline `<svg>` blocks out of frontend/src/features/**
// and into frontend/@/components/ui/icons.tsx. The conversion is worth almost
// nothing on its own — it is worth something only if the two things that make
// an icon swap dangerous stay pinned:
//
//   1. The path data is the shell's own. shadcn's examples import glyphs from
//      `lucide-react`, and lucide has a same-named counterpart for nearly
//      every icon below drawn on a different grid. Adding that package would
//      restyle thirty-odd buttons in one commit while every diff line still
//      read like a rename.
//   2. Nothing drifts back. One inline `<svg>` re-added beside the module is
//      how a set ends up with two spellings of the same glyph, which is the
//      state this slice found the tree in (five copies of the close X, four of
//      the back chevron).
//
// The strongest strand here is the third test: every `d` in the PRERENDERED
// document has to be a string this module exports. That is what makes "the
// path data is unchanged" checkable rather than asserted — the shipped
// markup is compared against the source of truth, not against a fixture of
// itself.
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

/** Every single-quoted string in the module that looks like SVG path data. */
function modulePaths() {
  return new Set(ICONS.match(/'M[^'\\\n]*'/g).map((s) => s.slice(1, -1)));
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

test('the set is the shell’s own — no lucide, no icon package at all', () => {
  const deps = { ...(PKG.dependencies || {}), ...(PKG.devDependencies || {}) };
  for (const name of Object.keys(deps)) {
    assert.ok(!/lucide|heroicons|react-icons|@tabler\/icons/.test(name),
      `frontend/package.json depends on ${name} — the shell draws its own glyphs, `
      + 'and a same-named icon from a package is not the same path');
  }
  // The header explains the decision, so only the CODE lines are checked.
  const code = ICONS.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(!code.some((l) => /lucide/.test(l)),
    'icons.tsx imports from lucide — see the header');
});

test('the glyphs live in the module, not inline beside it', () => {
  const offenders = [];
  for (const file of featureFiles()) {
    const src = read(file);
    // A literal `d="M…"` is the tell: an inline glyph with its own path data.
    // `d={…}` is not — the dev board's view switcher picks its path out of a
    // table at render time, and <Glyph> is the escape hatch it uses.
    if (/\sd="M/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'these files inline SVG path data — move the glyph into '
    + 'frontend/@/components/ui/icons.tsx and import it:\n  ' + offenders.join('\n  '));
  assert.deepEqual(featureFiles().filter((f) => svgTags(read(f)).length > 0), [],
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
  assert.ok(shipped.size >= 24,
    `only ${shipped.size} glyph paths in the prerendered document — the shell ships 24, `
    + 'so something stopped rendering');
});

test('the glyphs that do NOT prerender are the ones that render behind state', () => {
  // Not every export lands in the static document, and that is fine — but it
  // has to be a KNOWN list, or "my new icon is missing from index.html" reads
  // as normal instead of as the hydration bug it usually is.
  const shipped = new Set(HTML.match(/\sd="[^"]*"/g).map((s) => s.slice(4, -1)));
  const absent = [...modulePaths()].filter((d) => !shipped.has(d));
  const expected = [
    // LockIcon — the landing screen's waitlist badge, rendered only once the
    // waitlist form is open.
    'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
    // DiscussionIcon and ChevronRightIcon — the Dev board frame, which is
    // mounted by lib/interim-root.ts on the Dev route rather than by <Shell/>,
    // so it is not part of the prerender at all.
    'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z',
    'M9 5l7 7-7 7',
    // CheckIcon and ArrowRightShortIcon — the browse screen's Add button and
    // its detail page's Open pill (#1191 slice 6). Both render from row/detail
    // descriptors that are null until the first fetch lands, so the prerendered
    // #browse-list and #browse-detail are empty by contract, not by accident.
    'M5 13l4 4L19 7',
    'M13 7l5 5m0 0l-5 5m5-5H6',
  ];
  assert.deepEqual(absent.sort(), expected.sort());
});

test('the three renderers keep the frame attributes each site shipped', () => {
  // fill / stroke / viewBox were identical at all 36 sites, which is why they
  // moved into the factories. The one real difference was where strokeWidth
  // sat — and it is a DOM difference, so a like-for-like conversion keeps it.
  const stroked = ICONS.slice(ICONS.indexOf('function stroked('), ICONS.indexOf('function strokedPath('));
  const strokedPath = ICONS.slice(ICONS.indexOf('function strokedPath('), ICONS.indexOf('function filled('));
  const filled = ICONS.slice(ICONS.indexOf('function filled('), ICONS.indexOf('// ── Navigation'));

  for (const [name, body] of [['stroked', stroked], ['strokedPath', strokedPath]]) {
    assert.match(body, /fill="none"/, `${name} must not fill`);
    assert.match(body, /stroke="currentColor"/, `${name} must inherit its colour`);
    assert.match(body, /viewBox="0 0 24 24"/, `${name} draws on the 24×24 grid`);
    assert.match(body, /strokeLinecap="round"\s*\n?\s*strokeLinejoin="round"/,
      `${name} keeps the rounded caps every site had`);
  }
  assert.match(stroked, /<svg[\s\S]*?strokeWidth=\{strokeWidth\}[\s\S]*?>/,
    'the stroked family carries strokeWidth on the <svg>');
  assert.ok(!/<path[^>]*strokeWidth/.test(stroked),
    'moving strokeWidth onto the path would change the DOM at 29 call sites');
  assert.match(strokedPath, /<path[\s\S]*?strokeWidth="2"/,
    'the strokedPath family carries strokeWidth on the <path> — five sites shipped it there');
  assert.match(filled, /fill="currentColor"/);
  assert.ok(!/stroke=/.test(filled), 'the GitHub mark is solid, not stroked');

  // id and className are rendered before the spread at every renderer: React
  // serialises in prop order, and the prerendered document is compared to the
  // hand-written shell attribute by attribute.
  for (const [name, body] of [['stroked', stroked], ['strokedPath', strokedPath], ['filled', filled]]) {
    const tag = body.slice(body.indexOf('<svg'), body.indexOf('>', body.indexOf('<svg')));
    assert.ok(tag.indexOf('id={id}') < tag.indexOf('className={className}')
      && tag.indexOf('className={className}') < tag.indexOf('{...rest}'),
      `${name} must render id, then className, then the spread`);
  }
});
