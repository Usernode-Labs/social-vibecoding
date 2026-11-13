// Settings › Accessibility › Reduce motion (#6510).
//
// One switch, stored like text size and high contrast (the head module's
// window.Display, on this device), applied before first paint as
// data-motion="reduce" on <html>, and honoured everywhere the device's own
// prefers-reduced-motion is:
//   - every @media (prefers-reduced-motion: …) block in app.css, native.css
//     and the head's own style has an attribute twin right after it;
//   - Tailwind's motion-reduce:/motion-safe: get the same at build time
//     (scripts/build-tailwind.js addMotionTwins);
//   - every script decision asks one function (frontend/src/lib/reduced-motion.ts,
//     window.Display.reducedMotion for classic scripts), never the media
//     query alone.
//
// Run with: node --test tests/reduce-motion-setting.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const postcss = require('postcss');
const { message } = require('./lib/platform-i18n');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ON = '[data-motion="reduce"]';

// ── The head module ──────────────────────────────────────────────────────

function runDisplay({ stored = {}, deviceReduce = false, unwritable = false } = {}) {
  const head = read('frontend/src/head.html');
  const start = head.indexOf('window.Display = (function');
  const end = head.indexOf('}());', start) + '}());'.length;
  assert.ok(start > 0 && end > start, 'head.html defines window.Display');
  const attrs = new Map();
  const store = new Map(Object.entries(stored));
  const listeners = {};
  const window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { if (unwritable) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
      removeItem: (k) => { if (unwritable) throw new Error('SecurityError'); store.delete(k); },
    },
    matchMedia: (q) => ({ matches: deviceReduce && q === '(prefers-reduced-motion: reduce)' }),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const document = {
    documentElement: {
      setAttribute: (k, v) => attrs.set(k, String(v)),
      removeAttribute: (k) => attrs.delete(k),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    },
  };
  vm.runInNewContext(head.slice(start, end), { window, document });
  return { Display: window.Display, attrs, store, listeners };
}

test('the head module stores the setting and writes data-motion before first paint', () => {
  const off = runDisplay();
  assert.equal(off.Display.getMotion(), false, 'off by default');
  assert.equal(off.attrs.has('data-motion'), false, 'no attribute by default');
  assert.equal(off.Display.reducedMotion(), false);

  const stored = runDisplay({ stored: { 'homeroom:motion': 'reduce' } });
  assert.equal(stored.attrs.get('data-motion'), 'reduce', 'a stored choice lands on <html> as the module loads');
  assert.equal(stored.Display.reducedMotion(), true);

  stored.Display.setMotion(false);
  assert.equal(stored.store.has('homeroom:motion'), false, 'off removes the key');
  assert.equal(stored.attrs.has('data-motion'), false);
  stored.Display.setMotion(true);
  assert.equal(stored.store.get('homeroom:motion'), 'reduce');
  assert.equal(stored.attrs.get('data-motion'), 'reduce');

  // Off is "follow the device", not "allow".
  const device = runDisplay({ deviceReduce: true });
  assert.equal(device.Display.getMotion(), false);
  assert.equal(device.Display.reducedMotion(), true, "the device's preference still applies when the switch is off");

  // Another tab's change applies here.
  const other = runDisplay();
  other.store.set('homeroom:motion', 'reduce');
  other.listeners.storage({ key: 'homeroom:motion' });
  assert.equal(other.attrs.get('data-motion'), 'reduce');
});

test('a pick holds for this page even when the browser will not store it', () => {
  const on = runDisplay({ unwritable: true });
  on.Display.setMotion(true);
  assert.equal(on.store.has('homeroom:motion'), false, 'nothing was stored');
  assert.equal(on.Display.getMotion(), true, 'the switch reads on');
  assert.equal(on.attrs.get('data-motion'), 'reduce', 'and the page is still');
  assert.equal(on.Display.reducedMotion(), true);
  // Off, when the stored 'reduce' cannot be removed.
  const off = runDisplay({ stored: { 'homeroom:motion': 'reduce' }, unwritable: true });
  assert.equal(off.attrs.get('data-motion'), 'reduce');
  off.Display.setMotion(false);
  assert.equal(off.Display.getMotion(), false, 'the switch reads off');
  assert.equal(off.attrs.has('data-motion'), false, 'and motion is back');
  // Another tab writing the key wins over the held pick.
  off.listeners.storage({ key: 'homeroom:motion' });
  assert.equal(off.attrs.get('data-motion'), 'reduce', 'the stored value is read again');
});

test('the Display module runs before the first stylesheet', () => {
  const head = read('frontend/src/head.html');
  assert.ok(head.indexOf('window.Display =') < head.indexOf('<link rel="stylesheet"'));
});

// ── The settings pane ────────────────────────────────────────────────────

test('Accessibility has a Reduce motion switch, read and written through window.Display', () => {
  const src = read('frontend/src/features/settings/sections/accessibility.tsx');
  assert.match(src, /window\.Display\?\.getMotion\?\.\(\)/);
  assert.match(src, /window\.Display\?\.setMotion\?\.\(next\)/);
  const html = renderComponent('frontend/src/features/settings/sections/accessibility.tsx', 'AccessibilitySection');
  const sw = html.match(/<[^>]*id="settings-reduce-motion"[^>]*>/);
  assert.ok(sw, 'the switch renders');
  assert.doesNotMatch(sw[0], /checked=""|aria-checked="true"/, 'and ships off: storage is read in an effect');
  assert.ok(html.indexOf('settings-high-contrast') < html.indexOf('settings-reduce-motion'),
    'it sits after High contrast');
  assert.ok(html.includes(message('settings:accessibility.motion.label')));
  assert.equal(message('settings:accessibility.motion.label'), 'Reduce motion');
  assert.match(message('settings:accessibility.motion.description'), /follows your device/);
});

// ── CSS: every reduced-motion rule has an attribute twin ─────────────────

const MOTION_PROP = /^(animation|transition|scroll-behavior$|transform$)/;

// A selector on <html> itself takes the attribute at the end of its first
// compound (html[data-side-strip]:where(…) .x); any other goes under it.
function scoped(sel) {
  const m = sel.match(/^(?:html|:root)(?:[.#[][^\s:]*?)*?(?=\s|::|$)/);
  return m ? `${m[0]}:where(${ON})${sel.slice(m[0].length)}` : `:where(html${ON}) ${sel}`;
}
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const decls = (rule) => rule.nodes.filter((n) => n.type === 'decl')
  .map((d) => `${d.prop}:${norm(d.value)}${d.important ? '!' : ''}`).join(';');

function checkTwins(file, css) {
  // app.css carries a stray top-level `}` (members-vis status line) that
  // browsers skip and postcss refuses; parse around it.
  const root = postcss.parse(css.replace('#f87171; } }', '#f87171; }'));
  const blocks = [];
  root.walkAtRules('media', (a) => { if (/prefers-reduced-motion/.test(a.params)) blocks.push(a); });
  assert.ok(blocks.length > 0, `${file} has reduced-motion blocks`);
  for (const media of blocks) {
    const reduce = /prefers-reduced-motion:\s*reduce/.test(media.params);
    const rest = media.params.split(/\s+and\s+/).filter((p) => !/prefers-reduced-motion/.test(p)).join(' and ');
    // The twins come right after the block, wrapped in the other conditions.
    const twinRules = new Map();
    let next = media.next();
    while (next && next.type === 'comment') next = next.next();
    for (let n = next; n; n = n.next()) {
      const holder = rest ? (n.type === 'atrule' && n.name === 'media' && n.params === rest ? n : null) : n;
      if (!holder) break;
      const rules = holder.type === 'rule' ? [holder] : (holder.nodes || []).filter((x) => x.type === 'rule');
      if (!rules.length || !rules.every((r) => r.selectors.every((s) => s.includes(ON)))) break;
      for (const r of rules) for (const s of r.selectors) twinRules.set(norm(s), [...(twinRules.get(norm(s)) || []), r]);
      if (rest) break;
    }
    const where = `${file}:${media.source.start.line}`;
    media.walkRules((rule) => {
      if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
      const motion = rule.nodes.filter((n) => n.type === 'decl' && MOTION_PROP.test(n.prop));
      if (!reduce && !motion.length) return; // a transform-origin for motion that is already gone
      for (const sel of rule.selectors) {
        const twins = twinRules.get(norm(scoped(sel)));
        assert.ok(twins, `${where}: "${norm(sel)}" has no Reduce motion twin`);
        if (reduce) {
          assert.ok(twins.some((t) => decls(t) === decls(rule)), `${where}: the twin of "${norm(sel)}" says the same (${decls(rule)})`);
        } else {
          for (const d of motion) {
            const undo = twins.flatMap((t) => t.nodes).find((n) => n.type === 'decl' && n.prop.split('-')[0] === d.prop.split('-')[0]);
            assert.ok(undo && /^(none|auto)$/.test(undo.value), `${where}: the twin of "${norm(sel)}" stops its ${d.prop}`);
          }
        }
      }
    });
  }
  return blocks.length;
}

test('every reduced-motion block in app.css and native.css has a data-motion twin', () => {
  assert.ok(checkTwins('public/css/app.css', read('public/css/app.css')) >= 50);
  assert.equal(checkTwins('public/usernode-native/v1/native.css', read('public/usernode-native/v1/native.css')), 2);
});

test("the head's own reduced-motion rule has its twin", () => {
  const head = read('frontend/src/head.html');
  assert.match(head, /@media \(prefers-reduced-motion: reduce\) \{ html\.release-signing-in::after \{ animation: none; \} \}\s*html\.release-signing-in:where\(\[data-motion="reduce"\]\)::after \{ animation: none; \}/);
});

test('the compiled Tailwind sheet gets the same twins for motion-reduce: and motion-safe:', () => {
  const { addMotionTwins } = require('../scripts/build-tailwind.js');
  const out = addMotionTwins([
    '@media (prefers-reduced-motion:no-preference){@keyframes pulse{50%{opacity:.5}}.motion-safe\\:animate-pulse{animation:pulse 2s infinite}}',
    '@media (prefers-reduced-motion:reduce){.motion-reduce\\:hidden{display:none}.a:is(.b,.c){animation:none}@media (hover:hover){.motion-reduce\\:hover\\:x:hover{transform:none}}}',
  ].join(''));
  assert.match(out, /:where\(html:not\(\[data-motion="reduce"\]\)\) \.motion-safe\\:animate-pulse\{/, 'motion-safe stops under the setting');
  assert.match(out, /@keyframes pulse\{50%\{opacity:\.5\}\}/, 'keyframes untouched');
  assert.match(out, /\}\}:where\(html\[data-motion="reduce"\]\) \.motion-reduce\\:hidden\{display:none\}/, 'motion-reduce has a twin after the block');
  assert.match(out, /:where\(html\[data-motion="reduce"\]\) \.a:is\(\.b,\.c\)\{animation:none\}/, 'a comma inside :is() is not a selector list');
  assert.match(out, /@media \(hover:hover\)\{:where\(html\[data-motion="reduce"\]\) \.motion-reduce\\:hover\\:x:hover/, 'a stacked variant keeps its own media');
  assert.equal(addMotionTwins(out), out, 'running twice changes nothing');
  assert.match(read('scripts/build-tailwind.js'), /finishMotion\(outputPath\);/, 'the one-shot build adds them');
});

// ── Script: one answer ───────────────────────────────────────────────────

test('reducedMotion() answers for the setting or the device', () => {
  const { reducedMotion } = loadTsx('frontend/src/lib/reduced-motion.ts');
  const win = (attr, device, throws) => ({
    document: { documentElement: { getAttribute: (k) => (k === 'data-motion' ? attr : null) } },
    matchMedia: () => { if (throws) throw new Error('x'); return { matches: device }; },
  });
  assert.equal(reducedMotion(win(null, false)), false);
  assert.equal(reducedMotion(win('reduce', false)), true, 'the setting alone');
  assert.equal(reducedMotion(win(null, true)), true, 'the device alone');
  assert.equal(reducedMotion(win('reduce', false, true)), true, 'a throwing matchMedia still sees the setting');
  assert.equal(reducedMotion(win(null, false, true)), false, 'and never throws');
  assert.equal(reducedMotion({ matchMedia: () => ({ matches: true }) }), true, 'a matchMedia-only stub');
  assert.equal(reducedMotion(null), false);
});

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel, out); } else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('no script asks the media query alone: every decision goes through the one helper', () => {
  // The only places allowed to read prefers-reduced-motion directly: the
  // helper itself, the head module's twin of it, the classic-script fallback
  // where the head module is absent, and the kit's own function (apps load
  // it without the shell).
  const allowed = new Map([
    ['frontend/src/lib/reduced-motion.ts', 2], // the answer, and its change listener
    ['public/js/app-view.js', 1],
    ['public/usernode-native/v1/native.js', 2], // read, and its change listener
  ]);
  const files = [...walk('frontend/src'), ...walk('frontend/@'), ...walk('public/js'), 'public/usernode-native/v1/native.js'];
  const offenders = [];
  for (const f of files) {
    const n = (read(f).match(/matchMedia\??\.?\(\s*['"]\(prefers-reduced-motion/g) || []).length;
    if (n !== (allowed.get(f) || 0)) offenders.push(`${f}: ${n}`);
  }
  assert.deepEqual(offenders, [], 'a reduced-motion check that ignores the setting');
  assert.match(read('public/js/app-view.js'), /window\.Display\.reducedMotion\(\)/);
  assert.match(read('public/usernode-native/v1/native.js'), /getAttribute\('data-motion'\) === 'reduce'[\s\S]*?attributeFilter: \['data-motion'\]/, 'and kept current');
});

// ── The Live replay: another document, which follows the setting ────────

test('the replay holds the still glow exactly while motion is reduced, through rebuilds and changes', () => {
  const { syncStillGlow, GLOW_STILL_RULE } = loadTsx('frontend/src/features/app-frame/live-glow.ts');
  const styles = [];
  const doc = {
    documentElement: {},
    head: { appendChild: (el) => { styles.push(el); el.remove = () => styles.splice(styles.indexOf(el), 1); } },
    querySelector: (sel) => (sel === 'style[data-usernode-still-glow]' ? styles[0] || null : null),
    createElement: () => ({ setAttribute() {}, textContent: '' }),
  };
  syncStillGlow(doc, true);
  syncStillGlow(doc, true);
  assert.equal(styles.length, 1, 'one rule, never two');
  assert.equal(styles[0].textContent, GLOW_STILL_RULE);
  syncStillGlow(doc, false);
  assert.equal(styles.length, 0, 'turned off, the glow moves again');
  syncStillGlow(null, true); // no frame yet: nothing to do

  const src = read('frontend/src/features/app-frame/live-band.tsx');
  assert.match(src, /insertStyleRules: REPLAY_RULES,/);
  assert.match(src, /'fullsnapshot-rebuilded'[\s\S]*?syncStillGlow\(replayer\?\.iframe\?\.contentDocument, reducedMotion\(\)\);/,
    'every rebuilt page gets it again');
  assert.match(src, /const offMotion = onReducedMotionChange\(\(\) => \{\s*syncStillGlow\(replayer\?\.iframe\?\.contentDocument, reducedMotion\(\)\);/,
    'and a change applies at once');
  assert.match(src, /return \(\) => \{\s*offMotion\(\);/, 'unsubscribed on unmount');
});

test('onReducedMotionChange hears the attribute and the device, and lets go', () => {
  const { onReducedMotionChange } = loadTsx('frontend/src/lib/reduced-motion.ts');
  const saved = { window: globalThis.window, document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  const observers = [];
  const media = new Set();
  try {
    globalThis.document = { documentElement: {} };
    globalThis.MutationObserver = class {
      constructor(cb) { this.cb = cb; this.on = false; observers.push(this); }
      observe(target, opts) { this.on = true; this.opts = opts; }
      disconnect() { this.on = false; }
    };
    globalThis.window = {
      matchMedia: () => ({ addEventListener: (_t, fn) => media.add(fn), removeEventListener: (_t, fn) => media.delete(fn) }),
    };
    let calls = 0;
    const off = onReducedMotionChange(() => { calls += 1; });
    assert.deepEqual(observers[0].opts.attributeFilter, ['data-motion']);
    observers[0].cb([]);
    for (const fn of media) fn();
    assert.equal(calls, 2);
    off();
    assert.equal(observers[0].on, false);
    assert.equal(media.size, 0);
  } finally {
    Object.assign(globalThis, saved);
    for (const k of Object.keys(saved)) if (saved[k] === undefined) delete globalThis[k];
  }
});
