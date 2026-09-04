// Header height parity (#909) — the shell's top bar is the same height on
// every screen.
//
// The two authored top bars — #platform-header (signed-in shell: home, app
// view, leaderboard, profile, settings, admin console) and #landing-header
// (anonymous shell) — are `py-3` around a 28px CONTENT ROW, i.e.
// 52px + env(safe-area-inset-top), everywhere.
//
// It was 53px until the reskin, when both bars lost the 1px `border-b`
// hairline they had carried: the widget language draws no rule under a top
// bar — the page ground runs to the top of the screen and the controls float
// on it. What this file pins is PARITY and the 28px row, not the constant, so
// the hairline assertion below inverted rather than disappeared: it now
// asserts NEITHER bar has one, which is what catches a rule re-added to one
// shell and not the other.
//
// Neither header declares a height: they're flex rows, so the row is
// max(child heights) and the height silently followed whichever children
// happened to be present on that screen:
//
//   home                 53px  (#header-title's text-lg = 28px line box, +
//                               the hairline both bars carried back then)
//   inside an app        55px  (#app-mode-switch was 30px: py-1 segments
//                               = 24px + p-0.5 = 4px + 1px border × 2)
//   landing, >= 640px    61px  (CTAs were sm:py-2 sm:text-sm = 36px)
//   home, native WebView 45px  (html.in-native-webview USED to hide the
//                               title, leaving only 20px icon buttons; the
//                               title is drawn there now, and the 28px
//                               content-row floor is what holds the height)
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
const { shellMarkup } = require('./lib/shell-markup');

const root = path.join(__dirname, '..');
const html = shellMarkup();
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

test('both top bars carry the identical shape: py-3, no hairline, safe-area', () => {
  for (const bar of BARS) {
    const tag = openingTag(bar.slice);
    // 12px top+bottom padding around the content row.
    assert.match(tag, /\bpy-3\b/,
      `#${bar.id} keeps py-3 — the 12px half of the 52px total`);
    // A bottom border is part of the height (border-box), so it is part of
    // parity — which is why this is asserted at all rather than left alone.
    // The reskin removed the hairline from BOTH bars; re-adding it to one
    // makes that shell a pixel taller than the other, and the bar visibly
    // jumps as you sign in.
    assert.doesNotMatch(tag, /\bborder-b\b/,
      `#${bar.id} draws no rule under it — the page ground runs to the top`);
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

test('FLOOR: each bar holds its 28px content row open', () => {
  for (const bar of BARS) {
    // `h-7` on the bar's LEAD GROUP is what holds the row open when
    // #header-title is hidden (native WebView), and `flex items-center`
    // centres whatever is in it inside those 28px. That is the floor, and it
    // is the whole of what parity requires.
    //
    // WIDTH IS NO LONGER PART OF IT, and only on the platform bar. The fixed
    // `w-7` box existed to (a) keep a CENTRED title from shifting as the back
    // anchor came and went and (b) hold either the arrow or the app glyph,
    // which never drew together. #1443 retired the app glyph and made the
    // chip the header's flush-left label, so the box had one occupant and no
    // centring to protect — all it did was reserve an inch of dead space at
    // the top-left of every root screen.
    //
    // The landing bar still has its w-7 box: its title IS centred and its
    // back button still comes and goes, so the reason survives there. Two
    // bars, one floor, and the width rule kept exactly where it still buys
    // something.
    const lead = withoutComments(bar.slice).match(/<div[^>]*class="([^"]*\bh-7\b[^"]*)"/);
    assert.ok(lead, `#${bar.id} still has a lead group carrying the 28px floor`);
    const classes = lead[1].split(/\s+/);
    assert.ok(classes.includes('flex') && classes.includes('items-center'),
      `#${bar.id}'s lead group centres its content in those 28px`);
    assert.ok(classes.includes('shrink-0'),
      `#${bar.id}'s lead group never compresses below the floor`);
    if (bar.id === 'landing-header') {
      assert.ok(classes.includes('w-7'),
        '#landing-header keeps its fixed 28px box — its title is centred');
    }
  }
});

test('CEILING: the Improve button is exactly the 28px row', () => {
  // THE UI OVERHAUL replaced #app-mode-switch with #improve-btn, and the
  // invariant transferred WITH it: this is the one child that appears in the
  // bar when an app opens, so its height IS the in-app header height. The
  // switch it replaced was 30px for a while (24px segments + 4px p-0.5 + 2px
  // border), which quietly made the in-app header 2px taller than every other
  // screen's — the whole of #909. Pinning the replacement to h-7 is what stops
  // that recurring with a differently-shaped control.
  const tag = html.match(/<button id="improve-btn"[\s\S]*?>/)[0];
  assert.match(tag, /\bh-7\b/,
    "the Improve button is pinned to the header's 28px content row");
  assert.doesNotMatch(tag, /\b(?:sm:)?py-\d/,
    'the Improve button carries no vertical padding — h-7 owns the height');
  // It has a text label as well as a glyph, so it must centre its content
  // vertically rather than letting the two children set their own baseline.
  assert.match(tag, /\bitems-center\b/,
    'the Improve button centres its glyph and label vertically');
  assert.match(tag, /\binline-flex\b/, 'the Improve button is a flex box');
  // …and SPACES them. There was no gap at all, so the glyph and the "I" of
  // Improve met — one smudged mark rather than a state cue in front of a
  // label, worst on the spinner (whose arc carries no bounding whitespace)
  // and on the arrow-path (whose head reaches the glyph box's edge). A gap
  // is a horizontal cost only, so the 28px ceiling above is untouched.
  assert.match(tag, /\bgap-1\.5\b/,
    'the glyph and the label are spaced like the header group they sit in');
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
  assert.match(platform, /id="improve-working-dot"[^>]*-top-1/,
    'and the Improve button\'s working dot hangs off the same corner (#1610 '
    + 'retired the green count that used to sit there)');
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
  // The stale "Kept at 28px tall" claim on the retired #app-mode-switch was
  // wrong for as long as it existed (it omitted the border), so the rule is
  // that the source comment names the CLASS that pins the height rather than
  // asserting an arithmetic result. #improve-btn inherited both the slot and
  // the rule — see features/improve/improve-button.tsx.
  const buttonSrc = fs.readFileSync(
    path.join(root, 'frontend/src/features/improve/improve-button.tsx'), 'utf8');
  assert.match(buttonSrc, /h-7` matches the header's 28px content-row ceiling|h-7`? matches the header/,
    'the Improve button comment points at the class that pins its height');
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

// ── The native WebView shows the in-page title ────────────────────────
//
// It was hidden under `html.in-native-webview` because the Flutter shell puts
// the screen name in its own AppBar — a real arrangement, not a guess:
// App.setHeaderTitle posts `titleChanged` to it. On a device that read as a
// screen with no title at all, so the in-page one is drawn there too.
//
// Pinned because the obvious "tidy up" is to restore the hide: the CSS rule
// reads like dead weight next to the AppBar message, and the two halves live
// in different files.

test('no rule hides the header title in the native WebView', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /in-native-webview[^{]*#header-title[^{]*\{[^}]*display:\s*none/,
    'the native WebView must not hide #header-title');
  // The class itself stays — it still gates the safe-area and native
  // performance rules, so this is not "delete the detection".
  assert.match(rules, /html\.un-ios\.in-native-webview/,
    'the native marker class is still load-bearing elsewhere');
});

test('the title is left-aligned on a phone by an explicit rule, not by a native branch', () => {
  // The request was "left justified, leaving space for the home icon, since
  // there wouldn't be room to centre".
  //
  // This test used to assert that the EXISTING measurement already produced
  // that, on the reasoning that a 390px viewport carrying #improve-btn and
  // the hamburger could never satisfy
  //   titleNaturalW <= headerW - 2 * (max(sideGroup) + gap)
  // for a real title. That was wrong twice over, and the preview showed it:
  // "Settings" DID satisfy it, and the formula was over-reporting the room by
  // the header's own `px-4` on each side, so the centred title overlapped the
  // Improve button. Both halves are fixed in use-header-layout.ts and pinned
  // in tests/header-title-centering.test.js, which drives the arithmetic
  // directly on the measurements that failed.
  //
  // What belongs HERE is the part that is about this file's subject — that
  // alignment stays ONE rule for every surface, with no native-webview branch
  // to drift out of sync with the browser one.
  const hook = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src',
    'features', 'header', 'use-header-layout.ts'), 'utf8');
  assert.match(hook, /const CENTER_MIN_WIDTH_PX = 640;/,
    'a phone is left-aligned by a stated breakpoint, not by hoping the maths says so');
  assert.match(hook, /const canCenter = canCenterTitle\(\{/,
    'and the decision goes through the one exported, tested function');
  assert.doesNotMatch(hook, /in-native-webview|isNative/,
    'alignment is one geometric rule for every surface');
});
