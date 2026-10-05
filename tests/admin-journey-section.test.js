'use strict';

// The admin Journey section (#3369, slice 2): frontend/src/features/admin/
// admin-journey.tsx, the page over the endpoints slice 1 shipped under
// /api/admin/journey/*.
//
// Text-pinning, in the style of the other admin section tests: the section is
// a React module behind the console's lazily imported barrel, and the
// properties that matter are visible in its source. The payload shapes are
// pinned on the server side by tests/journey-routes.test.js and
// tests/journey-routes-demo.test.js.
//
// What is pinned:
//  - the section is registered everywhere the console looks for one;
//  - it reads only the Journey routes (plus Support's search, to pick a
//    person for the left-out list) and writes only the left-out list;
//  - a reading the platform does not record reads "not recorded yet", and
//    Hear back reads "coming", never a number;
//  - it is drawn as eight chart cards, and every mark carries its count: a
//    percentage only ever sizes a mark, it is never printed;
//  - nothing from the API becomes a link;
//  - the demo payloads ride on ?demo=1, and the demo list cannot be edited;
//  - details open in dialogs, so nothing expands inside the page;
//  - one declared check opens it in a staging preview.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const src = read('frontend/src/features/admin/admin-journey.tsx');
const consoleJs = read('frontend/src/features/admin/admin-console.js');
const sections = read('frontend/src/features/admin/sections.ts');
const audit = read('scripts/audit-react-ownership.mjs');
const manifest = JSON.parse(read('dapp.json'));

test('Journey is registered wherever the console looks for a section', () => {
  assert.match(consoleJs, /\{ key: 'journey', label: 'Journey', group: 'Insights' \}/,
    'a menu entry under Insights');
  assert.match(consoleJs, /journey: 'AdminJourney',/, 'SECTION_MODULES dispatches to the module');
  assert.match(consoleJs, /'journey': '<svg /, 'the menu entry has an icon');
  assert.match(sections, /import '\.\/admin-journey\.tsx';/, 'the lazily imported barrel loads it');
  assert.match(src, /\(window as any\)\.AdminJourney = AdminJourney;/, 'it publishes itself for _renderModule');
  assert.match(src, /mountLegacyPortal\(el, <JourneySection \/>\)/, 'render(host) mounts the React section');
  assert.match(src, /unmountLegacyPortal\(host\)/, 'destroy() unmounts it');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/journey' \}/,
    'the ownership audit scopes the shared host to this route');
  assert.match(audit, /'#admin\/journey'/, 'and visits the route');
});

test('it reads the Journey routes and writes only the left-out list', () => {
  const reads = [...src.matchAll(/'(\/api\/[^'`$?]+)/g)].map((m) => m[1]);
  const templated = [...src.matchAll(/`(\/api\/[^`$?]+)/g)].map((m) => m[1]);
  for (const p of [...reads, ...templated]) {
    assert.ok(p.startsWith('/api/admin/journey/') || p === '/api/admin/support/search',
      `${p} is a Journey route or Support's search`);
  }
  for (const route of ['summary', 'cohorts', 'first-mile', 'stages', 'loops', 'next-steps', 'people/', 'left-out', 'creation', 'pairs']) {
    assert.ok(src.includes(`/api/admin/journey/${route}`), `the page reads ${route}`);
  }
  const writes = [...src.matchAll(/method: '(POST|DELETE|PUT|PATCH)'/g)].map((m) => m[1]);
  assert.deepEqual(writes.sort(), ['DELETE', 'POST'], 'one add and one remove');
  assert.equal((src.match(/fetch\('\/api\/admin\/journey\/left-out', \{/g) || []).length, 1);
  assert.match(src, /fetch\(`\/api\/admin\/journey\/left-out\/\$\{entry\.userId\}`, \{ method: 'DELETE' \}\)/);
});

test('a missing record reads "not recorded yet", and Hear back reads "coming"', () => {
  assert.match(src, /function Num\(\{ v \}: \{ v: Count \}\) \{\n  if \(isNotRecorded\(v\)\) return <span className=\{JUI\.fine\} title=\{v\.reason\}>not recorded yet<\/span>;/,
    'a count that is not recorded never renders as a number');
  assert.match(src, /typeof v === 'number' \? \([\s\S]{0,900}?not recorded yet<\/span>/,
    'a stage that is not recorded draws a dashed "not recorded yet" bar, not an empty one');
  assert.match(src, /\{coming \? 'coming' : String\(v \?\? 0\)\}/, 'a loop step that is coming says so on its node');
  assert.match(src, /const coming = isComing\(v\);/);
  assert.match(src, /\(v as Coming\)\.status === 'coming'/);
});

test('eight chart cards, every mark counted, no percentage printed, no links from data', () => {
  for (const id of ['groups', 'checks', 'mile', 'stages', 'loop', 'invite', 'next', 'coverage', 'team', 'creation', 'pairs']) {
    assert.ok(src.includes(`id="admin-journey-${id}"`), `the ${id} card`);
  }
  for (const line of src.split('\n').filter((l) => l.includes('%'))) {
    assert.match(line, /(width|height): `\$\{[^`]*\}%`/, `a percentage only sizes a mark: ${line.trim()}`);
  }
  assert.match(src, /<Trend trend=\{trend\} shown=\{g\.week\} \/>/, 'the North Star carries its eight weeks');
  assert.match(src, /const STATUS_ORDER: Array<\[string, string\]> = \[/, 'groups sit under one heading per status');
  assert.match(src, /const UNIT_MAX = 24;/, 'small totals are drawn as countable units');
  assert.match(src, /<Ring label="The change loop, turns at each step"/, 'the change loop is drawn as a ring');
  assert.match(src, /<Ring label="The invite loop, people at each step"/, 'and so is the invite loop, on a card of its own');
  assert.match(src, /className=\{JUI\.mileGrid\}/, 'the first-mile staircase and tracks share one grid');
  assert.ok(!/<canvas|from '[^']*chart/i.test(src), 'no chart library: plain elements and one SVG');
  assert.ok(!/<a[\s>]|href=/.test(src), 'nothing is rendered as an anchor');
  assert.match(src, /location\.hash = `#admin\/support\/\$\{p\.userId\}`/,
    'the one jump is to Support, by a numeric id, through the hash');
  assert.ok(!/\bapp\b/.test(src.match(/>[^<{]*</g).join(' ')), 'on screen it says project, not app');
});

test('every first-mile column says what it counts on a tap, and onboard follows act', () => {
  const keys = ['admitted', 'mail_sent', 'code_asked', 'account', 'access', 'opened', 'username', 'join', 'first_act', 'onboard'];
  const help = src.match(/const MILE_HELP: Record<string, string> = \{([\s\S]*?)\n\};/);
  assert.ok(help, 'one table of column notes');
  for (const key of keys) assert.match(help[1], new RegExp(`\\n  ${key}: '`), `${key} has a note`);
  const label = src.match(/function MileLabel\([\s\S]*?\n\}\n/)[0];
  assert.match(label, /<button type="button" className=\{JUI\.mileLabel\} aria-expanded=\{open != null\}/,
    'the label is a button that says whether its note is open');
  assert.match(label, /onClick=\{\(\) => \(open === 'tap' \? onClose\(\) : onOpen\('tap'\)\)\}/, 'a tap opens and closes it');
  assert.match(label, /e\.pointerType === 'mouse'/, 'hover only opens it for a mouse');
  assert.ok(!/title=/.test(label), 'never a title: a phone has no hover');
  assert.match(src, /e\.key === 'Escape'/, 'Escape closes it');
  assert.match(src, /\{labelFor\('onboard', 'onboard'\)\}/, 'onboard is labelled like the steps');
  assert.match(src, /<OnboardCell onboard=\{p\.onboard\} \/>/, 'every track ends in its onboard cell');
  assert.match(src, /repeat\(10,minmax\(0,1fr\)\)/, 'the grid has the tenth column');
});

test('the demo rides on ?demo=1 and cannot be edited', () => {
  assert.match(src, /new URLSearchParams\(location\.search\)\.get\('demo'\) === '1'/);
  assert.match(src, /`\$\{path\}\$\{path\.includes\('\?'\) \? '&' : '\?'\}demo=1`/);
  assert.match(src, /const canWrite = !DEMO && !!consoleApi\(\)\?\.canWrite\?\.\(\);/,
    'the left-out controls need a full admin and real data');
  assert.match(src, /\{s\?\.demo \? <span className=\{AdminUI\.badge\.warn\}>demo<\/span> : null\}/);
});

test('details open in dialogs, one at a time on top', () => {
  for (const id of ['names', 'leftout', 'checks']) {
    assert.ok(src.includes(`id="admin-journey-${id}-dialog"`), `${id} is a dialog`);
  }
  assert.match(src, /if \(open\[open\.length - 1\] === panel\.current\) onClose\(\);/,
    'Escape closes only the topmost dialog');
  assert.ok(!src.includes('_confirm('), 'confirmations stay inside the dialog');
});

test('filters: all time or a week, everyone or one cohort; a person gets a view of their own', () => {
  assert.match(src, /useState<Scope>\(\{ week: 'all', cohort: null \}\)/, 'the default is all time, for everyone');
  assert.match(src, /if \(week\) q\.set\('week', scope\.week\);\n  if \(scope\.cohort\) q\.set\('cohort', scope\.cohort\);/,
    'the summary, stages and loops reads carry the scope');
  for (const read of ['summary', 'stages', 'loops', 'creation', 'pairs', 'first-session']) {
    assert.ok(src.includes(`scoped('/api/admin/journey/${read}', scope)`), `${read} follows the filters`);
  }
  assert.match(src, /\{person != null \? <PersonView userId=\{person\}/, 'one person replaces the cards');
  assert.match(src, /\{scope\.cohort \? null : \(?\s*<div id="admin-journey-checks"/,
    'the platform-wide checks leave a cohort view instead of reading as the cohort\'s');
  assert.match(src, /\{scope\.cohort \? null : <div className="mt-1 mb-4" id="admin-journey-team">/);
});

test('the creation path and the pairs: steps against targets, by week, and the aha out of second members', () => {
  assert.match(src, /<CreationCard scope=\{scope\} onOpen=\{openPerson\} \/>\n\s*<FirstSessionCard scope=\{scope\} onOpen=\{openPerson\} \/>\n\s*<PairsCard scope=\{scope\} onOpen=\{openPerson\} \/>/,
    'both sit under the first mile and follow the filters, with the first session between them');
  for (const [key, label] of [['created', 'Created'], ['running', 'Running'], ['first_version', 'First version ready'],
    ['preview', 'Preview opened'], ['change_live', 'Requested change live']]) {
    assert.ok(src.includes(`['${key}', '${label}', `), `the ${label} step`);
  }
  assert.match(src, /\{shown == null \? <Num v=\{st\.reached\} \/>/, 'a step not recorded yet reads so, never 0');
  assert.match(src, /if \(!cell \|\| isNotRecorded\(cell\.reached\)\) \{/, 'and so does a week before it was recorded');
  assert.match(src, /id="admin-journey-creation-weeks"/, 'by week');
  assert.match(src, /median <span className=\{targetTone\(st\.medianSeconds, st\.targetSeconds\)\}>/,
    'each step\'s median, coloured against its target');
  assert.match(src, /id="admin-journey-pairs-count" className=\{JUI\.headline\}>\{data\.count\}</);
  assert.match(src, /of \{plural\(data\.of, 'project', 'projects'\)\} that got a second member/);
  assert.match(src, /<Trend trend=\{data\.trend\} shown=\{data\.week === 'all' \? last : data\.week\} label="Pairs" \/>/,
    'a small weekly trend');
  assert.match(src, /data-journey-pair=\{e\.slug\}/, 'and a few example rows');
});

test('the first session: a maker\'s and an invited person\'s first hour, timed from its start', () => {
  for (const [key, label] of [['reward', 'Sketch shown'], ['invited', 'Invite sent'], ['running', 'Running'],
    ['said', 'Wrote in its chat'], ['suggested', 'Filed a request']]) {
    assert.ok(src.includes(`${key}: ['${label}', `), `the ${label} step`);
  }
  assert.match(src, /\{data\.make\.notRecorded \? <Num v=\{data\.make\.notRecorded\} \/>/,
    'before projects from the first session were marked, it reads so, never 0');
  assert.match(src, /of \$\{plural\(data\.make\.people, 'maker', 'makers'\)\} sent an invite within \$\{minutes\} min/);
  assert.match(src, /of \$\{plural\(data\.join\.people, 'person', 'people'\)\} wrote or asked for something within \$\{minutes\} min/);
  assert.match(src, /Invite links opened: <Num v=\{data\.opens\.opened\} \/> · joined: \{data\.opens\.joined\}/,
    'opens beside joins, and opens before they were counted read so');
  assert.match(src, /median <span className=\{targetTone\(st\.medianSeconds, st\.targetSeconds\)\}>/);
  assert.match(src, /data-journey-first-session-example=\{e\.path\}/, 'and the newest few');
});

test('one declared check opens the demo page', () => {
  const checks = manifest.tests.filter((t) => t.path === '/?demo=1#admin/journey');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].expectSelector, '#admin-journey-north-star');
});
