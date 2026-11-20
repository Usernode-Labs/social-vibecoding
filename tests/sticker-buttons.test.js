// BUTTONS: STICKER (public/css/app.css, after "END OF THE LEFT MENU AND THE
// TOP BAR."). The standard look and the brand kit (WIP) draw their buttons
// as outlined pills with a hard edge and serif labels, the main action in
// the kit's yellow; Paper, simplified, with brand styling and the admin
// console keep theirs.
//
// The block is one more layer over the classes the app already writes, so
// this suite holds the four rules that keep it one system:
//
//   1. It sits after the look's own blocks and is scoped to the two looks
//      that ask for it (html:not([data-skin])), never to Paper.
//   2. The admin console is left out of every rule.
//   3. Every colour is a --sticker-* token, declared once in light and once
//      in dark, and no other rule writes a colour of its own.
//   4. Every role and state the request names is actually drawn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

const MARK_START = '── BUTTONS: STICKER';
const MARK_END = 'END OF BUTTONS: STICKER.';
const SCOPE = 'html:not([data-skin])';

/** The block's rules, from the end of its opening comment to its end marker. */
function stickerBlock() {
  const css = read('public', 'css', 'app.css');
  const start = css.indexOf(MARK_START);
  const end = css.indexOf(MARK_END);
  assert.ok(start > 0 && end > start, 'app.css has the sticker buttons block, start to end');
  assert.ok(start > css.indexOf('END OF STANDARD (WIP).'), 'after the look\'s own block');
  assert.ok(start > css.indexOf('END OF THE LEFT MENU AND THE TOP BAR.'),
    'directly after the menu and top bar block');
  return css.slice(css.indexOf('*/', start) + 2, css.lastIndexOf('/*', end))
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `selector { body }` of the block, media queries flattened. */
function rules(block) {
  const out = [];
  const flat = block.replace(/@media[^{]*\{/g, '').replace(/\}\s*\}/g, '}');
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

/** A selector list's members: split on the commas outside every bracket. */
function topLevel(selector) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(selector.slice(from, i)); from = i + 1; }
  }
  out.push(selector.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

const TOKEN_LIGHT = /^html:not\(\[data-skin\]\)$/;
const TOKEN_DARK = /^html:not\(\[data-skin\]\)\.dark$/;

function tokens() {
  const all = rules(stickerBlock());
  const light = all.filter((r) => TOKEN_LIGHT.test(r.selector) && /--sticker-/.test(r.body));
  const dark = all.filter((r) => TOKEN_DARK.test(r.selector) && /--sticker-/.test(r.body));
  assert.equal(light.length, 1, 'one token rule in light');
  assert.equal(dark.length, 1, 'one token rule in dark');
  return { all, light: light[0], dark: dark[0] };
}

test('it sits after the look\'s blocks and is scoped to the standard look and the brand kit (WIP)', () => {
  const { all } = tokens();
  assert.ok(all.length > 10, 'the block holds the buttons');
  for (const { selector } of all) {
    for (const one of topLevel(selector)) {
      assert.ok(one.startsWith(SCOPE), `"${one}" is not scoped to html:not([data-skin])`);
    }
  }
  const block = stickerBlock();
  assert.doesNotMatch(block, /data-skin="brand"/, 'Paper, simplified keeps its buttons');
  assert.doesNotMatch(block, /html\[data-skin\]/, 'only the looks with no data-skin are drawn');
});

test('the admin console keeps its own buttons: every rule leaves it out', () => {
  const { all, light, dark } = tokens();
  const block = stickerBlock();
  assert.doesNotMatch(block, /AdminUI/, 'the admin console is drawn from its own registry');
  for (const r of all) {
    if (r === light || r === dark) continue;
    assert.ok(r.selector.includes(':where(:not(#admin-screen *))'),
      `${r.selector} would reach the admin console`);
  }
});

test('every colour is a token, written once, and the dark rule only overrides the light one', () => {
  const { all, light, dark } = tokens();
  const declared = new Set();
  for (const m of light.body.matchAll(/(--sticker-[a-z0-9-]+)\s*:/g)) declared.add(m[1]);
  assert.ok(declared.size >= 20, 'the block declares its tokens once');
  for (const r of all) {
    if (r === light || r === dark) continue;
    assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/,
      `${r.selector} writes a colour of its own; make it a --sticker-* token`);
    for (const m of r.body.matchAll(/var\((--sticker-[a-z0-9-]+)/g)) {
      assert.ok(declared.has(m[1]),
        `${m[1]} (used by ${r.selector}) is declared in the block's light token rule`);
    }
  }
  for (const m of dark.body.matchAll(/(--sticker-[a-z0-9-]+)\s*:/g)) {
    assert.ok(declared.has(m[1]), `${m[1]} is declared in the light token rule too`);
  }
  for (const m of dark.body.matchAll(/var\((--sticker-[a-z0-9-]+)/g)) {
    assert.ok(declared.has(m[1]), `the dark rule reads ${m[1]}, declared in the light rule`);
  }
});

test('the asked values: the kit\'s yellow, serif labels, the 2px edge and the vote fills', () => {
  const { light } = tokens();
  assert.match(light.body, /--sticker-main-bg:\s*#ffee6f;/);
  assert.match(light.body, /--sticker-main-ink:\s*#121a0e;/);
  assert.match(light.body, /--sticker-font:\s*'Source Serif 4'/);
  assert.match(light.body, /--sticker-edge-w:\s*2px;/);
  assert.match(light.body, /--sticker-edge-w-small:\s*1px;/);
  assert.match(light.body, /--sticker-yes-bg:\s*#a9cf97;/);
  assert.match(light.body, /--sticker-no-bg:\s*#f4a38c;/);
});

test('every role and state is drawn', () => {
  const block = stickerBlock();
  assert.ok(block.includes('.bg-violet-600'), 'the main action');
  assert.ok(block.includes('.ui-btn-bad'), 'the destructive action');
  assert.ok(block.includes('.border-red-400'), 'the bordered destructive action');
  assert.match(block, /\.ui-link[\s\S]*text-decoration:\s*underline/, 'a text action is underlined');
  assert.ok(block.includes('.dev-vote-switch-yes'), 'Yes');
  assert.ok(block.includes('.dev-vote-switch-no'), 'No');
  assert.ok(block.includes(':hover'), 'under the pointer');
  assert.ok(block.includes(':active'), 'pressed');
  assert.ok(block.includes(':focus-visible'), 'the keyboard\'s ring');
  assert.ok(block.includes(':disabled'), 'disabled');
  assert.ok(block.includes('.ui-btn-sm'), 'a small button');
});
