'use strict';

// The admin Journey section: frontend/src/features/admin/admin-journey.tsx,
// which since the Growth dashboard draws admin-growth.tsx over one reading,
// GET /api/admin/journey/growth (src/services/growth.js), and keeps Journey's
// person view and Left out list.
//
// Text-pinning, in the style of the other admin section tests: the section is
// a React module behind the console's lazily imported barrel, and the
// properties that matter are visible in its source. The reading itself is
// pinned by tests/growth.test.js.
//
// What is pinned:
//  - the section is registered everywhere the console looks for one;
//  - it reads only Journey routes (plus Support's search, to pick a person)
//    and writes only the left-out list;
//  - every label in Growth says what it counts on a tap, never on hover;
//  - nothing from the API becomes a link, and no chart library is loaded;
//  - the demo rides on ?demo=1, and the demo list cannot be edited;
//  - a person opens in Journey's own person view;
//  - one declared check opens it in a staging preview.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const src = read('frontend/src/features/admin/admin-journey.tsx');
const growth = read('frontend/src/features/admin/admin-growth.tsx');

function binLabelOf(lo, next) {
  const src = growth.match(/function binLabel\(lo: number, next: number \| undefined\): string \{([\s\S]{0,400}?)\n\}/)[1]
    .replace(/: number/g, '').replace(/: string/g, '');
  return new Function('lo', 'next', src)(lo, next);
}
const consoleJs = read('frontend/src/features/admin/admin-console.js');
const sections = read('frontend/src/features/admin/sections.ts');
const audit = read('scripts/audit-react-ownership.mjs');
const manifest = JSON.parse(read('dapp.json'));

test('Journey is registered wherever the console looks for a section', () => {
  assert.match(consoleJs, /\{ key: 'journey', label: 'Journey', group: 'Growth' \}/,
    'a menu entry under Insights');
  assert.match(consoleJs, /journey: 'AdminJourney',/, 'SECTION_MODULES dispatches to the module');
  assert.match(consoleJs, /'journey': '<svg /, 'the menu entry has an icon');
  assert.match(sections, /import '\.\/admin-journey\.tsx';/, 'the lazily imported barrel loads it');
  assert.match(src, /\(window as any\)\.AdminJourney = AdminJourney;/, 'it publishes itself for _renderModule');
  assert.match(src, /mountLegacyPortal\(el, <JourneySection \/>\)/, 'render(host) mounts the React section');
  assert.match(src, /unmountLegacyPortal\(host\)/, 'destroy() unmounts it');
  assert.match(src, /import \{ Growth, type GrowthData \} from '\.\/admin-growth';/, 'it draws the Growth views');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/journey' \}/,
    'the ownership audit scopes the shared host to this route');
  assert.match(audit, /'#admin\/journey'/, 'and visits the route');
});

test('it reads Journey routes and writes only the left-out list', () => {
  const both = `${src}\n${growth}`;
  const reads = [...both.matchAll(/'(\/api\/[^'`$?]+)/g)].map((m) => m[1]);
  const templated = [...both.matchAll(/`(\/api\/[^`$?]+)/g)].map((m) => m[1]);
  for (const p of [...reads, ...templated]) {
    assert.ok(p.startsWith('/api/admin/journey/') || p === '/api/admin/support/search',
      `${p} is a Journey route or Support's search`);
  }
  assert.ok(src.includes("useJourney<GrowthData>('/api/admin/journey/growth')"), 'one reading behind every view');
  assert.ok(growth.includes('`/api/admin/journey/growth/groups/${group.appId}`'), 'a group\'s sessions on demand');
  for (const route of ['people/', 'left-out']) {
    assert.ok(src.includes(`/api/admin/journey/${route}`), `the page still reads ${route}`);
  }
  const writes = [...both.matchAll(/method: '(POST|DELETE|PUT|PATCH)'/g)].map((m) => m[1]);
  assert.deepEqual(writes.sort(), ['DELETE', 'POST'], 'one add and one remove, both on the left-out list');
});

test('every Growth label says what it counts on a tap, never on hover', () => {
  const help = growth.match(/const HELP: Record<string, string> = \{([\s\S]*?)\n\};/);
  assert.ok(help, 'one table of what each label counts');
  const ids = [...growth.matchAll(/term\('([a-zA-Z0-9]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 20, 'the labels are terms');
  for (const id of new Set(ids)) assert.match(help[1], new RegExp(`\\n  ${id}: '`), `${id} has its words`);
  for (const step of [0, 1, 2, 3, 4]) assert.match(help[1], new RegExp(`\\n  s${step}: '`), `funnel step ${step} has its words`);
  assert.match(growth, /aria-expanded=\{open === id\} data-growth-term=\{id\}\n\s+onClick=\{\(\) => setOpen\(open === id \? null : id\)\}/,
    'a term is a button that opens and closes its words');
  assert.ok(!/<[a-z][^>]*\stitle=/.test(growth), 'never a title attribute: a phone has no hover');
});

test('the filters: view, when, who, and who is left out', () => {
  for (const f of ['view', 'when', 'who', 'left-out']) assert.ok(growth.includes(`data-growth-filter="${f}"`), `the ${f} row`);
  for (const v of ['Overview', 'Activity', 'Groups', 'Sources', 'Scope']) assert.ok(growth.includes(`'${v}']`), `the ${v} view`);
  assert.match(growth, /useState<Who>\('newcomers'\)/, 'newcomers by default');
  assert.match(growth, /Without early members · \{counts\.newcomers\}/);
  assert.match(growth, /Including early members · \{counts\.all\}/);
  // Newcomers brought in by early members are newcomers, left out by default:
  // an admit day says how many came in all ("30 of 36").
  assert.match(growth, /Newcomer, brought in by an early member/);
  assert.match(growth, /function BroughtToo\(/);
  assert.match(growth, /<BroughtToo r=\{r\} list=\{data\.people\.filter/);
  assert.doesNotMatch(growth, /Excluding Season 1|Including Season 1/, 'early members, not Season 1, name the filter');
});

test('groups: how many of the groups each person acts in', () => {
  assert.ok(growth.includes('id="admin-growth-overlap"'), 'the card');
  assert.match(growth, /<GroupOverlap data=\{data\} list=\{list\} \/>/, 'above the groups table, from the same groups in scope');
  assert.match(growth, /\[20, Infinity, '20 or more'\]/, 'bins up to 20 or more');
  assert.ok(growth.includes('data-growth-overlap-summary'), 'groups each, and the busiest ten, in words');
});

test('activity: time in an app, either side of the 30-second line', () => {
  assert.ok(growth.includes('id="admin-growth-time"'), 'the card');
  assert.match(growth, /<TimeInApp data=\{data\} r=\{r\} \/>/, 'drawn on the Activity view');
  assert.ok(growth.includes('data-growth-hist={id}'), 'two histograms share one drawing');
  assert.match(growth, /label: 'No app time'/, 'opened but never in an app has its own column');
  assert.match(growth, /const under = \(i: number\) => bins\[i\] < data\.staySeconds;/, 'the line is the Stayed bar, read from the payload');
  assert.ok(growth.includes('data-growth-time-gap'), 'the gap either side of the line, in words');
  assert.equal(binLabelOf(1, 5), '1–4 s');
  assert.equal(binLabelOf(30, 60), '30–59 s');
  assert.equal(binLabelOf(120, 300), '2–5 min');
  assert.equal(binLabelOf(900, undefined), '15 min+');
  assert.match(growth, /useState<When>\(\{ kind: 'all', week: lastWeek \}\)/, 'since the era by default');
  assert.match(growth, />Last 4 weeks</);
  assert.match(growth, /aria-label="Week before"/);
  assert.match(growth, /aria-label="Week after"/);
});

test('the overview: a north star, a funnel with a cohort on top, and the people behind a step', () => {
  assert.ok(growth.includes('id="admin-journey-north-star"'), 'the tiles keep the declared check\'s anchor');
  assert.match(growth, /term\('together', 'Active groups'\)/, 'and its words');
  assert.match(growth, /const STEPS = \['Let in', 'Opened Homeroom', 'Stayed 30 s\+', 'Used it with a group', 'Came back together'\];/);
  assert.match(growth, /<Count row \{\.\.\.stepOf\(i\)\} className="relative block h-11">/, 'a step opens its people');
  assert.match(growth, /kicker: 'Reached this step', title: STEPS\[i\], list: atStep\(i\)/);
  assert.match(growth, /onClick=\{\(\) => onOpenPerson\(p\.userId!\)\}/, 'a person still opens on its own page');
  assert.match(growth, /const SAVED_KEY = 'homeroom\.admin\.growth\.cohorts';/, 'saved cohorts stay in this browser');
});

test('every number or bar that counts people opens them in one sidebar', () => {
  assert.match(growth, /const PeopleCtx = createContext</, 'one sidebar for the page');
  assert.match(growth, /<PeopleDrawer key=\{shown\.seq\}/);
  assert.match(growth, /disabled=\{!list\.length\}/, 'an empty count opens nothing');
  // Each place a count is drawn: its Count, so a tap lists exactly those people.
  for (const kicker of ['Admit mail', 'Stopped here', 'First active', 'Weeks active, last 4', 'Last 7 days',
    "In Analytics' WAU", 'Group', 'Heard about it', 'Way in', 'Admit day', 'This scope']) {
    assert.ok(growth.includes(`kicker="${kicker}"`) || growth.includes(`kicker: '${kicker}'`), `${kicker} opens its people`);
  }
  assert.match(growth, /<Bars values=\{vals\} labels=\{labels\} fade=\{fade\} tone=\{tone\} lists=\{lists\} \/>/, 'every weekly bar');
  assert.match(growth, /aria-label="Previous person"/);
  assert.match(growth, /aria-label="Next person"/);
  assert.match(src, /renderPerson=\{\(id\) => <PersonView userId=\{id\} onBack=\{NOOP\} onName=\{NOOP\} embedded \/>\}/,
    'a person opens in Journey\'s own view, inside the sidebar');
});

test('Analytics\' WAU is broken down by what its people did', () => {
  assert.match(growth, /term\('wauDid', 'What they did in those 7 days'\)/);
  for (const row of ['Acted: wrote, voted or built', 'Stayed 30 s+, no act', 'Glanced: under 30 s, or kudos']) assert.ok(growth.includes(`'${row}'`), row);
});

test('nothing from the API is a link, and no chart library is loaded', () => {
  for (const [name, text] of [['journey', src], ['growth', growth]]) {
    assert.ok(!/<a[\s>]|href=/.test(text), `${name}: nothing is rendered as an anchor`);
    assert.ok(!/<canvas|from '[^']*chart/i.test(text), `${name}: plain elements, no chart library`);
    assert.ok(!/\bapp\b/.test((text.match(/>[^<{]*</g) || []).join(' ')), `${name}: on screen it says project, not app`);
  }
});

test('the demo rides on ?demo=1 and cannot be edited', () => {
  assert.match(src, /new URLSearchParams\(location\.search\)\.get\('demo'\) === '1'/);
  assert.match(src, /`\$\{path\}\$\{path\.includes\('\?'\) \? '&' : '\?'\}demo=1`/);
  assert.match(src, /const canWrite = !DEMO && !!consoleApi\(\)\?\.canWrite\?\.\(\);/,
    'the left-out controls need a full admin and real data');
  assert.match(growth, /\{data\.demo \? <span className=\{AdminUI\.badge\.warn\}>demo<\/span> : null\}/);
});

test('a person gets a view of their own, and the Left out list stays a dialog', () => {
  assert.match(src, /\{person != null \? \(/);
  assert.match(src, /<PersonView userId=\{person\} onBack=\{\(\) => setPerson\(null\)\} onName=\{setPersonName\} \/>/);
  assert.match(src, /<PersonSearch onPick=\{openPerson\} \/>/);
  assert.match(src, /\{leftOut \? <LeftOutDialog onOpen=\{openPerson\} onClose=\{closeLeftOut\} \/> : null\}/);
  assert.ok(src.includes('id="admin-journey-leftout-dialog"'), 'the left-out list is a dialog');
  assert.match(src, /if \(open\[open\.length - 1\] === panel\.current\) onClose\(\);/,
    'Escape closes only the topmost dialog');
  assert.match(src, /location\.hash = `#admin\/support\/\$\{p\.userId\}`/,
    'the one jump is to Support, by a numeric id, through the hash');
});

test('one declared check opens the demo page', () => {
  const checks = manifest.tests.filter((t) => t.path === '/?demo=1#admin/journey');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].expectSelector, '#admin-journey-north-star');
  assert.equal(checks[0].expectText, 'Active groups');
});

test('where a person came from stays on their view (#6540)', () => {
  assert.match(src, /\{section\('Came from', \(p\.cameFrom\?\.invite \|\| p\.cameFrom\?\.waitlist\) \? \(/);
  assert.match(src, /data-journey-came-from="invite"/);
  assert.match(src, /data-journey-came-from="waitlist"/);
  assert.match(src, /\) : <Empty>Not recorded\.<\/Empty>\)\}/, 'neither record says Not recorded');
  assert.match(src, /if \(host === 'none'\) return 'no referrer';/);
  assert.match(src, /if \(via === 'copied'\) return 'link was copied';/);
  assert.match(src, /if \(via === 'shared'\) return 'link was shared';/);
});
