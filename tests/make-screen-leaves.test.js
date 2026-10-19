// New project's screen and its "Who says yes?" sheet leave the way they came,
// and the screen keeps what you started (polish board #8 and N9, 19 Oct 2026).
//
//   1. #8: the sheet slid up over 200ms and the screen rose over 300ms, and
//      every way out unmounted them in the frame it was pressed: they
//      vanished. Each now animates out first and goes on its transitionend,
//      or a timer a little past it; with reduced motion, at once.
//   2. N9: a pick that grows the form scrolled it so the screen's top edge
//      cut "What do you want to make?" in half. A reveal that would stop
//      inside the heading goes on to its foot.
//   3. N9: ✕ threw away a filled form. From Create the form is kept for the
//      page's life and opens filled the next time; making the project, or
//      leaving it empty, clears it.
//
// Run with: node --test tests/make-screen-leaves.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const MAKE = read(`${DIR}/make.tsx`);
const RULE = read('frontend/src/features/who-decides/make-rule.tsx');
const ENGLISH_HOOK = { useMessages: () => message, RichMessage: () => null, Message: () => null };

// ── 1. #8: out the way they came in ────────────────────────────────────

test('"Who says yes?" slides down before it goes, by every way out', () => {
  const sheet = RULE.slice(RULE.indexOf('function PresetsSheet('), RULE.indexOf('export function MakeRuleLine('));
  // Every way out is `close`, which slides it down; `onGone` unmounts it after.
  assert.match(sheet, /<div aria-hidden="true" onClick=\{close\}/, 'the scrim');
  assert.match(sheet, /<button type="button" onClick=\{close\} aria-label=\{t\('onboarding:firstSession\.make\.rule\.close'\)\}/, 'the ✕');
  assert.match(sheet, /onClick=\{\(\) => \{ if \(changed\) onPick\(picked\); close\(\); \}\}/, 'Done, or Use: the pick lands, then it slides');
  assert.match(sheet, /if \(e\.key === 'Escape'\) closeRef\.current\(\);/, 'Escape');
  assert.doesNotMatch(sheet, /onClose/, 'nothing takes it off the page at once');
  // The slide: the same transition it came in on, run backwards.
  assert.match(sheet, /setShown\(false\);/);
  assert.match(sheet, /transition-transform duration-200 ease-out \$\{shown \? 'translate-y-0' : 'translate-y-full'\}/);
  // Gone on its own transitionend, or the timer, whichever comes first; at once with reduced motion.
  assert.match(sheet, /if \(e\.target === panel && e\.propertyName === 'transform'\) gone\(\);/);
  assert.match(sheet, /window\.setTimeout\(gone, SHEET_SLIDE_MS \+ 60\);/);
  assert.match(sheet, /if \(reducedMotion\(\) \|\| !panel\) \{ goneRef\.current\(\); return; \}/);
  assert.match(RULE, /<PresetsSheet now=\{preset\} viewer=\{viewer\} onPick=\{onPick\} onGone=\{\(\) => setOpen\(false\)\} \/>/,
    'the portal unmounts only once the sheet is gone');
  const { SHEET_SLIDE_MS } = loadTsx('frontend/src/features/who-decides/make-rule.tsx');
  assert.equal(SHEET_SLIDE_MS, 200, 'the duration-200 it slides on');
});

test('New project falls back and fades before it goes', () => {
  // ✕ and Escape leave; onClose only after the fade.
  assert.match(MAKE, /data-make-close=""\s*onClick=\{leave\}/);
  assert.match(MAKE, /if \(e\.key === 'Escape'\) leave\(\);/);
  assert.match(MAKE, /const motion = arrived && !leaving \? ARRIVED : ARRIVING;/, 'the form goes back down the way it rose');
  assert.match(MAKE, /root\.style\.transition = `opacity \$\{MAKE_LEAVE_MS\}ms ease-in`;\s*root\.style\.opacity = '0';\s*root\.style\.pointerEvents = 'none';\s*setLeaving\(true\);/);
  assert.match(MAKE, /if \(e\.target === root && e\.propertyName === 'opacity'\) gone\(\);/);
  assert.match(MAKE, /window\.setTimeout\(gone, MAKE_LEAVE_MS \+ 80\);/);
  assert.match(MAKE, /if \(still \|\| !root\) \{ close\(\); return; \}/, 'reduced motion: at once');
  // The ARRIVING classes keep motion-reduce, so the fall is still with it.
  assert.match(MAKE, /const ARRIVING = 'translate-y-6 opacity-0 transition-\[transform,opacity\] duration-300 ease-out motion-reduce:transition-none';/);
});

// ── 2. N9: the heading is whole or out of view ─────────────────────────

test('a reveal never stops inside the heading', () => {
  const { clearOfHeading } = loadTsx(`${DIR}/make.tsx`, { stubs: { '../../lib/i18n/react': ENGLISH_HOOK } });
  // The heading's two lines sit at 40..108 in the scroller's content.
  assert.equal(clearOfHeading(70, 40, 108, 600), 108, 'mid-heading: on to its foot, so Make it is still in view');
  assert.equal(clearOfHeading(20, 40, 108, 600), 20, 'above it: the heading is whole');
  assert.equal(clearOfHeading(40, 40, 108, 600), 40, 'at its top: whole');
  assert.equal(clearOfHeading(108, 40, 108, 600), 108, 'at its foot: out of view');
  assert.equal(clearOfHeading(200, 40, 108, 600), 200, 'past it');
  assert.equal(clearOfHeading(70, 40, 108.4, 600), 109, 'a part pixel rounds out of view');
  assert.equal(clearOfHeading(70, 40, 108, 90), 90, 'never past the end of the scroll');
  // Wired into the pick's reveal.
  assert.match(MAKE, /const heading = scroller\.querySelector\('#first-session-make-title'\)\?\.getBoundingClientRect\(\);/);
  assert.match(MAKE, /clearOfHeading\(reveal, heading\.top - view\.top \+ scroller\.scrollTop, heading\.bottom - view\.top \+ scroller\.scrollTop,/);
});

// ── 3. N9: what you started is kept ────────────────────────────────────

test('a form left from Create is kept and opens filled; a made project clears it', () => {
  const { draftWorthKeeping } = loadTsx(`${DIR}/make.tsx`, { stubs: { '../../lib/i18n/react': ENGLISH_HOOK } });
  const empty = { brief: '', name: '', nameTyped: false, picked: null, choice: '', words: '', written: null, rule: 'you_or_the_group' };
  assert.equal(draftWorthKeeping(empty), null, 'nothing started: nothing kept');
  assert.equal(draftWorthKeeping({ ...empty, brief: '   ' }), null);
  assert.equal(draftWorthKeeping(null), null);
  for (const filled of [{ brief: 'A chore wheel' }, { name: 'Flat 4B' }, { words: 'hikes' }, { picked: {} }, { rule: 'everyone' }]) {
    assert.ok(draftWorthKeeping({ ...empty, ...filled }), JSON.stringify(Object.keys(filled)));
  }

  // Read once at mount, for Create only, and not over the import form.
  assert.match(MAKE, /const \[draft\] = useState\(\(\) => \(fromCreate && !startImport && keptDraft\?\.who === who \? keptDraft : null\)\);/,
    'only the person who left it gets it back');
  for (const field of ['brief', 'name', 'picked', 'choice', 'words', 'written', 'nameTyped', 'rule']) {
    assert.match(MAKE, new RegExp(`useState[^\\n]*\\(draft \\? draft\\.${field} : `), `${field} opens as it was left`);
  }
  // Kept whichever way the screen goes (✕, Escape, the header, a route), and
  // cleared when the project was made, by either door.
  assert.match(MAKE, /useEffect\(\(\) => \(\) => \{\s*if \(!fromCreate\) return;\s*const kept = madeRef\.current \? null : draftWorthKeeping\(formRef\.current\);\s*keptDraft = kept \? \{ \.\.\.kept, who: whoRef\.current \} : null;\s*\}, \[fromCreate\]\);/);
  assert.equal((MAKE.match(/madeRef\.current = true;\s*onMade\(/g) || []).length, 2, 'Make it and Import it');
});
