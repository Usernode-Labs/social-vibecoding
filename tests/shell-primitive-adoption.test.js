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
 * The field box's fill + border run, in both the `zinc-800` (settings and
 * dialogs) and `zinc-900` (auth screens) spellings. Present in an `<input>` or
 * `<textarea>` tag = not converted.
 */
const FIELD_BOXES = [
  'bg-zinc-100 dark:bg-zinc-800 border border-zinc-300',
  'bg-zinc-100 dark:bg-zinc-900 border border-zinc-300',
];

/** See the header. Every entry is a considered exception. */
const ALLOWED_BUTTON_FILES = new Set([
  // #dev-plus-btn and the view-toggle segment fill.
  'dev-board/board-frame.tsx',
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
  // The THREAD composer — and it is one of a PAIR. The general chat's composer
  // is byte-identical apart from its ids (public/js/app-view.js's
  // `renderGroupChatTab`), and that one is still an HTML string in the Dev
  // screen, which is its own deferred chunk. The two have to keep looking the
  // same, so routing only this half through <Button> / <Textarea> — which
  // would also need a new `box` variant for its `text-sm` field — would leave
  // the pair written two different ways and free to drift. Convert them
  // together with the Dev screen, or not at all.
  'group-chat/thread-shell.tsx',
]);

// Empty, and worth keeping empty: every field box in the tree now comes from
// the primitive. The two remaining literal occurrences of the string are on
// `<div>`s — the header's theme-toggle groups reuse the field box as a
// segmented control — and a div is not something Input renders.
const ALLOWED_FIELD_FILES = new Set([
  // The thread composer's textarea, for the same reason its Send button is on
  // the button allow-list above: it is one half of a PAIR whose other half is
  // still an HTML string in public/js/app-view.js. See that entry.
  'group-chat/thread-shell.tsx',
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
  assert.ok(fields >= 36, `expected >= 36 <Input>/<Textarea> call sites, found ${fields}`);
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
