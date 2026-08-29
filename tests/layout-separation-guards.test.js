// Guards for CONTAINERS OWN SEPARATION — a parent spaces its children with
// `gap`, and a component invoked with a margin in its `className` is the
// caller reaching into the callee's layout.
//
// Run with: node --test tests/layout-separation-guards.test.js
//
// ── The rule, and its four blessed shapes ──────────────────────────────
//
// The four are part of the rule rather than exceptions discovered later, and
// every mechanism below is built so that three of them CANNOT match:
//
//   * `m*-auto` — a flex push or a centering. `gap` has no equivalent.
//   * a NEGATIVE margin — deliberate bleed, and optical nudges like
//     `.gc-msg-header .gc-react-add { margin-left: -2px }`.
//   * typographic rhythm inside a rendered-markdown container — `.dc-table`,
//     `.dc-msg-content hr`, the whole `.dc-h3/.dc-p/.dc-ul` ladder.
//   * a gutter on a LONE child with no siblings to separate.
//
// The first two are excluded by construction in the token tests: `ml-auto`
// fails the value alternation, and `-mt-2` starts with `-` so it never enters
// a `^m…` match. The last two cannot be told from a defect by any scan, which
// is what the named inventories in rules 3 and 5 are for.
//
// When a child genuinely needs its own rhythm, the fix is a VARIANT LITERAL in
// the component's own file. That idiom is already built out and this file
// leans on it: `button.tsx`'s `layout` group (`stacked` / `stacked3` / `gap3`
// / `hiddenGap3`), `label.tsx`'s `spacing` (`stacked` / `stackedGap`),
// `input.tsx`'s `spacing` (`mt1` / `mb2`), `field.tsx`'s `statusLineVariants`.
//
// ── WHAT THIS FILE CANNOT CATCH ────────────────────────────────────────
//
// Naming the blind spot is part of the design. Every mechanism here has one.
//
//  1. IT READS SOURCE TEXT, NOT LAYOUT. Nothing below renders anything. The
//     suite's renderer (tests/lib/render-tsx.js) is esbuild plus
//     `renderToStaticMarkup` — no DOM, no `getBoundingClientRect`, effects
//     never run — so a design that assumed real measurement would be dead on
//     arrival. This file asserts SPELLINGS, in the style of
//     tests/theme-ink-guards.test.js. Whether the resulting gap is the RIGHT
//     gap is a question for a browser.
//
//  2. ONLY `.tsx` IS PARSED STRUCTURALLY. `public/js/**` builds class strings
//     into `innerHTML` templates; there is no tree to ask for a first child,
//     so rules 1 and 4 cannot see it. Rule 5's census does count it (19
//     margin utilities today), which is the honest half of that coverage.
//
//  3. A MARGIN BEHIND AN IMPORTED CONSTANT IS INVISIBLE TO RULE 1. The tier-1
//     scan resolves string and template fragments inside the call site's own
//     class attribute; `className={SOMETHING_IMPORTED}` reads as empty. That
//     is precisely why rule 3 pins the primitive inventory in both directions
//     — the laundering destination is pinned even though the laundering ACT
//     is not observable.
//
//  4. A COMPONENT THAT RETURNS A FRAGMENT HAS NO ROOT TO BLAME. `field.tsx`'s
//     `SectionHeading` drops `mb-1` and `mb-3` straight into eighteen callers'
//     block flow, with no element of its own to own them. Its own header
//     comment records this as knowingly unfixed. There is no
//     `<SectionHeading className="mb-3">` anywhere for a scan to find, and
//     there never will be.
//
//  5. THE CSS INVENTORY IS AN EQUALITY OVER DECLARATIONS, NOT A JUDGEMENT. It
//     says a margin is KNOWN, never that it is right. A rule whose value
//     changes trips it; a rule that is merely wrong does not.
//
//  6. TRAP A IS A HEURISTIC OVER THE FIRST CHILD'S CLASS ATTRIBUTE SOURCE. A
//     child hidden by a mechanism spelled somewhere else — a visibility
//     store, a legacy module's `classList.add('hidden')` — is invisible here.
//
//  7. NOTHING HERE READS COMPILED CSS. The `space-y` specificity arithmetic in
//     rule 4 is reasoned from Tailwind v3's emitted selector, not measured
//     against `public/css/tailwind.css` (which is gitignored and rebuilt).
//
// ── A MECHANISM NOTE, because it produced a FALSE ZERO ─────────────────
//
// `ts.forEachChild` STOPS ITERATING the moment its callback returns a truthy
// value — it is a search primitive, not a visitor. A recursive collector
// written as `ts.forEachChild(n, (c) => collect(c, out))`, where `collect`
// returns the accumulator, therefore visits the FIRST child of every node and
// abandons the rest. It looks correct, it works on the simple case
// (`className="…"`), and it silently truncates every conditional and every
// `cn(a, b, c)`.
//
// That bug is why two earlier analyses of this tree reported zero space-y
// traps. `settings-nav.tsx`'s `className={group.first ? '' : GROUP_SPACED}`
// stopped at the `''` branch and never reached the identifier holding `mt-4`.
// `collectStrings` below closes the callback in a block for that reason. Do
// not "simplify" it back to an expression body.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

function walk(dir, re, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, re, out); } else if (re.test(e.name)) out.push(p);
  }
  return out;
}

/** Source with block, line and JSX comments removed — prose about a class is not a class. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
}
const lineAt = (src, i) => src.slice(0, i).split('\n').length;

const TSX = [
  ...walk(path.join(root, 'frontend', 'src'), /\.tsx$/),
  ...walk(path.join(root, 'frontend', '@'), /\.tsx$/),
].sort();

const parse = (p) => ts.createSourceFile(
  p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TSX,
);

test('the TSX parser is present and produces a JSX tree', () => {
  // Everything below is worthless if the compiler API silently degrades: a
  // parse that yields no JSX nodes reports zero findings and reads as a pass.
  assert.equal(typeof ts.createSourceFile, 'function', 'typescript is a devDependency of the root package');
  const sf = ts.createSourceFile('probe.tsx', '<Foo className={cn("mt-2", x ? "mb-1" : "")} />',
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let jsx = 0;
  (function v(n) { if (ts.isJsxSelfClosingElement(n)) jsx++; ts.forEachChild(n, v); })(sf);
  assert.equal(jsx, 1, 'ScriptKind.TSX must produce JSX nodes');
  assert.ok(TSX.length > 100, `expected the frontend .tsx corpus, found ${TSX.length} files`);
});

// ── Token machinery ────────────────────────────────────────────────────
//
// A Tailwind class is `variant:variant:…:utility`, and a variant may itself
// carry a `:` inside brackets (`[&>svg]:mt-2`). Splitting on the first `:`
// would mangle those, so the prefix stripper tracks bracket depth. The
// trailing `!` strip handles v3's important prefix; `!-mt-2` therefore still
// reduces to `-mt-2` and stays out of every `^m…` match.

function stripVariants(token) {
  let t = token;
  for (;;) {
    let depth = 0, cut = -1;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '[' || c === '(') depth++;
      else if (c === ']' || c === ')') depth--;
      else if (c === ':' && depth === 0) { cut = i; break; }
    }
    if (cut < 0) break;
    t = t.slice(cut + 1);
  }
  return t.replace(/^!/, '');
}

// `m`, `mt`, `mb`, `mr`, `ml`, `mx`, `my` followed by a NUMBER, `px`, an
// arbitrary value, or the content keyline's `gutter` alias. `auto` is absent
// from the alternation and a negative token never reaches the `^`.
const MARGIN = /^m[tbrlxy]?-(?:\d|px|\[|gutter)/;
const MARGIN_TOP = /^mt-(?:\d|px|\[|gutter)/;

/**
 * Every string and template fragment reachable inside `node`, with
 * module-level `const X = '…'` identifiers resolved.
 *
 * This is the instrument the brief demanded and a regex over open tags is
 * not: it sees through `cn(…)`, ternaries, class arrays and MULTILINE open
 * tags, because it walks the tree rather than matching `<Tag …>`. That
 * distinction is not academic — the open-tag regex undercounted this very
 * population as 14 when it is 20 (24 before the pass).
 */
function collectStrings(node, consts, out = []) {
  if (!node) return out;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { out.push(node.text); return out; }
  if (ts.isIdentifier(node) && consts.has(node.text)) { out.push(consts.get(node.text)); return out; }
  if (ts.isTemplateExpression(node)) {
    out.push(node.head.text);
    for (const span of node.templateSpans) { out.push(span.literal.text); collectStrings(span.expression, consts, out); }
    return out;
  }
  // Block body, NOT an expression body — see the mechanism note in the header.
  ts.forEachChild(node, (child) => { collectStrings(child, consts, out); });
  return out;
}

/** Module-level string constants, so `className={GROUP_SPACED}` is readable. */
function constMap(sf) {
  const m = new Map();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const init = d.initializer;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) m.set(d.name.text, init.text);
      else if (ts.isTemplateExpression(init)) {
        m.set(d.name.text, [init.head.text, ...init.templateSpans.map((s) => s.literal.text)].join(' '));
      }
    }
  }
  return m;
}

/** The `class` / `className` attributes on one JSX opening tag. */
function classAttributes(el, sf) {
  const out = [];
  for (const a of el.attributes.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    if (!/class(Name)?$/i.test(a.name.getText(sf))) continue;
    out.push(a);
  }
  return out;
}
const classTokens = (el, sf, consts) => classAttributes(el, sf)
  .flatMap((a) => collectStrings(a.initializer, consts))
  .join(' ')
  .split(/\s+/)
  .filter(Boolean);

// ═══════════════════════════════════════════════════════════════════════
// 1 + 2. TIER 1 — a margin in a COMPONENT invocation's class attribute
// ═══════════════════════════════════════════════════════════════════════
//
// "Uppercase tag" is the whole test: `<div className="mt-3">` is a container
// spacing its own content and is none of this file's business, while
// `<Button className="mt-3">` is a caller deciding a layout the component
// cannot see.
//
// The list below is a NAMED allowlist asserted in BOTH directions, and that
// shape is deliberate. A numeric budget accrues silent headroom — this
// repository has twice watched a ratchet stop ratcheting that way (200 against
// a true 78, then 58 against a true 6), and tests/theme-ink-guards.test.js
// condemns it in its own comments, twice. A named list cannot: an entry that
// no longer matches fails as a stale exemption, so the only way to change the
// number is to change the list.
//
// Every survivor here is the SAME defect, and it is the deferred half of this
// pass rather than a disagreement with the rule: the primitives grew the named
// variants, and these call sites were not moved onto them. `label.tsx`'s own
// header says so outright — "eight of the fourteen Label call sites hand-write
// a margin in className, and they do it because this comment told them to" —
// and those eight are exactly the eight `<Label>` sites below.

const TIER1_ALLOWLIST = [
  // ── <Label> and <Field>: RETIRED, and left here as a record ──────────
  // Eleven entries stood here — eight <Label>, one <Button>, two <Field> —
  // exempting call sites that hand-wrote the margin the primitives had just
  // named. They were exempted because the variants and their callers landed
  // in different agents' file sets during a parallel run, so the API arrived
  // without the sites that justify it.
  //
  // They are gone because the sites moved onto the variants in the same
  // commit as this edit: `spacing="stacked"` x9, `spacing="stackedGap"` x1,
  // `layout="hiddenGap3"` x1, `<Field spacing="stacked">` x2. The census
  // below dropped 973 -> 961 by exactly those 12 tokens.
  //
  // The retirement is the point, and it is why this list is asserted in BOTH
  // directions: a stale exemption is how an allowlist becomes the numeric
  // headroom that stopped two ratchets in this repo. This test refused to
  // pass with eight entries that no longer described the tree, which is the
  // only reason the gap was closed rather than quietly inherited.

  // ── <Button>: one site that `layout` already names ───────────────────
  // #awaiting-open-secrets / #app-error-build-log under the app-frame status
  // message is the pair button.tsx's `gap3` comment cites by id.
  { file: 'frontend/src/features/app-frame/app-status.tsx', tag: 'Button', cls: 'mt-3', n: 1 },

  // ── <Input>: one shell site `spacing="mb2"` names, one admin site ─────
  // #feedback-title is the site input.tsx's `mb2` comment cites by id.
  { file: 'frontend/src/features/dialogs/feedback.tsx', tag: 'Input', cls: 'mb-2', n: 1 },
  // The admin console's OWN Input (topochain/ui.tsx), not the shell's — the
  // density boundary keeps it off `@/components/ui`, and that Input has no
  // spacing group to move onto yet. Fixing it means adding one there first.
  { file: 'frontend/src/features/admin/topochain/sql-console.tsx', tag: 'Input', cls: 'mb-2', n: 1 },

  // ── <AppViewTabs>: a screen gutter on a strip with no wrapper ─────────
  // improve-panel.tsx carries a comment explaining why it is `mx-4 mb-2` and
  // not a wrapper: #improve-views is a DIRECT child of #improve-body, which is
  // the band order a declared dapp.json check selects on. Wrapping it to move
  // the margin would change the very structure the check pins.
  { file: 'frontend/src/features/improve/improve-panel.tsx', tag: 'AppViewTabs', cls: 'mx-4', n: 1 },
  { file: 'frontend/src/features/improve/improve-panel.tsx', tag: 'AppViewTabs', cls: 'mb-2', n: 1 },
  // The same strip in the app-context sheet, at that sheet's own 20px inset.
  { file: 'frontend/src/features/app-context/app-context-sheet.tsx', tag: 'AppViewTabs', cls: 'mx-5', n: 1 },

  // ── <WarningTriangleIcon>: an inline glyph inside a text line ─────────
  // `inline-block h-4 w-4 mr-1.5 -mt-0.5` — the gap to the words beside it and
  // an optical lift, on a mark that is part of the sentence rather than a
  // child of a container. The `-mt-0.5` half is a blessed negative and never
  // matched; `mr-1.5` is the same nudge pointing sideways.
  { file: 'frontend/src/features/dialogs/create-progress.tsx', tag: 'WarningTriangleIcon', cls: 'mr-1.5', n: 1 },

  // ── <GroupedList mx-0>: a NO-OP the pass left behind on purpose ───────
  // grouped-list.tsx used to bake `mx-4` into its root and this ONE caller
  // passed `mx-0` to cancel it — overridden at 100% of its call sites. The
  // baked margin is gone now, so this `mx-0` cancels nothing. It is listed
  // rather than deleted because deleting it is a separate, deliberate edit;
  // when it goes, this entry must go with it.
  { file: 'frontend/src/features/settings/settings-nav.tsx', tag: 'GroupedList', cls: 'mx-0', n: 1 },
];

function tier1Findings() {
  const found = [];
  for (const p of TSX) {
    const sf = parse(p);
    const consts = constMap(sf);
    (function visit(n) {
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /^[A-Z]/.test(n.tagName.getText(sf))) {
        const tag = n.tagName.getText(sf);
        for (const attr of classAttributes(n, sf)) {
          for (const s of collectStrings(attr.initializer, consts)) {
            for (const raw of s.split(/\s+/)) {
              if (raw && MARGIN.test(stripVariants(raw))) {
                found.push({
                  file: rel(p), tag, cls: raw,
                  line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
                });
              }
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  return found;
}

const key = (f) => `${f.file} <${f.tag}> ${f.cls}`;

test('no component invocation carries a margin outside the allowlist', () => {
  const found = tier1Findings();
  const allowed = new Set(TIER1_ALLOWLIST.map(key));
  const bad = found.filter((f) => !allowed.has(key(f)));
  const byFile = {};
  for (const f of bad) byFile[f.file] = (byFile[f.file] || 0) + 1;
  const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([f, n]) => `    ${f} (${n})`).join('\n');
  assert.deepStrictEqual(bad.map((f) => `${f.file}:${f.line} <${f.tag}> ${f.cls}`), [],
    `${bad.length} component invocation(s) hand-write a margin. A parent spaces its children with `
    + '`gap`; a margin in a component\'s className is the caller reaching into the callee\'s layout. '
    + 'Move the rhythm into that component\'s own variant table as a COMPLETE literal — '
    + 'button.tsx\'s `layout` group is the idiom — or space the children from their container.\n'
    + `  top offenders:\n${top}`);
});

test('every tier-1 allowlist entry still matches a live finding', () => {
  // The converse, and the half that stops this list becoming a numeric budget
  // in disguise. An exemption carries the assumption that justified it, and
  // nothing re-checks that assumption when the world moves — which is the
  // lesson tests/theme-ink-guards.test.js records about the admin-console
  // exclusion that was "pinned open by a comment that was simply out of date".
  const found = tier1Findings();
  const live = new Map();
  for (const f of found) live.set(key(f), (live.get(key(f)) || 0) + 1);

  const stale = [];
  for (const e of TIER1_ALLOWLIST) {
    const n = live.get(key(e)) || 0;
    if (n !== e.n) stale.push(`${key(e)} — allowlisted x${e.n}, found x${n}`);
  }
  assert.deepStrictEqual(stale, [],
    'stale exemption — remove it. These allowlist entries no longer describe the tree:\n  '
    + stale.join('\n  '));

  // And the totals agree, so neither direction can drift alone.
  const total = TIER1_ALLOWLIST.reduce((s, e) => s + e.n, 0);
  assert.equal(found.length, total,
    `tier-1 margins: ${found.length} found, ${total} allowlisted`);
  // 20 -> 8: eleven call sites moved onto the primitives' named variants in
  // the same commit that retired their exemptions (see TIER1_ALLOWLIST). This
  // number may only ever go DOWN without an argument attached — an allowlist
  // that grows is the headroom this whole two-direction check exists to deny.
  assert.equal(total, 8, 'measured against the tree after the containers-own-separation pass');
});

// ═══════════════════════════════════════════════════════════════════════
// 3. THE PINNED PRIMITIVE-MARGIN INVENTORY
// ═══════════════════════════════════════════════════════════════════════
//
// Rule 1 bans a margin at the CALL SITE. On its own that is an invitation to
// move the same margin one level down, into a `cva` table or a component CSS
// rule, where no scan looks — and a laundered margin is worse than the one it
// replaced, because it now applies to every caller instead of one.
//
// So both destinations are pinned, in both directions. A new margin in a shell
// primitive or in app.css has to be added here deliberately; one that
// disappears fails as a stale entry. Neither list may be regenerated to go
// green — that is the same discipline tests/baselines/shell-markup.json is
// held to, and for the same reason.
//
// What this CANNOT say is whether any of them is correct. See blind spot 5.

const UI_MARGIN_INVENTORY = [
  // button.tsx `layout`: the two stacked rhythms, kept as two NAMED values on
  // the owner's call — 8px continues a form, 12px starts something new.
  'frontend/@/components/ui/button.tsx mt-2',
  'frontend/@/components/ui/button.tsx mt-3',
  // chat.tsx: your own bubble pushed right, and the row rhythm under it.
  'frontend/@/components/ui/chat.tsx ml-auto',   // blessed flex push
  'frontend/@/components/ui/chat.tsx mt-1',
  // dialog.tsx: the card's inset from the viewport edge.
  'frontend/@/components/ui/dialog.tsx mx-4',
  // feed.tsx: the entry's own internal ladder.
  'frontend/@/components/ui/feed.tsx mt-0.5',
  'frontend/@/components/ui/feed.tsx mt-2',
  'frontend/@/components/ui/feed.tsx mt-3',
  // field.tsx: SectionHeading's two (see blind spot 4 — a fragment, knowingly
  // unfixed) plus statusLineVariants' `spacing` group.
  'frontend/@/components/ui/field.tsx mb-1',
  'frontend/@/components/ui/field.tsx mb-2',
  'frontend/@/components/ui/field.tsx mb-3',
  'frontend/@/components/ui/field.tsx mt-2',
  'frontend/@/components/ui/field.tsx mt-3',
  // input.tsx `spacing`: mt1 / mb2, the group that absorbed #feedback-title.
  'frontend/@/components/ui/input.tsx mb-2',
  'frontend/@/components/ui/input.tsx mt-1',
  // label.tsx `spacing`: stacked / stackedGap.
  'frontend/@/components/ui/label.tsx mb-1',
  'frontend/@/components/ui/label.tsx mt-2',
  // tabs.tsx: the gap under a section tab track.
  'frontend/@/components/ui/tabs.tsx mb-4',
];

test('the shell primitives declare exactly the margins inventoried here', () => {
  const found = [];
  for (const p of walk(path.join(root, 'frontend', '@', 'components', 'ui'), /\.tsx?$/).sort()) {
    const sf = parse(p);
    const seen = new Set();
    (function visit(n) {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
        || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        for (const raw of String(n.text).split(/\s+/)) {
          if (!raw) continue;
          const t = stripVariants(raw);
          // Negatives and `auto` are INCLUDED here on purpose: this is an
          // inventory of what the primitives declare, not a ban, and a blessed
          // shape still has to be visible to be re-checked.
          if (!/^-?m[tbrlxy]?-(?:\d|px|\[|gutter|auto)/.test(t)) continue;
          const entry = `${rel(p)} ${raw}`;
          if (!seen.has(entry)) { seen.add(entry); found.push(entry); }
        }
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  // Comment prose is not a class: grouped-list.tsx's header discusses the
  // `mx-4` it USED to bake and the `mx-0` that cancelled it, and neither is a
  // string literal, so neither appears. That is the AST earning its keep over
  // a text regex, which would have inventoried both.
  assert.deepStrictEqual(found.sort(), UI_MARGIN_INVENTORY.slice().sort(),
    'the margins declared inside frontend/@/components/ui/** no longer match the pinned inventory. '
    + 'A margin added here is a caller margin that moved out of sight — add it deliberately, with '
    + 'the variant that owns it; a margin removed means an entry above is stale.');
});

// ── The app.css half ───────────────────────────────────────────────────
//
// Fourteen of these were reported by the appliers as the rules this pass
// produced or deliberately kept, and all fourteen were verified live against
// the tree. The reported list WAS incomplete — the file carries 162 non-zero
// margin declarations — so the rest are inventoried mechanically rather than
// left as headroom (164 after the merge with platform main added two — see
// the dev-feed pair below). Zero-valued declarations are excluded: `margin: 0` is a
// margin being removed, which is the opposite of the defect.
//
// The fourteen seeded rules, and why each survives:
//   .dc-pr-card / .dc-spec-preview-card  vertical rhythm only after this pass;
//                                        the horizontal halves were zeroed
//   .dc-pr-card-header                   header-to-body gap inside one card
//   .gc-msg-header .gc-react-add         margin-left: -2px — a blessed
//                                        negative, an optical nudge
//   .gc-react-bar-more                   the "+" beside the reaction pills
//   .messages-reply-draft button,
//     .messages-pending-object button    margin-left: auto — a blessed flex
//                                        push; gap has no equivalent
//   .messages-reply-draft,
//     .messages-pending-object           the draft strip's gap to the composer
//   .messages-reactions                  reactions under a bubble
//   .dc-flow-error / -notice / -order    the flow card's stacked lines
//   .dc-draft-row + .dc-draft-row        an adjacent-sibling rhythm, which is
//                                        a container spacing its children by
//                                        the only means raw CSS has
//   .dc-table / .dc-msg-content hr       typographic rhythm inside rendered
//                                        markdown — blessed shape three

const APP_CSS_MARGIN_INVENTORY = [
  "#admin-analytics-root .dc-info, #admin-estimator-root .dc-info { margin-left: 0.4rem }",
  "#dev-feed .dev-feed-entry + .dev-feed-entry { margin-top: 0.5rem }",
  // The two below arrived with the merge of platform main, from upstream's
  // dev-feed work. Both are a CONTAINER spacing its own children, not a caller
  // reaching in: `.dev-feed-thread` is a nested reply list inside an entry, so
  // the left margin is its indent from the parent entry and the top margin is
  // its offset from the entry's own text. Recorded rather than swept — the
  // rule this file enforces is about who OWNS a margin, and upstream owns
  // these.
  "#dev-feed .dev-feed-thread { margin-left: 2.75rem }",
  "#dev-feed .dev-feed-thread { margin-top: 0.25rem }",
  "#drawer-theme-caret::after { margin: 0 auto }",
  "#gc-reply-preview { margin-bottom: 6px }",
  "#import-status .import-spinner { margin-right: 6px }",
  ".attr-pop-add { margin-top: 4px }",
  ".attr-pop-addbtn { margin-top: 6px }",
  ".attr-pop-head-divided { margin-top: 4px }",
  ".attr-pop-suggest { margin-top: 4px }",
  ".card-menu-header { margin-bottom: 0.25rem }",
  ".card-menu-pills { margin-top: 0.375rem }",
  ".card-menu-updated { margin-top: 0.25rem }",
  ".card-menu-version { margin-top: 0.375rem }",
  ".dc-attach-error { margin-bottom: 6px }",
  ".dc-attach-strip.dc-attach-strip-active { margin-bottom: 6px }",
  ".dc-blockquote { margin: 8px 0 }",
  ".dc-cc-attached-chevron { margin-left: 6px }",
  ".dc-cc-attached-md li { margin: 2px 0 }",
  ".dc-cc-attached-md p { margin: 4px 0 }",
  ".dc-cc-attached-md pre.dc-code-block { margin: 6px 0 }",
  ".dc-cc-attached-md ul, .dc-cc-attached-md ol { margin: 4px 0 }",
  ".dc-cc-log { margin: 6px 0 }",
  ".dc-code-block { margin: 4px 0 8px }",
  ".dc-composer-actions { margin-bottom: 6px }",
  ".dc-credits-card { margin: 6px 0 }",
  ".dc-credits-card-detail { margin-top: 2px }",
  ".dc-credits-card-intro { margin-top: 8px }",
  ".dc-credits-dev .dc-credits-options { margin-top: 6px }",
  ".dc-credits-dev { margin-top: 10px }",
  ".dc-credits-dev-hint { margin-top: 4px }",
  ".dc-credits-option-blurb { margin-top: 2px }",
  ".dc-credits-options { margin-top: 8px }",
  ".dc-draft-row + .dc-draft-row { margin-top: 4px }",
  ".dc-drafts.dc-drafts-active { margin-bottom: 6px }",
  ".dc-flow-actions { margin-top: 8px }",
  ".dc-flow-actions-footer { margin-top: 10px }",
  ".dc-flow-brief { margin-top: 6px }",
  ".dc-flow-card { margin: 6px 0 }",
  ".dc-flow-card-detail, .dc-flow-card-hint { margin-top: 4px }",
  ".dc-flow-error { margin-top: 6px }",
  ".dc-flow-notice { margin-top: 6px }",
  ".dc-flow-option-blurb { margin-top: 2px }",
  ".dc-flow-options { margin-top: 8px }",
  ".dc-flow-order { margin-top: 10px }",
  ".dc-flow-order-text { margin-top: 6px }",
  ".dc-flow-remember { margin-top: 10px }",
  ".dc-flow-remember-hint { margin-top: 2px }",
  ".dc-flow-step-detail { margin-top: 2px }",
  ".dc-flow-steps { margin-top: 10px }",
  ".dc-flow-vendors { margin-top: 8px }",
  ".dc-force-stop-btn { margin-left: 8px }",
  ".dc-h3 { margin: 14px 0 4px }",
  ".dc-h4 { margin: 12px 0 4px }",
  ".dc-h5 { margin: 10px 0 3px }",
  ".dc-inline-img { margin: 6px 0 }",
  ".dc-launchpad { margin: 6px 0 }",
  ".dc-launchpad-copy { margin-top: 6px }",
  ".dc-launchpad-copy-btn, .dc-launchpad-btn { margin-top: 6px }",
  ".dc-launchpad-resume { margin-top: 8px }",
  ".dc-launchpad-resume-detail { margin-top: 2px }",
  ".dc-launchpad-step-detail { margin-top: 2px }",
  ".dc-launchpad-steps { margin-top: 10px }",
  ".dc-launchpad-sub { margin-top: 4px }",
  ".dc-md-fallback { margin: 4px 0 8px }",
  ".dc-md-fallback-notice { margin: 0 0 4px }",
  ".dc-msg-assistant { margin-bottom: 4px }",
  ".dc-msg-assistant { margin-right: auto }",
  ".dc-msg-attachments { margin-top: 6px }",
  ".dc-msg-content hr { margin: 12px 0 }",
  ".dc-msg-content p, .dc-p { margin-top: 0.5em }",
  ".dc-msg-header { margin-bottom: 4px }",
  ".dc-msg-user { margin-bottom: 4px }",
  ".dc-msg-user { margin-left: auto }",
  ".dc-ol li, .dc-ul li { margin: 2px 0 }",
  ".dc-ol { margin: 6px 0 }",
  ".dc-pi-report { margin: 0 0 6px }",
  ".dc-pr-card { margin: 8px 0 }",
  ".dc-pr-card-header { margin-bottom: 8px }",
  ".dc-qa-actions { margin-top: 2px }",
  ".dc-qa-chip-hint { margin-left: 6px }",
  ".dc-qa-chips { margin: 8px 0 2px }",
  ".dc-quick-replies.dc-quick-replies-active { margin-bottom: 6px }",
  ".dc-spec-preview-card { margin: 4px 0 8px }",
  ".dc-spec-preview-cta { margin-left: auto }",
  ".dc-spec-preview-header { margin-bottom: 6px }",
  ".dc-spec-preview-snippet .dc-h3, .dc-spec-preview-snippet .dc-h4, .dc-spec-preview-snippet .dc-h5, .dc-spec-preview-snippet .dc-p, .dc-spec-preview-snippet .dc-ul, .dc-spec-preview-snippet .dc-ol { margin: 2px 0 }",
  ".dc-spec-viewer-body .dc-blockquote { margin: 8px 0 }",
  ".dc-spec-viewer-body .dc-h3 { margin: 16px 0 6px }",
  ".dc-spec-viewer-body .dc-h4 { margin: 14px 0 5px }",
  ".dc-spec-viewer-body .dc-h5 { margin: 12px 0 4px }",
  ".dc-spec-viewer-body .dc-p, .dc-spec-viewer-body .dc-ul, .dc-spec-viewer-body .dc-ol { margin: 6px 0 }",
  ".dc-spec-viewer-close { margin-left: auto }",
  ".dc-spec-viewer-preamble { margin-bottom: 12px }",
  ".dc-spec-viewer-tab { margin-bottom: -1px }",
  ".dc-spec-viewer-tabs { margin-bottom: 12px }",
  ".dc-status-spinner-arc { margin: 1px }",
  ".dc-table { margin: 8px 0 }",
  ".dc-task-item { margin-left: -16px }",
  ".dc-ul { margin: 6px 0 }",
  ".dev-card-badges { margin-top: 5px }",
  ".dev-card-rail > svg { margin-bottom: auto }",
  ".dev-card-rail > svg { margin-top: auto }",
  ".dev-col-divider { margin: 2px 0 }",
  ".dev-detail-actions { margin-top: 8px }",
  ".dev-detail-reasons { margin-top: 8px }",
  ".dev-detail-reasons-head { margin-bottom: 5px }",
  ".gc-card-actions { margin-top: 6px }",
  ".gc-edit { margin-top: 2px }",
  ".gc-edit-actions { margin-top: 4px }",
  ".gc-mention-option-you { margin-left: auto }",
  ".gc-msg-content .dc-code-block { margin: 4px 0 }",
  ".gc-msg-content .dc-table { margin: 4px 0 }",
  ".gc-msg-content .dc-ul, .gc-msg-content .dc-ol, .gc-msg-content .dc-blockquote { margin: 4px 0 }",
  ".gc-msg-content :is(.dc-p, .dc-ul, .dc-ol, .dc-blockquote, .dc-code-block, .dc-table, .dc-h3, .dc-h4, .dc-h5) + :is(.dc-p, .dc-ul, .dc-ol, .dc-blockquote, .dc-code-block, .dc-table, .dc-h3, .dc-h4, .dc-h5) { margin-top: 6px }",
  ".gc-msg-header .gc-react-add { margin-left: -2px }",
  ".gc-msg-header { margin-bottom: 2px }",
  ".gc-msg-system > .gc-msg-save, .gc-spec-card > .gc-msg-save { margin-left: 4px }",
  ".gc-msg-system > .gc-react-add { margin-left: 4px }",
  ".gc-quoted { margin: 2px 0 4px }",
  ".gc-react-bar-grid { margin-top: 6px }",
  ".gc-react-bar-more { margin-left: 2px }",
  ".gc-reactions { margin-top: 3px }",
  ".gc-spec-card { margin: 6px 0 }",
  ".gc-spec-card-attribution { margin-bottom: 8px }",
  ".gc-spec-card-header { margin-bottom: 4px }",
  ".gc-spec-card-snippet .dc-h3, .gc-spec-card-snippet .dc-h4 { margin: 2px 0 }",
  ".gc-spec-card-snippet .dc-p, .gc-spec-card-snippet .dc-ul, .gc-spec-card-snippet .dc-ol { margin: 2px 0 }",
  ".gc-spec-card-snippet { margin-bottom: 8px }",
  ".gc-spec-panel-body .dc-blockquote { margin: 8px 0 }",
  ".gc-spec-panel-body .dc-h3 { margin: 16px 0 6px }",
  ".gc-spec-panel-body .dc-h4 { margin: 12px 0 4px }",
  ".gc-spec-panel-body .dc-p, .gc-spec-panel-body .dc-ul, .gc-spec-panel-body .dc-ol { margin: 6px 0 }",
  ".gc-spec-panel-subtitle { margin-top: 2px }",
  ".gc-vote-advisory { margin-left: 4px }",
  ".gc-vote-count-dot { margin-right: 4px }",
  ".gc-vote-count-lock { margin-left: 3px }",
  ".gc-vote-explicit { margin-left: 4px }",
  ".gc-vote-inline { margin-left: 8px }",
  ".home-column { margin-left: auto }",
  ".home-column { margin-right: auto }",
  ".home-discover-icon-wrap { margin-inline: auto }",
  ".messages-attachments, .messages-object-list { margin-top: 6px }",
  ".messages-edit > div { margin-top: 3px }",
  ".messages-edit textarea { margin-top: 3px }",
  ".messages-empty button, .messages-state button { margin-top: 5px }",
  ".messages-invitation [role=\"alert\"] { margin-top: 3px }",
  ".messages-invitation p { margin-top: 1px }",
  ".messages-layout { margin: 0 auto }",
  ".messages-message-actions { margin: 2px 0 0 6px }",
  ".messages-quote { margin: 2px 0 4px }",
  ".messages-reactions { margin-top: 5px }",
  ".messages-reply-draft button, .messages-pending-object button { margin-left: auto }",
  ".messages-reply-draft, .messages-pending-object { margin-bottom: 6px }",
  ".messages-report { margin-top: 7px }",
  ".messages-thread-back { margin-left: -7px }",
  ".st-agent-body { margin-left: 6px }",
  ".st-agent-details { margin: 2px 0 2px 2px }",
  ".st-readonly-tag { margin-left: auto }",
  ".st-section { margin-top: 8px }",
  ".st-spec-card { margin: 4px 0 4px 22px }",
  ".vh-live { margin-bottom: 8px }",
  ".vh-live-title { margin-bottom: 3px }",
];

test('public/css/app.css declares exactly the margins inventoried here', () => {
  const cssPath = path.join(root, 'public', 'css', 'app.css');
  // Blank the comments in place so line numbers survive for the message.
  const src = fs.readFileSync(cssPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const found = [];
  const decl = /(?<![-\w])(margin(?:-(?:top|bottom|left|right|inline|block)(?:-(?:start|end))?)?)\s*:\s*([^;}\n]+)/g;
  for (const m of src.matchAll(decl)) {
    const value = m[2].trim().replace(/\s*!important$/, '');
    if (/^0(?:px|rem|em)?$/.test(value)) continue;
    const before = src.slice(0, m.index);
    const brace = before.lastIndexOf('{');
    const prev = Math.max(before.lastIndexOf('}'), before.lastIndexOf(';', brace));
    // `replace(/^[\s\S]*{/, '')` drops an enclosing at-rule prelude, so a rule
    // inside `@media (hover: none) { … }` is keyed by its own selector.
    const sel = before.slice(prev + 1, brace).replace(/^[\s\S]*\{/, '').trim().replace(/\s+/g, ' ');
    found.push(`${sel} { ${m[1]}: ${value} }`);
  }
  const sorted = found.slice().sort();
  const pinned = APP_CSS_MARGIN_INVENTORY.slice().sort();
  const added = sorted.filter((r) => !pinned.includes(r));
  const gone = pinned.filter((r) => !sorted.includes(r));
  assert.deepStrictEqual({ added, gone }, { added: [], gone: [] },
    `public/css/app.css margin declarations drifted from the pinned inventory `
    + `(${found.length} found, ${APP_CSS_MARGIN_INVENTORY.length} pinned). `
    + 'A margin added here may be a caller margin that moved out of sight — record it above with '
    + 'the reason it is a container spacing its children, a blessed shape, or markdown rhythm. '
    + 'Never regenerate this list to go green.');
  assert.equal(found.length, APP_CSS_MARGIN_INVENTORY.length);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. THE TWO `space-y-*` TRAPS
// ═══════════════════════════════════════════════════════════════════════
//
// `space-y-*` stays for existing sites and is not for new code, because its
// emitted selector has two properties nobody expects:
//
//   .space-y-4 > :not([hidden]) ~ :not([hidden]) { margin-top: … }
//
//   TRAP A — it is an ATTRIBUTE test, and this codebase hides by CLASS. A
//   class-hidden FIRST child still matches `:not([hidden])`, so the SECOND
//   child gets a top margin it should not have and the stack opens with a
//   phantom leading gap.
//
//   TRAP B — its specificity is (0,3,0): one class plus two `:not([hidden])`,
//   each of which contributes an attribute selector's (0,1,0). A child's own
//   `mt-*` is (0,1,0) and loses. The margin is not overridden loudly; it is
//   simply never applied, and a class diff shows it sitting there.
//
// The probe reads the first child's class attribute SOURCE TEXT rather than
// its literals, and resolves module-level constants. Both are load-bearing:
// this tree hides through `hiddenFirst(cond, rest)` helpers whose name is the
// only trace of `hidden` at the call site, and carries its one live trap B
// behind an identifier.

/**
 * The JSX elements that are direct children of `el`, descending one level
 * through expression containers — `{cond && <X/>}`, `{a ? <X/> : <Y/>}`,
 * `{list.map(x => <X/>)}` — because those are children in the rendered tree
 * even though they are expressions in the source.
 */
function elementChildren(el, sf) {
  const out = [];
  const push = (n) => {
    if (ts.isJsxElement(n)) out.push(n.openingElement);
    else if (ts.isJsxSelfClosingElement(n)) out.push(n);
    else if (ts.isJsxFragment(n)) for (const c of n.children) push(c);
  };
  const fromExpr = (e) => {
    if (!e) return;
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) { push(e); return; }
    if (ts.isParenthesizedExpression(e)) { fromExpr(e.expression); return; }
    if (ts.isConditionalExpression(e)) { fromExpr(e.whenTrue); fromExpr(e.whenFalse); return; }
    if (ts.isBinaryExpression(e)) { fromExpr(e.right); return; }
    if (ts.isCallExpression(e)) { for (const a of e.arguments) fromExpr(a); return; }
    if (ts.isArrowFunction(e)) { fromExpr(e.body); return; }
    if (ts.isBlock(e)) { for (const s of e.statements) if (ts.isReturnStatement(s)) fromExpr(s.expression); return; }
  };
  for (const c of el.children) {
    // Bare text between the tags means the first "child" is a text node, and
    // `:not([hidden])` matches elements only — stop rather than guess.
    if (ts.isJsxText(c)) { if (c.text.trim()) return out; continue; }
    if (ts.isJsxExpression(c)) { fromExpr(c.expression); continue; }
    push(c);
  }
  return out;
}

const SPACE_Y = /(?<![\w-])space-y-(?!0(?![\w.]))[\w.[\]]+/;

function spaceYTraps() {
  const trapA = [], trapB = [];
  for (const p of TSX) {
    const sf = parse(p);
    const consts = constMap(sf);
    const at = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    (function visit(n) {
      if (ts.isJsxElement(n) && SPACE_Y.test(classTokens(n.openingElement, sf, consts).join(' '))) {
        const kids = elementChildren(n, sf);
        if (kids[0]) {
          // SOURCE TEXT, not literals: `hiddenFirst(cond, 'space-y-4')` puts
          // the word `hidden` in an identifier and nowhere else. Deliberately
          // loose — a className has no other reason to say "hidden", and a
          // ban at zero is the right place to over-match.
          const source = classAttributes(kids[0], sf).map((a) => a.getText(sf)).join(' ');
          const resolved = classTokens(kids[0], sf, consts).join(' ');
          if (/hidden/i.test(source) || /hidden/i.test(resolved)) {
            trapA.push(`${rel(p)}:${at(kids[0])} <${kids[0].tagName.getText(sf)}> `
              + `first child of a space-y parent (:${at(n.openingElement)}) is hidden by class`);
          }
        }
        for (const k of kids) {
          for (const raw of classTokens(k, sf, consts)) {
            if (MARGIN_TOP.test(stripVariants(raw))) {
              trapB.push(`${rel(p)}:${at(k)} <${k.tagName.getText(sf)}> ${raw} `
                + `under space-y (:${at(n.openingElement)})`);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  return { trapA, trapB };
}

test('no space-y parent opens with a class-hidden first child', () => {
  const { trapA } = spaceYTraps();
  // A genuine ban, measured at 0 across 111 space-y parents. Every hidden
  // spelling this tree carries — a literal `hidden` token, `hiddenFirst(…)`,
  // `hiddenLast(…)` — now sits on the PARENT, where it is harmless.
  //
  // It was NOT zero before this pass. Run against the tree at HEAD this
  // assertion fails on features/auth/login.tsx:1102, a class-hidden `<p>`
  // opening the recovery form's `space-y-3` stack. That is the instance two
  // earlier analyses reported as absent, and it is the reason the probe reads
  // the attribute's SOURCE TEXT rather than its literals.
  assert.deepStrictEqual(trapA, [],
    'space-y hides by ATTRIBUTE (`> :not([hidden]) ~ :not([hidden])`) and this codebase hides by '
    + 'CLASS, so a class-hidden first child leaves a phantom leading gap. Use `flex flex-col gap-*` '
    + `here, or hide with the \`hidden\` attribute:\n  ${trapA.slice(0, 8).join('\n  ')}`);
});

test('no direct child of a space-y parent carries its own mt-*', () => {
  const { trapB } = spaceYTraps();
  // ── ONE LIVE DEFECT, named rather than budgeted ──────────────────────
  //
  // This is a genuine bug in the tree, not an exemption, and it PREDATES this
  // pass — settings-nav.tsx is byte-identical to HEAD. settings-nav.tsx
  // renders `<nav className="space-y-1">` over one `<div>` per nav group, and
  // each non-first group carries GROUP_SPACED = 'mt-4 pt-3 border-t …'. The
  // rule's (0,3,0) beats the child's (0,1,0), so every group separator renders
  // at space-y-1's 4px instead of the intended 16px — the `pt-3` and the
  // border land, the `mt-4` does not. The desktop settings nav has been
  // shipping its group breaks three-quarters too tight.
  //
  // It is listed as a NAMED entry, not folded into a count, for two reasons: a
  // count of 1 says nothing about which site, and the both-directions
  // assertion below means fixing it FAILS this test until the entry is
  // removed — which is what forces the record to be updated rather than
  // quietly outliving the defect.
  //
  // The fix is `flex flex-col gap-1` on the nav, with `mt-4` removed from
  // GROUP_SPACED and the group break carried by the gap. That converts a stack
  // to `gap`, so it must strip EVERY child margin in the same edit: flex
  // disables the block margin collapse that currently absorbs mixed
  // `mt`/`mb`/`my` spellings, and a partial conversion doubles gaps invisibly
  // in a class diff.
  const KNOWN = [
    'frontend/src/features/settings/settings-nav.tsx <div> mt-4',
  ];
  const seen = trapB.map((t) => t.replace(/:\d+ /, ' ').replace(/ under space-y.*$/, ''));
  const unknown = trapB.filter((t, i) => !KNOWN.includes(seen[i]));
  assert.deepStrictEqual(unknown, [],
    'space-y-* is (0,3,0) — one class plus two `:not([hidden])` — and silently beats a child\'s own '
    + 'mt-* at (0,1,0). The margin never applies. Space these from the container with '
    + `\`flex flex-col gap-*\`:\n  ${unknown.slice(0, 8).join('\n  ')}`);
  for (const k of KNOWN) {
    assert.ok(seen.includes(k),
      `stale exemption — remove it. ${k} no longer matches; if the settings nav was converted to `
      + '`gap`, delete this entry in the same commit.');
  }
  assert.equal(trapB.length, KNOWN.length);
});

// ═══════════════════════════════════════════════════════════════════════
// 5. THE EQUALITY CENSUS
// ═══════════════════════════════════════════════════════════════════════
//
// Rules 1–4 are shape rules. This is the volume, per bucket, and it is an
// EQUALITY rather than a ceiling. A ceiling with slack in front of it is a
// comment: this repository set one at 200 against a true 78 and another at 58
// against a true 6, and both stopped ratcheting the moment the gap opened.
// An equality cannot develop a gap. Change it in the same commit as the work,
// and say what moved.
//
// `auto`, negatives and `-0` are excluded — the first two are blessed shapes
// and the third is a margin being removed. Comments are stripped, because
// several of these files explain the very spellings being counted.

const CENSUS = /(?<![\w-])m[tbrlxy]?-(?:\[[^\]\s]+\]|px|gutter|(?!0(?![\d.]))\d+(?:\.\d+)?)(?![\w.-])/g;

const CENSUS_BUDGET = {
  // Eighteen distinct declarations across seven primitives — rule 3 names each
  // one. The count is higher than the inventory because a variant table may
  // spell the same utility in two branches.
  'frontend/@': 21,
  // The bulk, and the far side of the density boundary is most of it: the top
  // five files are admin-analytics.tsx (54), admin-status.tsx (40),
  // auth/more.tsx (35), settings/sections/connectors.tsx (33) and
  // dev-board/topic/topic-head.tsx (33). Admin is `p-4 lg:px-6` and its own
  // surface; a sweep of these is a separate pass with its own evidence.
  //
  // 973 -> 961: the twelve tokens retired from TIER1_ALLOWLIST above, when
  // eleven call sites moved onto the primitives' named variants. Every one
  // is accounted for — 6x `mb-1`, one `mt-2 mb-1` (two tokens), one `mt-3`,
  // two `mb-2` — and the arithmetic is stated here rather than left implicit
  // because a census that moves without an explanation is how a ratchet
  // becomes a rubber stamp.
  //
  // 961 -> 960: the merge with platform main, net one. Upstream's own margin
  // changes landed in files this branch also touched, and the resolution kept
  // their structure — so this movement is theirs, not a sweep of ours. Stated
  // for the same reason as the line above: an unexplained census is a rubber
  // stamp whichever direction it moves.
  'frontend/src': 960,
  // The legacy `innerHTML` owners. Rules 1 and 4 cannot see these at all —
  // blind spot 2 — so this count is the whole of their coverage.
  'public/js': 19,
};

test('the margin-utility census matches, bucket by bucket', () => {
  const buckets = {
    'frontend/@': walk(path.join(root, 'frontend', '@'), /\.(tsx?|js)$/),
    'frontend/src': walk(path.join(root, 'frontend', 'src'), /\.(tsx?|js)$/),
    'public/js': walk(path.join(root, 'public', 'js'), /\.js$/),
  };
  const measured = {};
  const detail = {};
  for (const [name, files] of Object.entries(buckets)) {
    let total = 0;
    const per = [];
    for (const p of files.sort()) {
      const n = (code(fs.readFileSync(p, 'utf8')).match(CENSUS) || []).length;
      if (n) { total += n; per.push([rel(p), n]); }
    }
    measured[name] = total;
    detail[name] = per.sort((a, b) => b[1] - a[1]).slice(0, 5);
  }
  for (const [name, expected] of Object.entries(CENSUS_BUDGET)) {
    assert.equal(measured[name], expected,
      `${name}: ${measured[name]} margin utilities, pinned at ${expected}. This is an EQUALITY, not `
      + 'a ceiling — move it in the same commit as the change, and say what moved.\n'
      + `  top files:\n${detail[name].map(([f, n]) => `    ${f} (${n})`).join('\n')}`);
  }
});

// ── The style-attribute half ───────────────────────────────────────────
//
// A class-string scan cannot see `style={{ marginTop: '6px' }}`, and an
// inline style beats every utility, so this is the other door into the same
// defect.
//
// THE BRIEF EXPECTED ZERO HERE AND THE TREE DISAGREES, in both shapes. That
// is recorded rather than smoothed over: eleven live inline margin properties
// and eight `style` props this scan cannot read. Restating an unchanged
// expectation is worthless; measuring is the point.

test('inline style margins and opaque style props stay where they are', () => {
  const marginProps = [], opaque = [];
  for (const p of TSX) {
    const sf = parse(p);
    (function visit(n) {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        for (const a of n.attributes.properties) {
          if (!ts.isJsxAttribute(a) || a.name.getText(sf) !== 'style') continue;
          const line = sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1;
          const read = (e) => {
            if (!e) return;
            if (ts.isParenthesizedExpression(e)) { read(e.expression); return; }
            if (ts.isConditionalExpression(e)) { read(e.whenTrue); read(e.whenFalse); return; }
            if (ts.isIdentifier(e) && e.text === 'undefined') return;
            if (ts.isObjectLiteralExpression(e)) {
              for (const pr of e.properties) {
                if (ts.isSpreadAssignment(pr)) {
                  opaque.push(`${rel(p)} spread ...${pr.expression.getText(sf)}`);
                  continue;
                }
                const nm = pr.name ? pr.name.getText(sf).replace(/['"]/g, '') : '';
                if (/^margin/i.test(nm)) marginProps.push(`${rel(p)}:${line} ${nm}`);
              }
              return;
            }
            opaque.push(`${rel(p)} ${e.getText(sf).replace(/\s+/g, ' ').slice(0, 32)}`);
          };
          if (a.initializer && ts.isJsxExpression(a.initializer)) read(a.initializer.expression);
        }
      }
      ts.forEachChild(n, visit);
    })(sf);
  }

  // Eleven, all in two files. admin-node.tsx's five are the far side of the
  // density boundary; transcript.tsx's six sit on nodes a legacy module also
  // writes, where a utility class would be reconciled away.
  assert.equal(marginProps.length, 11,
    'inline `style` margin properties moved. An inline style beats every utility and no class scan '
    + `sees it — this is an EQUALITY:\n  ${marginProps.join('\n  ')}`);

  // The blind spot, pinned so it cannot widen. Each of these hands `style` an
  // expression this scan cannot read, so a margin inside is invisible to the
  // assertion above — STAMP_STYLE in fact carries `marginLeft: 'auto'`, a
  // blessed flex push. A NEW opaque style prop is a new place to hide one.
  // A CONDITIONAL is not opaque — `read` above descends into both branches, so
  // `style={open ? { transform: … } : undefined}` is fully inspected and is
  // absent from this list. Only an identifier, a call and a spread are truly
  // unreadable. That distinction matters: a coarser probe that treated every
  // non-object initializer as opaque listed thirteen, five of which it could
  // in fact have read, and an inventory of blind spots that names sighted
  // ground is an inventory nobody will trust.
  const OPAQUE = [
    'frontend/@/components/ui/feed.tsx spread ...style',             // caller passthrough
    'frontend/src/features/dev-chat/transcript.tsx STAMP_STYLE',     // holds marginLeft: 'auto'
    'frontend/src/features/dev-chat/view.tsx paneStyle(s.spec)',
    'frontend/src/features/dev-chat/view.tsx paneStyle(s.staging)',
    'frontend/src/features/header/chromeless-pill.tsx GLYPH_STYLE',
    'frontend/src/features/header/chromeless-pill.tsx spread ...PILL_STYLE',
    'frontend/src/features/home/app-grid.tsx cellStyle(item)',
    'frontend/src/features/staging/staging-overlay.tsx style',       // caller passthrough
  ];
  assert.deepStrictEqual(opaque.sort(), OPAQUE.slice().sort(),
    'the set of `style` props this scan cannot read has changed. Each one is a place an inline '
    + 'margin can hide from the assertion above — add a new one deliberately, or prefer a literal '
    + 'object so it stays readable.');
});

test('nothing writes a margin through the DOM style API', () => {
  // The imperative door, and the one shape that IS genuinely zero. A
  // `.style.marginTop = …` is invisible to every scan in this file and to
  // every class-based rule in the product; it also survives a re-render, so it
  // is the most durable way to break a container's spacing.
  const files = [
    ...walk(path.join(root, 'frontend', '@'), /\.(tsx?|js)$/),
    ...walk(path.join(root, 'frontend', 'src'), /\.(tsx?|js)$/),
    ...walk(path.join(root, 'public', 'js'), /\.js$/),
  ].sort();
  const bad = [];
  for (const p of files) {
    const src = code(fs.readFileSync(p, 'utf8'));
    const re = /\.style\s*\.\s*(margin[A-Za-z]*)\s*=|setProperty\(\s*['"](margin[a-z-]*)['"]/g;
    for (const m of src.matchAll(re)) bad.push(`${rel(p)}:${lineAt(src, m.index)} ${m[1] || m[2]}`);
  }
  assert.deepStrictEqual(bad, [],
    'a margin written through element.style survives every re-render and is invisible to every '
    + `class-based guard. Space the children from their container:\n  ${bad.slice(0, 8).join('\n  ')}`);
});
