// test:changed: always (every feature file, for hand-written buttons and fields; scripts/test-changed.js)
// The shadcn primitives are the only way to spell the shell's primary button
// and its field box.
//
// ── Why a static-analysis test and not a rendered-output one ───────────
//
// Nothing in the existing suite notices a NEW hand-written
// `bg-violet-600 hover:bg-violet-500 …` button. The structural baseline
// (tests/baselines/shell-markup.json) records ids, data-* names, script order
// and stylesheet order — deliberately no class strings, because pinning those
// would freeze the stylesheet. tests/dapp-selectors-resolve.test.js only
// checks that the selectors dapp.json names still resolve. So a screen
// converted next month could reintroduce the literal string and every gate
// would stay green while the primitives quietly stopped being the source of
// truth.
//
// That is what this file prevents, and it is why it is spelled as a
// prohibition on the LITERAL rather than a requirement to use the component:
// the failure mode is drift back to hand-written strings, one call site at a
// time, each individually defensible.
//
// ── What is allowed through, and why ───────────────────────────────────
//
// Two kinds of exception are legitimate and both are enumerated below rather
// than pattern-matched:
//
//   * elements that are not buttons. The landing page's call to action and
//     the waiting screen's are `<a href>`, and an anchor is not something the
//     Button primitive renders. They keep their literal strings.
//   * `frontend/src/features/dev-board/board-frame.tsx`, whose two violet
//     surfaces are a 7x7 icon button and a segmented-control fill assembled
//     by a helper. Neither is the shell's primary button and neither has a
//     variant transcribed for it; widening the table to cover them is a
//     separate slice with its own evidence.
//
// Adding to ALLOWED_BUTTON_FILES is a decision, not a fix. If a new call site
// fails this test, the answer is almost always to route it through <Button>,
// and if the primitive cannot spell it, to widen the cva table — in the order
// the shell's own strings are written, so the rendered class attribute does
// not move.
//
// Run with: node --test tests/shell-primitive-adoption.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FEATURES = path.join(__dirname, '..', 'frontend', 'src', 'features');
const UI = path.join(__dirname, '..', 'frontend', '@', 'components', 'ui');

/** The primary button's fill. Present in a `<button>` tag = not converted. */
const PRIMARY_FILL = 'bg-violet-600';

/**
 * The field box's fill + border run, in each spelling the shell ships: the
 * `zinc-800` one (settings and dialogs), the `zinc-900` one (sign-in and
 * register) and the WHITE one (the two waitlist surveys). Present in an
 * `<input>` or `<textarea>` tag = not converted.
 *
 * The white run was missing until #2437, and its absence is exactly the blind
 * spot this file's header warns about: sixteen hand-written fields across
 * features/auth/waitlist.tsx and features/auth/more.tsx sat outside the scan
 * for as long as the primitive has existed, and every gate stayed green. A
 * fill this rule does not name is a fill the rule does not protect, so a new
 * box value in input.tsx belongs here the same day.
 *
 * ── The gap that is still open, named rather than quietly left ─────────
 *
 * `<select>` is NOT scanned. It has the same three fills and the same
 * primitive (@/components/ui/select.tsx), and adding it here flags four raw
 * selects that predate this rule — #dc-runner-select, the share dialog's two,
 * and #settings-dev-flow — in three files none of which #2437 is about.
 * Converting them is a slice of its own; widening the scan without converting
 * them would mean three allow-list entries, which is the one thing this file's
 * header says an allow-list is not for. The three selects on the waitlist
 * screens DO route through <Select>, and tests/waitlist-field-primitives.test.js
 * pins that per id.
 */
const FIELD_BOXES = [
  'bg-zinc-100 dark:bg-zinc-800 border border-zinc-300',
  'bg-zinc-100 dark:bg-zinc-900 border border-zinc-300',
  'bg-white dark:bg-zinc-900 border border-zinc-300',
];

/** See the header. Every entry is a considered exception. */
const ALLOWED_BUTTON_FILES = new Set([
  // `dev-board/actions-row.tsx` WAS HERE, for #dev-plus-btn's violet fill.
  // The "+" closes the Workshop's view-tab strip now and is drawn on the
  // strip's own metrics and ink (app.css `.dev-ws-plus-btn`) — a bare glyph,
  // not a primary button — so the file has no fill left to excuse and the
  // entry went with it rather than staying as a standing exemption.
  // The Kudos pane's two segmented toggles — the All-time / This week window
  // pills and the Kudos / Votes history chips — whose ACTIVE state is the
  // violet fill. Same shape as board-frame's view toggle, and the same
  // decision: a segment's fill is not a primary button's fill.
  //
  // The primitive also cannot spell these. Both strings are written padding
  // first and box second (`px-3 py-1 text-xs font-medium rounded-full …`),
  // which is the reverse of the cva group order Button emits, so routing them
  // through it would mean reordering the groups and moving the rendered class
  // attribute of every other button in the shell. See the header of
  // frontend/src/features/leaderboard/kudos-pane.tsx.
  'leaderboard/kudos-pane.tsx',
  // The social-account Connect control, which exists in TWO spellings that
  // must render identically: a live `<a href>` (the OAuth flow is a top-level
  // navigation, not a fetch) and a disabled `<button>` for the ?demo= fixture,
  // which must not navigate out of itself.
  //
  // This install of Button is hand-rolled and has no `asChild`, so it cannot
  // be an anchor. Routing only the button through it would leave the pair
  // written two different ways and free to drift — so both are written from
  // one `CONNECT_SURFACE` constant in the file, which is the same guarantee
  // the primitive would have given.
  'settings/social-identity.tsx',
  // The group chat composer's Send button was here, as one half of a PAIR
  // whose other half was still an HTML string in public/js/app-view.js. Both
  // halves are features/group-chat/composer.tsx now — ONE component with a
  // `scope` — so the exception has nothing left to protect and the button
  // routes through <Button>: `size` spells both paddings and the trailing
  // `shrink-0` arrives through className, which cva emits last.
  //
  // The dev session strip's doing<->seeing switch. Its ACTIVE segment is the
  // accent fill, which is the same decision already taken twice above for
  // board-frame's view toggle and the Kudos pane's window pills: a segment's
  // fill is not a primary button's fill. The two segments also swap SHAPE as
  // well as colour — the current one grows a label and the other collapses to
  // a 24px glyph — which is a cva table of its own, for one control.
  'dev-chat/session-header.tsx',
  // #improve-btn, the header's standing action, IS RETIRED (#2718) and its
  // entry is gone with the file. It was here for two reasons the primitive
  // could not meet, and both are worth keeping in view because the next
  // header control will hit them again: its height was pinned to the header's
  // 28px content row with NO vertical padding — the invariant #909 exists to
  // protect and tests/header-height-parity.test.js re-asserts — while every
  // Button size spells its height through `py-*`; and it shipped in the SSG
  // prerender, so its class attribute had to stay byte-identical across a
  // hydration it shared with two absolutely-positioned indicators.
  //
  // Nothing replaces it in this list. What it became is a row of the app's own
  // menu (#app-menu-row-improve), which is a menu row like the four beside it
  // and wears that menu's ROW constant — no fill, no pill, nothing a primitive
  // would want to own.
]);

/**
 * The caution box's slot, from alertVariants' `notice` variant (#2443).
 *
 * ── Why this is three co-occurring utilities and not a colour scan ─────
 *
 * Amber is used for plenty of things that are NOT a notice box and must not
 * be dragged into the primitive: the settings health dot
 * (`w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500`), an icon tint, a heading
 * ink, a `hover:` state. A file-wide "no amber outside the primitive" rule
 * would flag every one of them, and the allow-list needed to quiet it would be
 * long enough that nobody would read it.
 *
 * So the anchor is the SHAPE of the slot rather than the hue: a class string
 * is a notice box when it has all three of
 *
 *   * a BARE amber background — unprefixed, so `hover:bg-amber-500/10` on the
 *     auth screens' "Try again" button and a lone `dark:bg-amber-950/40` are
 *     not it;
 *   * a `rounded-*` — which is what separates a panel from a full-bleed strip.
 *     The two dev-chat banners and `#view-as-non-admin-banner` are `border-b`
 *     with square corners: they are banners, and `banner` is the variant for
 *     those;
 *   * a padding utility — a tinted dot or a swatch has none.
 *
 * A dot, an ink, an icon and a hover each fail at least one. All eight boxes
 * the audit found pass all three.
 */
const NOTICE_FILL = /(^|\s)bg-amber-\d+(\/\d+)?(\s|$)/;
const NOTICE_ROUNDED = /(^|\s)rounded(-[a-z0-9]+)?(\s|$)/;
const NOTICE_PADDING = /(^|\s)(p|px|py)-[\d.]+(\s|$)/;

/** See the header: an entry here is a decision, not a fix. */
const ALLOWED_NOTICE_FILES = new Set([
  // One of THREE borderless tint chips in StakingCard — amber, sky, violet —
  // spelled identically but for the hue. `notice` carries a border and is
  // amber-only, so the other two cannot follow the amber one through it, and
  // moving one chip of three is how a matched set stops matching. The note at
  // the call site carries the same reasoning.
  'header/wallet-sheet-body.tsx',
  // NOTICE_TONE, which is already one spelling in three tones (warn / ok /
  // plain) and is internally consistent. Routing only `warn` would split a
  // table whose whole point is that its three rows match; routing all three
  // needs an emerald and a fill-less neutral variant nothing else asks for.
  // See the comment above the table.
  'settings/sections/usernode.tsx',
]);

// Empty, and worth keeping empty: every field box in the tree now comes from
// the primitive. The two remaining literal occurrences of the string are on
// `<div>`s — the header's theme-toggle groups reuse the field box as a
// segmented control — and a div is not something Input renders.
const ALLOWED_FIELD_FILES = new Set([
  // The composer's textarea went with its Send button — see the note above.
  // Its box needed two new `inputVariants` values and a leading `lead` group
  // for `.gc-composer-input`, all declared in the order the hand-written
  // string was written, so the rendered class attribute did not move.
]);

/*
 * `features/admin/**` is skipped, and it is the one exclusion that is about a
 * different SURFACE rather than a different element.
 *
 * The admin console draws from its own registry — `AdminUI.btn.primary` and
 * friends in features/admin/admin-console.js — because an operator console is
 * denser than a phone screen, and tests/admin-ui-registry.test.js enforces in
 * both directions that the console does not import `@/components/ui/**` and
 * the shell does not read AdminUI. Scanning the console here would demand
 * exactly what that test forbids.
 *
 * This matters now because the console's sections are converting to React one
 * at a time (#1120), so `features/admin/*.tsx` files exist for the first time.
 * A converted section spells its primary button `className={AdminUI.btn.primary}`
 * — the registry IS its primitive, and the leak rule in
 * tests/admin-ui-registry.test.js is what keeps it honest there.
 */
const ADMIN_DIR = path.join(FEATURES, 'admin');

function walk(dir, out = []) {
  if (dir === ADMIN_DIR) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * Yield the source text of every `<tag …>` opening for `tag`, from `<` to the
 * `>` that closes it.
 *
 * Deliberately naive — it tracks quotes and brace depth so a `className={cn(…,
 * '…>…')}` expression cannot end the tag early, and that is all the JSX in
 * this tree needs. It is not a parser and does not try to be one.
 */
function* openingTags(src, tag) {
  const open = `<${tag}`;
  for (let i = src.indexOf(open); i !== -1; i = src.indexOf(open, i + 1)) {
    // `<input` must not match `<inputSomething`.
    const after = src[i + open.length];
    if (after && !/[\s/>]/.test(after)) continue;
    let depth = 0;
    let quote = null;
    let j = i + open.length;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    yield src.slice(i, j + 1);
  }
}

const files = walk(FEATURES).map((p) => [path.relative(FEATURES, p).split(path.sep).join('/'), p]);

test('features tree exists and is non-trivial', () => {
  assert.ok(files.length > 20, `expected many feature components, found ${files.length}`);
});

test('no hand-written primary button survives outside the allow-list', () => {
  const offenders = [];
  for (const [rel, abs] of files) {
    if (ALLOWED_BUTTON_FILES.has(rel)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    for (const tag of openingTags(src, 'button')) {
      if (tag.includes(PRIMARY_FILL)) {
        offenders.push(`${rel}: ${tag.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'route these through <Button> (widening the cva table if needed) rather '
      + 'than writing the fill literally:\n' + offenders.join('\n'),
  );
});

test('no hand-written field box survives outside the allow-list', () => {
  const offenders = [];
  for (const [rel, abs] of files) {
    if (ALLOWED_FIELD_FILES.has(rel)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    for (const tag of [...openingTags(src, 'input'), ...openingTags(src, 'textarea')]) {
      if (FIELD_BOXES.some((box) => tag.includes(box))) {
        offenders.push(`${rel}: ${tag.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'route these through <Input> / <Textarea>:\n' + offenders.join('\n'),
  );
});

/**
 * Strip block, line and JSX comments. These files explain the very spellings
 * the rule below bans — the two allow-listed call sites quote their own class
 * strings in prose — and prose about a class is not a class.
 */
function withoutComments(text) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Every quoted or backticked run in `src`, comments already removed. */
function* stringLiterals(src) {
  for (const m of src.matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g)) yield m[0];
}

test('no hand-written amber notice box survives outside the allow-list', () => {
  const offenders = [];
  for (const [rel, abs] of files) {
    if (ALLOWED_NOTICE_FILES.has(rel)) continue;
    const src = withoutComments(fs.readFileSync(abs, 'utf8'));
    for (const literal of stringLiterals(src)) {
      if (
        NOTICE_FILL.test(literal)
        && NOTICE_ROUNDED.test(literal)
        && NOTICE_PADDING.test(literal)
      ) {
        offenders.push(`${rel}: ${literal.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'route these through <Alert variant="notice" density="…"> (see '
      + 'frontend/@/components/ui/alert.tsx) rather than writing the box '
      + 'literally:\n' + offenders.join('\n'),
  );
});

test('the notice slot is anchored tightly enough to leave real amber alone', () => {
  // The four spellings an earlier, hue-wide version of this rule flagged by
  // mistake. Each is amber and none is a notice box; if any starts failing,
  // the anchor has been loosened and the allow-list is about to grow for the
  // wrong reason.
  const innocent = [
    'w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500',                     // a status dot
    'mt-3 rounded-lg border border-amber-500/50 px-3 py-1.5 text-sm font-medium '
      + 'text-amber-800 dark:text-amber-300 hover:bg-amber-500/10',       // the "Try again" button
    'flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 '
      + 'border-b border-amber-200 text-xs',                              // a full-bleed strip
    'text-sm font-semibold text-amber-800 dark:text-amber-400',           // a heading ink
  ];
  for (const s of innocent) {
    assert.ok(
      !(NOTICE_FILL.test(s) && NOTICE_ROUNDED.test(s) && NOTICE_PADDING.test(s)),
      `over-broad: this is not a notice box — ${s}`,
    );
  }
  // …and the slot it IS meant to catch.
  const box = 'mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm';
  assert.ok(
    NOTICE_FILL.test(box) && NOTICE_ROUNDED.test(box) && NOTICE_PADDING.test(box),
    'the rule no longer matches a hand-written notice box',
  );
});

test('the primitives are actually adopted, not merely available', () => {
  let buttons = 0;
  let fields = 0;
  for (const [, abs] of files) {
    const src = fs.readFileSync(abs, 'utf8');
    buttons += [...openingTags(src, 'Button')].length;
    fields += [...openingTags(src, 'Input')].length + [...openingTags(src, 'Textarea')].length;
  }
  // The counts this slice landed. They are a floor, not a pin: a later slice
  // converting another screen should raise them, and one that lowers them is
  // a regression worth noticing.
  assert.ok(buttons >= 33, `expected >= 33 <Button> call sites, found ${buttons}`);
  // 36 until #2437, which routed thirteen waitlist-survey fields and the App
  // AI cap field through the primitive.
  assert.ok(fields >= 50, `expected >= 50 <Input>/<Textarea> call sites, found ${fields}`);
});

test('every cva value is a complete literal class name', () => {
  // Tailwind's extractor is a regex over source text: a class name assembled
  // from fragments compiles to nothing and the utility silently goes missing.
  // tests/tailwind-build.test.js catches that for the utilities it samples;
  // this catches it at the source, for every value in every table.
  for (const name of fs.readdirSync(UI)) {
    if (!name.endsWith('.tsx')) continue;
    const src = fs.readFileSync(path.join(UI, name), 'utf8');
    const at = src.indexOf('cva(');
    if (at === -1) continue;
    // Comments first — prose contains apostrophes, and an unbalanced one
    // would make the scanner read a paragraph as a class name.
    const table = src
      .slice(at, src.indexOf('export interface'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const [, value] of table.matchAll(/'([^'\\\n]*)'/g)) {
      assert.ok(
        !value.includes('${') && !value.includes('+'),
        `${name}: cva value is not a complete literal: ${JSON.stringify(value)}`,
      );
    }
  }
});
