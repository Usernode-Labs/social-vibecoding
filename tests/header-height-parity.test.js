// Header height parity (#909) — the shell's top bar is the same height on
// every screen.
//
// The two authored top bars — #platform-header (signed-in shell: home, app
// view, leaderboard, profile, settings, admin console) and #landing-header
// (anonymous shell) — are `py-3` + a 1px hairline around a 28px CONTENT ROW,
// i.e. 53px + env(safe-area-inset-top), everywhere.
//
// Neither header declares a height: they're flex rows, so the row is
// max(child heights) and the height silently followed whichever children
// happened to be present on that screen:
//
//   home                 53px  (#header-title's text-lg = 28px line box)
//   inside an app        55px  (#app-mode-switch was 30px: py-1 segments
//                               = 24px + p-0.5 = 4px + 1px border × 2)
//   landing, >= 640px    61px  (CTAs were sm:py-2 sm:text-sm = 36px)
//   home, native WebView 45px  (html.in-native-webview hides the title, and
//                               the 20px icon buttons were all that was left)
//
// So the row is pinned from BOTH directions and this file is what keeps it
// pinned — a "tidy up the header" edit that re-adds vertical padding to a
// header child, or drops a taller control in, fails here instead of shipping
// a bar that jumps as you navigate:
//
//   FLOOR   — the lead back-button wrapper (present in every state of both
//             headers) carries h-7, so the row survives the title being
//             display:none. It stays w-5: the header-layout hook
//             (frontend/src/features/header/use-header-layout.ts) measures it
//             as the title's left side group.
//   CEILING — no child of either header exceeds 28px.
//
// Prose version of the same contract lives in the "Header height invariant"
// block in public/css/app.css.
//
// Static-assertion style (cf. tests/header-status-pane.test.js): read the
// shipped source files and assert the contract is present. There is no
// layout engine here — the measured-height half is a manual check, see the
// spec's verification steps.
//
// Run with: node --test tests/header-height-parity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

// The markup of one <header> element, opening tag through </header>.
function headerSlice(id) {
  const start = html.indexOf(`<header id="${id}"`);
  assert.notEqual(start, -1, `#${id} exists in the shell`);
  const end = html.indexOf('</header>', start);
  assert.notEqual(end, -1, `#${id} is closed`);
  return html.slice(start, end + '</header>'.length);
}

// The opening tag only — used for the shape classes on the header itself.
function openingTag(slice) {
  return slice.slice(0, slice.indexOf('>') + 1);
}

// Markup with <!-- … --> stripped, for scans that would otherwise match a
// class name mentioned in prose (these headers are heavily commented, and
// the comments name the very classes this file bans).
function withoutComments(slice) {
  return slice.replace(/<!--[\s\S]*?-->/g, '');
}

const BARS = [
  { id: 'platform-header', slice: headerSlice('platform-header') },
  { id: 'landing-header', slice: headerSlice('landing-header') },
];

test('both top bars carry the identical shape: py-3, 1px hairline, safe-area', () => {
  for (const bar of BARS) {
    const tag = openingTag(bar.slice);
    // 12px top+bottom padding around the content row.
    assert.match(tag, /\bpy-3\b/,
      `#${bar.id} keeps py-3 — the 12px half of the 53px total`);
    // The hairline is part of the height (border-box), so it's part of parity.
    assert.match(tag, /\bborder-b\b/,
      `#${bar.id} keeps its 1px bottom hairline`);
    // Adds env(safe-area-inset-top) to padding-top (native.css). Both bars
    // must opt in, or the phone status bar overlaps one shell and not the
    // other.
    assert.match(tag, /\bun-safe-top-extend\b/,
      `#${bar.id} keeps the safe-area opt-in`);
    // The row is max(child heights); a py-* on the header itself would be
    // additive, and a hardcoded h-* would fight the safe-area inset.
    assert.doesNotMatch(tag, /\bh-\d/,
      `#${bar.id} does not hardcode its own height — padding + the 28px row is the contract`);
  }
});

test('FLOOR: the lead back-button wrapper is 28px tall (and still 20px wide)', () => {
  for (const bar of BARS) {
    // First element inside the header: the fixed-size wrapper holding the
    // back button. `h-7` is what holds the row open when #header-title is
    // hidden (native WebView); `flex items-center` centres the 20px icon
    // inside those 28px.
    const wrapper = withoutComments(bar.slice).match(/<div class="([^"]*\bw-5\b[^"]*)"/);
    assert.ok(wrapper, `#${bar.id} still has its w-5 back-button wrapper`);
    const classes = wrapper[1].split(/\s+/);
    assert.ok(classes.includes('h-7'),
      `#${bar.id}'s back-btn wrapper carries h-7 — the header's 28px content-row floor`);
    assert.ok(classes.includes('flex') && classes.includes('items-center'),
      `#${bar.id}'s back-btn wrapper centres its icon in those 28px`);
    // features/header/use-header-layout.ts measures this element as the
    // title's left side group (leftGroup.offsetWidth) — the WIDTH must stay
    // fixed at 20px or the centering measurement drifts.
    assert.ok(classes.includes('w-5') && classes.includes('shrink-0'),
      `#${bar.id}'s back-btn wrapper stays w-5 shrink-0 (the header-layout hook measures it)`);
  }
});

test('CEILING: the App/Dev switch is exactly the 28px row, segments stretch to fill', () => {
  const tag = html.match(/<div id="app-mode-switch"[\s\S]*?>/)[0];
  // Was 30px (24px segments + 4px p-0.5 + 2px border) — the whole of #909.
  assert.match(tag, /\bh-7\b/,
    'the App/Dev switch is pinned to the header\'s 28px content row');
  assert.match(tag, /\bitems-stretch\b/,
    'segments stretch to the track height instead of being sized by their own padding');
  assert.doesNotMatch(tag, /\bitems-center\b/,
    'items-center would let the segments size the control again');
  // The switch is the only child that appears when an app opens, so its
  // height IS the in-app header height. Vertical padding on the segments
  // is exactly what made the bar 2px taller than every other screen.
  const segs = html.match(/class="app-mode-seg[^"]*"/g) || [];
  assert.equal(segs.length, 2, 'two App/Dev segments');
  for (const seg of segs) {
    assert.doesNotMatch(seg, /\b(?:sm:)?py-\d/,
      'App/Dev segments carry no vertical padding — the h-7 track owns the height');
    assert.doesNotMatch(seg, /\b(?:sm:)?h-\d/,
      'App/Dev segments take their height from the stretched track, not their own h-*');
    // They still have to be tappable across the full track and keep their
    // labels centred, which is what flex items-center buys.
    assert.match(seg, /\bflex\b/, 'App/Dev segment is a flex box');
    assert.match(seg, /\bitems-center\b/, 'App/Dev segment centres its label vertically');
  }
});

test('CEILING: the landing CTAs stay 28px at every width', () => {
  const landing = BARS.find((b) => b.id === 'landing-header').slice;
  const ctaBlock = landing.slice(landing.indexOf('id="landing-header-ctas"'));
  const anchors = ctaBlock.match(/<a [^>]*>/g) || [];
  // Sign in, Join waitlist, and the "Your queue status" variant.
  assert.equal(anchors.length, 3, 'three landing CTAs (incl. the waiting-room variant)');
  for (const a of anchors) {
    // Pinned, not padding-sized. Padding-sizing broke this bar twice: the
    // `sm:py-2 sm:text-sm` bump made them 36px (a 61px bar on desktop), and
    // even at py-1.5 the BORDERED "Join waitlist" was 30px to its
    // borderless siblings' 28px — the 1px border is part of the box.
    assert.match(a, /\bh-7\b/, 'landing CTA is pinned to the 28px content row');
    assert.match(a, /\binline-flex\b/, 'landing CTA is a flex box so its label can centre');
    assert.match(a, /\bitems-center\b/, 'landing CTA centres its label in those 28px');
    assert.doesNotMatch(a, /\b(?:sm:)?py-\d/,
      'no vertical padding on a landing CTA — the h-7 box owns the height');
    assert.doesNotMatch(a, /\bsm:text-(?:sm|base|lg|xl)\b/,
      'no responsive font-size bump on a landing CTA — a taller line box grows the bar');
    assert.match(a, /\btext-xs\b/, 'landing CTA keeps its 16px line box');
    // Desktop presence is bought horizontally, which costs no height.
    assert.match(a, /\bsm:px-5\b/, 'landing CTA still widens on desktop');
  }
});

test('CEILING: nothing in either bar is taller than the 28px row', () => {
  // A cheap guard against the next tall thing dropped into a header: the
  // only heights that belong in there are h-5 (20px icons), h-7 (the row
  // itself) and the badges' h-[1.1rem] pills.
  for (const bar of BARS) {
    // py-3 lives on the header's own opening tag, not on a child.
    const children = withoutComments(bar.slice.slice(openingTag(bar.slice).length));
    for (const cls of ['h-8', 'h-9', 'h-10', 'h-12', 'py-2', 'py-3', 'py-4']) {
      assert.ok(
        !new RegExp(`\\b(?:sm:|md:|lg:)?${cls}\\b`).test(children),
        `#${bar.id} has no ${cls} child — the content row is 28px`,
      );
    }
    for (const cls of ['text-xl', 'text-2xl', 'text-3xl']) {
      assert.ok(
        !new RegExp(`\\b(?:sm:|md:|lg:)?${cls}\\b`).test(children),
        `#${bar.id} has no ${cls} — a bigger line box would grow the row past 28px`,
      );
    }
  }
});

test('badges still overflow the row rather than being clipped', () => {
  // The notification / dev-console / deploy-dot badges hang outside the
  // 28px row on purpose (-top-1 -right-1). Clipping the header to enforce
  // the height would decapitate them, so the invariant is enforced on the
  // children instead — assert nobody "fixed" it with overflow.
  for (const bar of BARS) {
    assert.doesNotMatch(openingTag(bar.slice), /\boverflow-hidden\b/,
      `#${bar.id} is not clipped — the absolutely-positioned badges overflow it by design`);
  }
  const platform = BARS.find((b) => b.id === 'platform-header').slice;
  assert.match(platform, /id="notifications-badge"[^>]*-top-1/,
    'the bell badge still hangs off the top-right corner');
  assert.match(platform, /id="notifications-badge-ai"[^>]*-top-1/,
    'the work-cog badge is positioned identically to the bell badge');
});

test('the invariant is documented where the next editor will look', () => {
  assert.match(css, /Header height invariant/,
    'public/css/app.css carries the "Header height invariant" block');
  const block = css.slice(css.indexOf('Header height invariant'));
  const head = block.slice(0, block.indexOf('── Header title centering'));
  assert.match(head, /#platform-header/, 'the block names both bars');
  assert.match(head, /#landing-header/, 'the block names both bars');
  assert.match(head, /28px/, 'the block states the content-row height');
  assert.match(head, /header-layout/,
    'the block warns that the w-5 width is measured by the header-layout code');
  // The stale "Kept at 28px tall" claim on #app-mode-switch was wrong for as
  // long as it existed (it omitted the border) — the shell comment must now
  // describe the pinned height instead of asserting an arithmetic result.
  const switchComment = html.slice(
    html.lastIndexOf('<!--', html.indexOf('<div id="app-mode-switch"')),
    html.indexOf('<div id="app-mode-switch"'),
  );
  assert.match(switchComment, /h-7/,
    'the App/Dev switch comment points at the class that pins its height');
});

test('no JS sets a header height — the contract lives entirely in markup + CSS', () => {
  // The header-layout hook measures WIDTHS to decide the title's centering mode;
  // it must never start writing heights (that would put the invariant in
  // two places, one of them racing first paint).
  // #1079 chunk B ported header-layout.js into the header island as a hook.
  const layoutJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/use-header-layout.ts'), 'utf8');
  assert.doesNotMatch(layoutJs, /style\.(?:height|minHeight|paddingTop|paddingBottom)/,
    'the header-layout hook never writes header box metrics');
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  assert.doesNotMatch(appJs, /getElementById\('platform-header'\)\.style/,
    'app.js never writes #platform-header inline styles');
});
