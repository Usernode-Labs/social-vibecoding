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
    // DiscussionIcon — the Dev board frame, which is mounted by
    // lib/interim-root.ts on the Dev route rather than by <Shell/>, so it is
    // not part of the prerender at all.
    //
    // ChevronRightIcon has moved on and off this list twice, which is worth
    // recording rather than re-deciding. It prerendered while the Improve
    // panel drew it on its two navigating rows; #1367 turned those rows into
    // the App/Feed/Kanban toggle and briefly kept it as the notifications
    // disclosure caret; the follow-up removed that disclosure. Every call site
    // left is behind route state — the Dev board frame's General-chat card and
    // its group rows, none of which are in <Shell/>.
    'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z',
    'M9 5l7 7-7 7',
    // CheckIcon and ArrowRightShortIcon — the browse screen's Add button and
    // its detail page's Open pill (#1191 slice 6). Both render from row/detail
    // descriptors that are null until the first fetch lands, so the prerendered
    // #browse-list and #browse-detail are empty by contract, not by accident.
    'M5 13l4 4L19 7',
    'M13 7l5 5m0 0l-5 5m5-5H6',
    // The thread header and composer render only after a conversation is
    // selected. The static Messages screen therefore ships only its new-
    // conversation plus glyph; these five remain behind route state.
    'M15 18l-6-6 6-6',
    'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm8-1a3 3 0 010 6m4 5v-2a4 4 0 00-3-3.9',
    'M21.4 11.6l-8.5 8.5a6 6 0 01-8.5-8.5l9-9a4 4 0 015.7 5.7l-9 9a2 2 0 01-2.8-2.8l8.4-8.4',
    'M12 3v12m0-12l-4 4m4-4l4 4M5 13v7h14v-7',
    'M4 4l17 8-17 8 3-8-3-8zm3 8h14',
    // ── Retired by THE UI OVERHAUL, with their surfaces ─────────────
    // GitHubIcon and ShareIcon left the hamburger drawer's footer for the
    // Improve panel — which IS in <Shell/>, so they would still be here…
    // except that both rows are conditional on the panel having a target (a
    // repo to link to, a running app to share), and the prerendered panel has
    // none. They render the moment one is published.
    'M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z',
    'M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z',
    // BellIcon — the bell BUTTON itself, retired when the notifications list
    // merged into the hamburger. The badges it carried moved to that button.
    'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    // SunIcon — the theme control's row icon. Theme is a Settings section now,
    // and its pane renders the segmented track without a row glyph.
    'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
    // ThumbsUpIcon — the retired kudos meter row in the drawer's status pane.
    'M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5',
    // TrophyIcon — the retired Leaderboard drawer row. The route lives on, and
    // the home screen's Challenges area is what links to it now.
    'M16 11V3H8v8M5 7H3v4a2 2 0 002 2h3M19 7h2v4a2 2 0 01-2 2h-3M8 15a4 4 0 008 0h-8z M12 15v3m-3 3h6',
    // BookmarkIcon — the outline half of the save toggle (#1280). It has no
    // React call site at all: the button it draws belongs to the message,
    // which public/js/group-chat.js renders as an HTML string, so this
    // export exists to BE the source of truth for that duplicate (see the
    // note beside it in icons.tsx) rather than to be rendered here.
    'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z',
    // BookmarkSolidIcon — the drawer's saved rows, which are empty until the
    // first /api/notifications payload lands, so the pinned section is
    // prerendered as nothing by contract (see notifications-store.js).
    'M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z',
    // ── #1367: the App/Feed/Kanban toggle's glyphs ──────────────────
    // BoardIcon used to prerender, because the Improve panel drew it
    // unconditionally on its "Development kanban" row. That row is a segment
    // of the toggle now, and the whole control returns null without a
    // published target — which the prerendered document has none of, by the
    // same contract that keeps GitHubIcon and ShareIcon off it above.
    //
    // ListLinesIcon is NOT here: the Dev board frame's own Feed tab renders
    // it from <Shell/>, so it still lands in the static document.
    'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
    // AppWindowIcon — both subpaths of the toggle's "App" segment, which is
    // the most conditional glyph in the shell: it needs a target AND a target
    // that is not the platform's own self-hosted row (which has no reachable
    // App tab). New with the toggle, so it has never prerendered.
    'M4 6a1 1 0 011-1h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V6z',
    'M4 9.5h16',
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
