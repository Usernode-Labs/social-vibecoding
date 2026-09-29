// Every field on the two waitlist surveys goes through the field primitive,
// and comes out of it with the same element and the same attributes (#2437).
//
// ── What this is guarding ──────────────────────────────────────────────
//
// The sixteen fields on `#waitlist` and `#more` each carried their own copy of
// `w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 …`.
// tests/shell-primitive-adoption.test.js could not see them: its FIELD_BOXES
// list named the `zinc-100` fills and not the white one, so the one rule that
// exists to stop hand-written field boxes had a hole exactly the shape of
// these two screens. That list names the white run now, which stops a
// SIXTEENTH copy being written — but a prohibition on a literal cannot say
// that a particular field is routed, or that routing it kept the element the
// rest of the system reads.
//
// That is this file. Both halves matter:
//
//   * the SOURCE half pins that each field is spelled `<Input>` / `<Textarea>`
//     / `<Select>` with the shared `SURVEY_FIELD` / `SURVEY_SELECT` spread,
//     rather than the primitive plus a hand-written box through className —
//     which would pass the prohibition and lose the whole point of it;
//   * the RENDERED half pins the element and its attributes, because the field
//     ids are in tests/baselines/shell-markup.json, `dapp.json` selects deep
//     structural chains through them (`#waitlist-country > option:nth-child(3)`
//     is a CHILD-and-position selector; `#waitlist-confirm-email.hidden` is a
//     class test on the field itself), and public/js/** reads several by
//     getElementById. A primitive that wrapped its element, changed its tag,
//     or dropped `maxLength` would satisfy every other gate in the tree and
//     break a declared check at staging.
//
// Run with: node --test tests/waitlist-field-primitives.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { interiorHtmlFor } = require('./lib/lazy-interiors');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WAITLIST = 'frontend/src/features/auth/waitlist.tsx';
const MORE = 'frontend/src/features/auth/more.tsx';

/**
 * Every converted field: where it lives, what it must render as, and the
 * attributes that must survive the conversion.
 *
 * `attrs` is exhaustive on purpose — an attribute the primitive silently
 * swallowed would otherwise read as a pass. Note what is NOT here: none of
 * these fields carries `name`. They are uncontrolled refs read at submit
 * (see both files' headers), unlike sign-in's and register's, which post a
 * real form. A `name` appearing on one of them is a change, not a fix.
 */
const FIELDS = [
  // ── #waitlist, the stage-1 join and the confirm-by-code panel ────────
  {
    screen: 'auth-waitlist-screen',
    src: WAITLIST,
    id: 'waitlist-email',
    tag: 'input',
    component: 'Input',
    attrs: {
      type: 'email', required: '', maxlength: '255',
      placeholder: 'you@example.com', autocomplete: 'email',
    },
  },
  {
    screen: 'auth-waitlist-screen',
    src: WAITLIST,
    id: 'waitlist-country',
    tag: 'select',
    component: 'Select',
    attrs: {},
  },
  {
    screen: 'auth-waitlist-screen',
    src: WAITLIST,
    id: 'waitlist-confirm-email',
    tag: 'input',
    component: 'Input',
    attrs: {
      type: 'email', maxlength: '255',
      placeholder: 'you@example.com', autocomplete: 'email',
    },
    // It ships hidden and the declared checks read that class off the field
    // itself (`#waitlist-confirm-email.hidden` / `:not(.hidden)`).
    alsoClasses: ['hidden', 'mb-2'],
  },
  {
    screen: 'auth-waitlist-screen',
    src: WAITLIST,
    id: 'waitlist-code',
    tag: 'input',
    component: 'Input',
    attrs: {
      type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      maxlength: '32', placeholder: '000000',
    },
    alsoClasses: ['font-mono'],
  },
  // ── #more, the four stage-2 questions ────────────────────────────────
  {
    screen: 'auth-more-screen',
    src: MORE,
    id: 'more-made-url',
    tag: 'input',
    component: 'Input',
    attrs: {
      type: 'text', inputmode: 'url', autocapitalize: 'none', autocorrect: 'off',
      spellcheck: 'false', maxlength: '2000', placeholder: 'https://',
    },
  },
  {
    screen: 'auth-more-screen',
    src: MORE,
    id: 'more-made-note',
    tag: 'input',
    component: 'Input',
    attrs: {
      type: 'text', maxlength: '140',
      placeholder: 'What is it, in one line? (optional)',
    },
    alsoClasses: ['mt-2'],
  },
  {
    screen: 'auth-more-screen',
    src: MORE,
    id: 'more-group-name',
    tag: 'input',
    component: 'Input',
    attrs: {
      type: 'text', maxlength: '255',
      placeholder: 'A 200-person Discord for indie game devs in Lagos',
    },
  },
  {
    screen: 'auth-more-screen', src: MORE, id: 'more-group-size',
    tag: 'select', component: 'Select', attrs: {},
  },
  {
    screen: 'auth-more-screen', src: MORE, id: 'more-group-role',
    tag: 'select', component: 'Select', attrs: {},
  },
  {
    screen: 'auth-more-screen',
    src: MORE,
    id: 'more-group-need',
    tag: 'textarea',
    component: 'Textarea',
    // `rows` is the floor the auto-grow shrinks back to — see
    // tests/waitlist-long-answers.test.js.
    attrs: { rows: '3', maxlength: '800' },
    placeholderStarts: 'What would its own app do',
    alsoClasses: ['mt-3'],
  },
  {
    screen: 'auth-more-screen',
    src: MORE,
    id: 'more-loss-product',
    tag: 'input',
    component: 'Input',
    attrs: { type: 'text', maxlength: '255' },
    placeholderStarts: 'Which one? Google Reader',
  },
  {
    screen: 'auth-more-screen',
    src: MORE,
    id: 'more-loss-story',
    tag: 'textarea',
    component: 'Textarea',
    attrs: { rows: '3', maxlength: '800' },
    placeholderStarts: 'What happened, and what did you do next?',
  },
  ...[
    ['more-handle-farcaster', 'Farcaster (@handle)'],
    ['more-handle-discord', 'Discord (username)'],
    ['more-handle-telegram', 'Telegram (@handle)'],
    ['more-handle-other', 'Anywhere else: Twitch, YouTube, Mastodon…'],
  ].map(([id, placeholder]) => ({
    screen: 'auth-more-screen',
    src: MORE,
    id,
    tag: 'input',
    component: 'Input',
    attrs: { type: 'text', maxlength: '255', placeholder },
  })),
];

/** The box every one of them renders, from inputVariants' `authWhite`. */
const BOX = 'rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm';

/** The rendered element with `id`, as `{ tag, attrs, classes }`. */
function elementById(screen, id) {
  const html = interiorHtmlFor(screen);
  const m = new RegExp(`<([a-z]+)\\b([^>]*\\bid="${id}"[^>]*)>`).exec(html);
  assert.ok(m, `#${id} is not in the rendered ${screen} interior`);
  const attrs = {};
  for (const a of m[2].matchAll(/([A-Za-z-]+)(?:="([^"]*)")?/g)) {
    if (a[1]) attrs[a[1].toLowerCase()] = a[2] === undefined ? '' : a[2];
  }
  return { tag: m[1], attrs, classes: (attrs.class || '').split(/\s+/) };
}

/**
 * The source text of the JSX element that carries `id="<id>"`, from its `<`
 * to the `>` that closes the opening tag.
 *
 * The forward scan tracks quotes and brace depth, the way
 * tests/shell-primitive-adoption.test.js's does: `onInput={(e) => autoGrow(…)}`
 * puts a `>` inside the tag, and a plain `indexOf('>')` reads the arrow as the
 * end of the element.
 */
function sourceTag(src, id) {
  const text = read(src);
  const at = text.indexOf(`id="${id}"`);
  assert.ok(at !== -1, `${src} no longer writes id="${id}"`);
  const open = text.lastIndexOf('<', at);
  let depth = 0;
  let quote = null;
  let j = open + 1;
  for (; j < text.length; j++) {
    const c = text[j];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) break;
  }
  return text.slice(open, j + 1);
}

test('every converted field is spelled as the primitive, with the shared spread', () => {
  for (const f of FIELDS) {
    const tag = sourceTag(f.src, f.id);
    assert.ok(
      tag.startsWith(`<${f.component}`),
      `${f.src} #${f.id}: expected <${f.component}>, found ${tag.slice(0, 40)}…`,
    );
    const spread = f.component === 'Select' ? 'SURVEY_SELECT' : 'SURVEY_FIELD';
    assert.ok(
      tag.includes(`{...${spread}}`),
      `${f.src} #${f.id}: the box comes from ${spread}, not from this call site`,
    );
    assert.ok(
      !/className="[^"]*(bg-white|border-zinc-300|focus:ring)/.test(tag),
      `${f.src} #${f.id}: a hand-written box has come back through className`,
    );
  }
});

test('each one still renders its own element — no wrapper, no tag change', () => {
  // A tag change is not cosmetic here: `dapp.json` selects
  // `#waitlist-country > option:nth-child(3)`, and `:nth-child` and `>` both
  // count real elements. A field that gained a wrapper div, or that became a
  // `<button role="combobox">` (what stock shadcn's Select renders), would
  // resolve every id and match nothing.
  for (const f of FIELDS) {
    const el = elementById(f.screen, f.id);
    assert.equal(el.tag, f.tag, `#${f.id} should render as <${f.tag}>`);
  }
});

test('and keeps every attribute it carried before the conversion', () => {
  for (const f of FIELDS) {
    const el = elementById(f.screen, f.id);
    for (const [name, value] of Object.entries(f.attrs)) {
      assert.equal(el.attrs[name], value, `#${f.id}: ${name} should be ${JSON.stringify(value)}`);
    }
    if (f.placeholderStarts) {
      assert.ok(
        (el.attrs.placeholder || '').startsWith(f.placeholderStarts),
        `#${f.id}: placeholder should still start "${f.placeholderStarts}"`,
      );
    }
    assert.equal(el.attrs.name, undefined, `#${f.id}: these fields are refs, not form names`);
    assert.equal(el.attrs.id, f.id, `#${f.id}: the id is in the shell baseline`);
  }
});

test('and renders the ONE box the primitive owns, plus only its own extras', () => {
  for (const f of FIELDS) {
    const el = elementById(f.screen, f.id);
    if (f.tag === 'select') {
      // selectVariants writes `w-full rounded-lg` as its base, then the fill.
      assert.match(el.attrs.class, /^w-full rounded-lg bg-white dark:bg-zinc-900 border /);
      assert.match(el.attrs.class, /text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none/);
    } else {
      for (const cls of BOX.split(' ')) {
        assert.ok(el.classes.includes(cls), `#${f.id}: lost "${cls}" from the shared box`);
      }
      for (const cls of ['placeholder-zinc-400', 'dark:placeholder-zinc-500', 'w-full']) {
        assert.ok(el.classes.includes(cls), `#${f.id}: lost "${cls}"`);
      }
    }
    assert.ok(el.classes.includes('focus:ring-violet-500'), `#${f.id}: lost its focus ring`);
    assert.ok(el.classes.includes('focus:border-violet-500'), `#${f.id}: lost its focused border`);
    for (const cls of f.alsoClasses || []) {
      assert.ok(el.classes.includes(cls), `#${f.id}: lost its own "${cls}"`);
    }
  }
});

test('the box and the label are each decided in exactly one place', () => {
  const shared = read('frontend/src/features/auth/waitlist-shared.tsx');
  assert.match(
    shared,
    /export const SURVEY_FIELD = \{ box: 'authWhite', hint: 'muted', ring: 'bordered' \} as const;/,
  );
  assert.match(shared, /export const SURVEY_SELECT = \{ variant: 'authWhite' \} as const;/);
  assert.match(shared, /export const SURVEY_LABEL = '[^']+';/);

  // …and neither screen writes a field box or a label scale of its own.
  for (const rel of [WAITLIST, MORE]) {
    const src = read(rel);
    assert.ok(
      !/className="[^"]*\bbg-white dark:bg-zinc-900 border border-zinc-300/.test(src),
      `${rel}: a hand-written field box is back`,
    );
    assert.ok(
      !/className="block text-sm font-medium text-zinc-700/.test(src),
      `${rel}: a hand-written label scale is back — use SURVEY_LABEL`,
    );
  }
});

test('the label constant is the survey scale, not the sign-in card caption', () => {
  // The two are different on purpose and the reasoning is at SURVEY_LABEL:
  // here the label IS the question, with a 12px gloss under it, so it cannot
  // also be 13px zinc-500 or the question and its own footnote read alike.
  const shared = read('frontend/src/features/auth/waitlist-shared.tsx');
  const label = /export const SURVEY_LABEL = '([^']+)';/.exec(shared)[1];
  assert.match(label, /\btext-sm\b/, 'the question out-ranks its help line');
  assert.match(label, /\bfont-medium\b/);
  const login = read('frontend/src/features/auth/login.tsx');
  const authLabel = /const AUTH_LABEL = '([^']+)';/.exec(login)[1];
  assert.notEqual(label, authLabel, 'a deliberate difference, not an oversight');
  assert.match(authLabel, /text-\[13px\]/, 'and the sign-in caption is still the smaller one');
});
