// The challenge detail PAGE, rendered.
//
// WHAT THIS PINS. The detail is a level of the Leaderboard screen, drawn below
// the platform header, which is its nav bar (the chevron up to the grid and
// the word "Challenge", set by the controller). Since the Semi design
// (2026-10-16) it holds, in this order: the title, its points, the artwork,
// the rail, the organiser's task line, the action and "What counts" — no
// category eyebrow, deadline, description, Scoring or participants. The task
// line came back (#6592): it says what to do to start and finish. So did the
// time of the next count, in plain words under the rail (#6895): a challenge
// counted on a schedule says when progress was last counted and when the next
// count is due, or that it is due now. The render half asserts that order and
// the parts it is made of; the source half asserts what makes it a level
// rather than an overlay — in flow, the grid and the screen's own tabs and
// event bar stepping aside, and no back control of its own — because none of
// that shows in static markup. The artwork well is drawn only for an
// illustration the registry resolves: a built-in, or an upload on its payload
// tone.
//
// Run with: node --test tests/challenge-detail-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const PANE_PATH = 'frontend/src/features/leaderboard/challenges-pane.tsx';
const Pane = loadTsx(PANE_PATH);
const src = fs.readFileSync(path.join(__dirname, '..', PANE_PATH), 'utf8');
const screenSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/leaderboard/index.tsx'), 'utf8');

const VIEW = {
  key: '5',
  amount: { text: '720 pts so far', earned: false },
  goal: 'Join block production',
  illustration: 'block-production',
  illustrationTone: null,
  state: 'progress',
  stateLabel: '180/500 blocks',
  fill: 0.36,
  counted: true,
  cta: { kind: 'link', href: 'https://example.com/node', label: 'Set up your node' },
  requirements: 'A node reachable all week, on-device or delegated.',
};

const render = (view) => renderToHtml(createElement(Pane.DetailPage, { view }));

test('the page reads: title, points, artwork, rail, action, What counts', () => {
  const html = render(VIEW);
  const order = [
    '<h2', '>720 pts so far<',
    'src="/illustrations/challenges/block-production.svg"', 'role="progressbar"', 'href="https://example.com/node"',
    '>What counts<', 'A node reachable all week',
  ];
  let at = -1;
  for (const needle of order) {
    const i = html.indexOf(needle);
    assert.ok(i > at, `${needle} comes after the part before it`);
    at = i;
  }
  assert.doesNotMatch(html, /Next:/, 'no "Next:" hint (owner decision)');
  assert.doesNotMatch(html, /title=/, 'no tooltips');
  assert.doesNotMatch(html, /tc-se-detail-close|aria-label="Back"|×/,
    'no back control of its own: the platform header carries the way back');
});

test('the page leaves out the eyebrow, time, description, Scoring and participants', () => {
  // Handed every field the page used to draw, it draws none of them.
  const html = render({
    ...VIEW, eyebrow: 'ONBOARDING', deadline: '3d left', ends: 'ends Mon 12 Oct, 02:00', cadence: 'next count 9:37',
    description: 'Run a node that produces blocks.',
    scoring: 'Points scale with the blocks you produce.', participants: 'Participants · 34',
    pointsTotal: '12,800 pts between them', moreLabel: 'Show all 34 →',
    entries: { kind: 'list', hasMore: true, rows: [{ key: '1|0', userId: 1, name: 'Iso Nakamura', nonPodium: false, points: '2,000 pts' }] },
  });
  for (const gone of ['ONBOARDING', '3d left', 'ends Mon', 'next count', 'Run a node', 'Scoring',
    'Participants', 'between them', 'Iso Nakamura', 'tc-se-breakdown-more', 'tc-se-entry', 'uppercase']) {
    assert.ok(!html.includes(gone), `no ${gone}`);
  }
  for (const gone of ['EntriesSkeleton', 'function Entries', 'ProfileBody', 'tc-se-profile-overlay', '_moreBreakdown',
    'openUserProfile', 'EYEBROW']) {
    assert.ok(!src.includes(gone), `${gone} is gone from the pane`);
  }
});

test('the task line sits under the rail, before the action and What counts (#6592)', () => {
  const task = 'Open any app somebody else made and use it for 10 minutes in total.';
  const html = render({ ...VIEW, task });
  const at = html.indexOf('<p class="text-sm text-zinc-600 dark:text-zinc-400" data-challenge-task="true">');
  assert.ok(at !== -1, 'the task is plain prose, with no heading and no box');
  const rail = html.indexOf('role="progressbar"');
  const cta = html.indexOf('href="https://example.com/node"');
  const counts = html.indexOf('>What counts<');
  assert.ok(at > rail, 'after the progress rail');
  assert.ok(at < cta, 'before the action');
  assert.ok(at < counts, 'before What counts');
  assert.ok(html.includes(`>${task}<`), 'the organiser’s words exactly as written');
});

test('a page with no task draws no task line', () => {
  const html = render({ ...VIEW, task: null });
  assert.doesNotMatch(html, /data-challenge-task/);
  assert.doesNotMatch(render(VIEW), /data-challenge-task/, 'and a descriptor without the field behaves the same');
});

test('the parts: the points line and clean rail at page size, a full-width action', () => {
  const html = render(VIEW);
  assert.match(html, /<h2 id="tc-se-detail-title" tabindex="-1"/, 'the title names the level and takes focus');
  assert.match(html, /role="progressbar"[^>]*class="[^"]*h-10/, 'the rail at page size');
  assert.match(html, /style="width:max\(0\.375rem, 36%\)"/, 'counted: the card’s bar');
  assert.doesNotMatch(html.slice(html.indexOf('role="progressbar"'), html.indexOf('href=')), /pts/,
    'the rail holds the state and nothing else');
  assert.match(html, /<div class="min-w-0 truncate text-sm font-medium leading-5 text-amber-800 dark:text-amber-300">720 pts so far<\/div>/,
    'the points under the title, alone on their line');
  assert.match(render({ ...VIEW, amount: { text: '900 pts', earned: true } }),
    /text-emerald-700 dark:text-emerald-400">900 pts<\/div>/, 'earned: emerald, without the word');
  assert.match(html, /<a href="https:\/\/example\.com\/node" target="_blank" rel="noopener" class="flex h-12 w-full/);
});

test('optional parts drop out cleanly', () => {
  const html = render({
    ...VIEW, amount: null, illustration: null, cta: { kind: 'text', label: 'Go' }, requirements: null,
  });
  assert.doesNotMatch(html, /<a /, 'a scheme-rejected action is text, never an anchor');
  assert.match(html, /\(link unavailable\)/);
  assert.doesNotMatch(html, /What counts|text-amber-800|<img|h-56/);
});

test('the artwork well: only for a registry illustration, on its tone, and dropped if it fails to load', () => {
  const html = render(VIEW);
  assert.ok(html.includes(
    '<div class="home-tone-mint flex h-56 w-full items-center justify-center rounded-2xl bg-[var(--tint-art)]">'
    + '<img src="/illustrations/challenges/block-production.svg" alt="" draggable="false" class="h-48 w-48 object-contain"/></div>'),
  'a full-width 224px well on the artwork’s tone, the art centred at 192px');

  // An upload: the path derived from its slug, fitted into the same box, on
  // the payload's tone, or gray without one the registry knows.
  const HEX = 'fedcba9876543210fedcba9876543210';
  const uploaded = (illustrationTone) => render({ ...VIEW, illustration: `u-${HEX}`, illustrationTone });
  assert.ok(uploaded('sage').includes(
    '<div class="home-tone-sage flex h-56 w-full items-center justify-center rounded-2xl bg-[var(--tint-art)]">'
    + `<img src="/challenge-illustrations/${HEX}" alt="" draggable="false" class="h-48 w-48 object-contain"/></div>`),
  'an uploaded illustration in the same well, on its tone');
  for (const tone of [null, 'not-a-tone']) {
    assert.match(uploaded(tone), /<div class="home-tone-gray flex h-56/, `${tone}: an upload with no known tone is on gray`);
  }
  assert.match(render({ ...VIEW, illustrationTone: 'coral' }), /<div class="home-tone-mint flex h-56/,
    'a built-in keeps its own tone');

  for (const illustration of [null, 'not-in-the-registry', '../../icons/x', 'u-XYZ', `u-${HEX.toUpperCase()}`]) {
    assert.doesNotMatch(render({ ...VIEW, illustration }), /<img|h-56|tint-art/,
      `${illustration}: no well at all, never an empty one`);
  }
  // onError cannot fire in a static render, so the drop is pinned on the source.
  const well = src.slice(src.indexOf('function ArtworkWell('), src.indexOf('export function DetailPage('));
  assert.ok(well.length > 0, 'ArtworkWell located');
  assert.match(well, /resolveIllustration\(slug, tone\)/, 'the well resolves with the payload tone');
  assert.match(well, /onError=\{\(\) => setFailed\(art\.src\)\}/);
  assert.match(well, /if \(!art \|\| failed === art\.src\) return null;/);
  assert.doesNotMatch(src, /until challenges carry illustrations/, 'the reservation note is retired with the reservation');
});

test('a level of the screen, not an overlay: in flow, the rest of the screen steps aside', () => {
  const root = src.slice(src.indexOf('{/* Challenge detail page */}'));
  assert.ok(root.length > 0, 'detail root located');
  assert.match(root, /id="tc-se-detail-overlay"\s+className=\{state\.detail \? PAGE : `hidden \$\{PAGE\}`\}/);
  assert.match(root, /id="tc-se-detail-panel"/);
  assert.doesNotMatch(root, /onClick|ref=/, 'no backdrop and no plumbing');
  assert.match(src, /const PAGE = 'mx-auto w-full max-w-lg';/, 'a column in the screen, which scrolls it');
  assert.doesNotMatch(src, /CircleButton|touchstart|inert=|aria-modal|fixed inset-0 z-50 bg-zinc-100/,
    'the platform header is the nav bar, and nothing sits over the screen to guard or trap');
  assert.match(src, /<div id="tc-se-grid" className=\{state\.detail \? 'hidden' : undefined\}>/,
    'the grid steps aside while a page is open');
  // (#5249: and while kudos is parked, a person's page in the Kudos section,
  // which is a level of its own too.)
  assert.match(screenSrc, /<div className=\{detailOpen \|\| \(KUDOS_PARKED && section === 'kudos'\) \? 'hidden' : section === 'kudos' \? KUDOS_COLUMN : undefined\}>/,
    'and so do the screen’s own title, tabs and event bar');
  assert.match(src, /if \(e\.key === 'Escape'\) controller\(\)\?\.handleBack\(\);/, 'Escape goes back up on a keyboard');
  // The screen's scroller is the page's: a page opens at its top and the grid
  // comes back where it was left, restored BEFORE the tracker reads it again.
  const restore = src.indexOf('else if (wasOpen.current) el.scrollTop = gridScroll.current;');
  const tracker = src.indexOf("target.addEventListener('scroll', track, { passive: true });");
  assert.ok(restore > 0 && tracker > restore, 'restore, then track');
  assert.match(src, /if \(openKey != null\) el\.scrollTop = 0;/);
  assert.equal((src.match(/href=\{/g) || []).length, 1, 'still exactly one href, the guarded action');
});

// #6895: the scheduled-count line, right under the rail, in the same small
// grey note the points line uses.
test('the scheduled-count line sits under the rail, before the task and the action (#6895)', () => {
  const note = message('leaderboard:challenges.scoring.note',
    { every: '10 minutes', last: '4 minutes', next: '6 minutes' });
  const task = 'Open any app somebody else made and use it for 10 minutes in total.';
  const html = render({ ...VIEW, scoringNote: note, task });
  const at = html.indexOf('data-challenge-scoring');
  assert.ok(at !== -1, 'the line is drawn');
  assert.ok(html.includes('<p class="text-[0.8125rem] text-zinc-500 dark:text-zinc-400" data-challenge-scoring="true">'),
    'the same grey note the points line uses');
  assert.ok(html.includes(`>${note}<`), 'the sentence reads in full');
  const rail = html.indexOf('role="progressbar"');
  const taskAt = html.indexOf('data-challenge-task');
  const cta = html.indexOf('href="https://example.com/node"');
  assert.ok(at > rail, 'after the progress rail');
  assert.ok(at < taskAt, 'before the organiser’s task line');
  assert.ok(at < cta, 'before the action');
  assert.doesNotMatch(render(VIEW), /data-challenge-scoring/,
    'a challenge counted on the spot draws no line');
});
// #3253, #3248: the note on what the rule counts sits under the points, muted.
test('the count note reads under the points, and is absent without one', () => {
  const note = message('leaderboard:challenges.countNote.onPropose');
  const html = render({ ...VIEW, countNote: note });
  const points = html.indexOf('720 pts so far');
  const at = html.indexOf(note.replaceAll("'", '&#x27;')); // as React escapes it
  assert.ok(points >= 0 && at > points, 'after the points');
  assert.ok(at < html.indexOf('role="progressbar"'), 'before the rail');
  assert.match(html, /<p class="text-\[0\.8125rem\] text-zinc-500 dark:text-zinc-400">Counts when/);
  assert.doesNotMatch(render(VIEW), /Counts when/);
});

// ── #3650: the invite challenge's own note and per-person list ─────────

const INVITES_PEOPLE = [
  { key: '11', name: '@evan', word: 'counted', reason: 'Joined through your invite.' },
  { key: '12', name: '@ocank14', word: 'soon', reason: 'Joined through your invite. It shows here after the next count.' },
  { key: '13', name: '@snait', word: 'waiting', reason: 'They followed your link but haven’t joined yet. They join your community once they’re let into Homeroom.' },
  { key: '14', name: 'Someone you invited', word: 'notCounted', reason: 'They took someone else’s invite first. Each person counts once.' },
];

const INVITES_VIEW = {
  ...VIEW,
  cta: null, // the rail is followed by the note with nothing between them
  invitesNote: 'An invite counts when the person joins your community through your invite link.',
  invites: { state: 'ready', people: INVITES_PEOPLE },
};

test('the invite note sits directly under the rail, on an invite challenge only', () => {
  const html = render(INVITES_VIEW);
  const rail = html.indexOf('role="progressbar"');
  const note = html.indexOf('An invite counts when');
  assert.ok(rail > 0 && note > rail, 'after the rail');
  assert.ok(note < html.indexOf('data-tc-invites'), 'before the list');
  assert.match(html, /<p class="text-sm text-zinc-600 dark:text-zinc-400">An invite counts when/);
  // Any other challenge: neither the note nor the list exists, so the page
  // is exactly as it was.
  assert.doesNotMatch(render(VIEW), /data-tc-invites|An invite counts when|Your invites/);
});

test('the invite list reads as a section before What counts, one row a person', () => {
  const html = render(INVITES_VIEW);
  const list = html.indexOf('data-tc-invites');
  const whats = html.indexOf('>What counts<');
  assert.ok(list > 0 && whats > list, 'the list stands before What counts');
  assert.match(html, /Your invites/);
  // The rows in order, each the person's name over their reason.
  const rows = ['@evan', '@ocank14', '@snait', 'Someone you invited'];
  let at = list;
  for (const name of rows) {
    const i = html.indexOf(name);
    assert.ok(i > at, `${name} in the list`);
    at = i;
  }
  assert.match(html, /Joined through your invite\. It shows here after the next count\./);
});

test('the invite list’s status word: Counted in the finished colour, the rest quiet', () => {
  const html = render(INVITES_VIEW);
  assert.match(html, /text-emerald-700 dark:text-emerald-400">Counted</);
  for (const word of ['Counts soon', 'Waiting', 'Not counted']) {
    const i = html.indexOf(`>${word}</span>`);
    assert.ok(i > 0, `${word} is drawn`);
    assert.match(html.slice(i - 120, i), /text-zinc-500 dark:text-zinc-400/,
      `${word} is muted, not another accent`);
  }
});

test('the invite list’s loading, error and empty states', () => {
  // Loading: three skeleton rows, no names yet.
  const loading = render({ ...INVITES_VIEW, invites: { state: 'loading' } });
  assert.match(loading, /data-tc-invites/);
  assert.match(loading, /Your invites/);
  assert.match(loading, /animate-pulse/);
  assert.doesNotMatch(loading, /@evan|@ocank14/);
  // Error: the list says so, and offers a retry.
  const error = render({ ...INVITES_VIEW, invites: { state: 'error' } });
  assert.match(error, /Couldn&#x27;t load your invites\./);
  assert.match(error, /id="tc-se-invites-retry"[^>]*>Try again<\/button>/);
  // Empty: nobody invited yet.
  const empty = render({ ...INVITES_VIEW, invites: { state: 'ready', people: [] } });
  assert.match(empty, /You haven&#x27;t invited anyone yet\./);
});

// #3226: a line on what points are for, under the points, whenever they show.
test('the points note reads under the points, and only when points show', () => {
  const note = message('leaderboard:challenges.detail.pointsNote');
  assert.equal(note, 'Points add up across challenges and set your place in the standings.');
  const html = render(VIEW);
  const at = html.indexOf(note);
  assert.ok(at > html.indexOf('720 pts so far'), 'after the points');
  assert.ok(at < html.indexOf('src="/illustrations/'), 'before the artwork');
  assert.doesNotMatch(render({ ...VIEW, amount: null }), /set your place in the standings/,
    'no points shown: no note either');
});

// ── #3247: which credits made the count ─────────────────────────────────

const CREDITS = [
  { text: 'Add a dark mode', points: 500, at: '2026-10-02T16:32:00.000Z', precision: 'instant',
    change: { slug: 'my app', sessionId: 41, prNumber: 7 } },
  { text: 'Drafted a plan', points: 100, at: null, precision: null,
    change: { slug: 'one', sessionId: 42, prNumber: null } },
  { text: 'Accepted proposal', points: 300, at: null, precision: null, change: null },
];

test('#3247: What counted sits between the action and What counts, and links each change it can show', () => {
  const html = render({ ...VIEW, credits: CREDITS });
  assert.ok(html.includes(`>${message('leaderboard:challenges.detail.counted')}<`));
  assert.ok(html.indexOf('Set up your node') < html.indexOf('tc-se-detail-credits'));
  assert.ok(html.indexOf('tc-se-detail-credits')
    < html.indexOf(`>${message('leaderboard:challenges.detail.requirements')}<`));
  assert.match(html, /<a href="#app\/my%20app\/dev\/changes\/7\/41"[^>]*>Add a dark mode<\/a>/);
  assert.match(html, /<a href="#app\/one\/dev\/proposals\/42"[^>]*>Drafted a plan<\/a>/);
  assert.match(html, /<span class="block[^"]*">Accepted proposal<\/span>/, 'no address: plain words, no link');
  assert.match(html, /\+500/);
});

test('#3247: a weekly challenge says the list is this week; no credits, no section', () => {
  const weekly = render({ ...VIEW, credits: CREDITS, creditsWeekly: true });
  assert.ok(weekly.includes(`>${message('leaderboard:challenges.detail.countedWeek')}<`));
  for (const credits of [[], undefined]) {
    assert.doesNotMatch(render({ ...VIEW, credits }), /tc-se-detail-credits/);
  }
});

// ── #7152: the viewer's own reports and proposals ───────────────────────

const ITEM_ROWS = [
  {
    key: 'feedback:1', title: 'Map won’t zoom on phones',
    subtitle: 'Plant Pal · Graded 210 of 250: says what happened and where.',
    word: 'Counted', accent: false, counted: true,
    link: { kind: 'request', slug: 'plant-pal', number: 11 },
  },
  {
    key: 'feedback:2', title: 'Search skips accented names',
    subtitle: 'Homeroom · Graded at the next count.',
    word: 'Still grading', accent: false, counted: false, link: null,
  },
  {
    key: 'feedback:3', title: 'Add dark mode',
    subtitle: 'Quiz Night · It’s about a project you made.',
    word: 'Not counted', accent: false, counted: false,
    link: { kind: 'request', slug: 'quiz night', number: 4 },
  },
];

const ITEMS_VIEW = {
  ...VIEW,
  feedbackLink: true,
  items: { state: 'ready', kind: 'feedback', weekly: true, rows: ITEM_ROWS },
};

test('#7152: the report list stands above See your feedback and What counted', () => {
  const html = render(ITEMS_VIEW);
  const list = html.indexOf('data-tc-items');
  const link = html.indexOf('tc-se-feedback-mine');
  const whats = html.indexOf('>What counts<');
  assert.ok(list > 0, 'the list is drawn');
  assert.ok(list < link, 'above See your feedback');
  assert.ok(list < whats, 'above What counts');
  assert.match(html, />Your reports this week</, 'the weekly heading');
  let at = list;
  for (const title of ['Map won’t zoom on phones', 'Search skips accented names', 'Add dark mode']) {
    const i = html.indexOf(title);
    assert.ok(i > at, `${title} in order`);
    at = i;
  }
  assert.match(html, /Graded 210 of 250: says what happened and where\./);
  assert.match(html, /Homeroom · Graded at the next count\./);
  // Counted is green; the rest are quiet; each row that has an address is a link.
  assert.match(html, /text-emerald-700 dark:text-emerald-400">Counted</);
  assert.match(html, /text-zinc-500 dark:text-zinc-400">Still grading</);
  assert.match(html, /<a[^>]*href="#app\/plant-pal\/dev\/issues\/11"/);
  assert.match(html, /<a[^>]*href="#app\/quiz%20night\/dev\/issues\/4"/);
  assert.doesNotMatch(render({ ...VIEW, items: null }), /data-tc-items/,
    'a challenge without the list draws none');
});

test('#7152: the list’s loading, error and empty states', () => {
  const loading = render({ ...VIEW, items: { state: 'loading', kind: 'feedback', weekly: true } });
  assert.match(loading, /data-tc-items/);
  assert.match(loading, /animate-pulse/);
  const error = render({ ...VIEW, items: { state: 'error', kind: 'proposals', weekly: false } });
  assert.match(error, /Couldn&#x27;t load this list\./);
  assert.match(error, /id="tc-se-items-retry"[^>]*>Try again<\/button>/);
  assert.match(render({ ...VIEW, items: { state: 'ready', kind: 'feedback', weekly: true, rows: [] } }),
    /You haven&#x27;t sent a report this week\./);
  assert.match(render({ ...VIEW, items: { state: 'ready', kind: 'proposals', weekly: false, rows: [] } }),
    /You haven&#x27;t got a proposal up this week\./);
});

test('#7152: proposals read Up for vote in the accent, and say how they stand', () => {
  const html = render({
    ...VIEW,
    feedbackLink: false,
    items: {
      state: 'ready', kind: 'proposals', weekly: true,
      rows: [
        {
          key: 'change:1', title: 'Water reminders', subtitle: 'Plant Pal · Counted: +420 pts.',
          word: 'Live', accent: false, counted: false,
          link: { kind: 'change', slug: 'plant-pal', session_id: 41, pr_number: 7 },
        },
        {
          key: 'change:2', title: 'Weekly score email',
          subtitle: "Quiz Night · Built for your request. Counts once it's accepted and live.",
          word: 'Up for vote', accent: true, counted: false,
          link: { kind: 'change', slug: 'quiz-night', session_id: 42, pr_number: 8 },
        },
      ],
    },
  });
  assert.match(html, />Your proposals this week</);
  assert.match(html, /text-violet-700 dark:text-violet-400">Up for vote</);
  assert.match(html, /href="#app\/plant-pal\/dev\/changes\/7\/41"/);
  assert.match(html, /href="#app\/quiz-night\/dev\/changes\/8\/42"/);
});

// The controller half: the status words and reasons the server's statuses map
// onto. The shipped topochain-challenges.js runs in a vm with a stub store,
// as in tests/challenge-history.test.js.
function loadItemsController() {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const { englishPlatformI18n } = require('./lib/platform-i18n');
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(
    path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');
  const sandbox = {
    window: {}, console, setTimeout, clearTimeout, URLSearchParams,
    location: { hash: '', search: '' },
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(source, sandbox, { filename: 'topochain-challenges.js' });
  const pane = sandbox.window.TopochainChallenges;
  const state = { mounted: true, grid: null, history: null, detail: null };
  pane._store = { get: () => state, set: (patch) => Object.assign(state, patch) };
  pane._open = true;
  return pane;
}

const FEEDBACK_CHALLENGE = {
  id: 5, card_preview: { goal: 'Send useful feedback' }, counted_by: { measure: 'USEFUL_FEEDBACK', target: 4 },
};
const PROPOSAL_CHALLENGE = {
  id: 6, card_preview: { goal: 'Get a proposal accepted' }, counted_by: { measure: 'PROPOSAL_ACCEPTED', target: 2 },
};

test('#7152: itemsView maps the server’s statuses onto words and reasons', () => {
  const pane = loadItemsController();
  const plain = (v) => JSON.parse(JSON.stringify(v));
  pane._detailChallenge = FEEDBACK_CHALLENGE;
  pane._items = undefined;
  assert.deepEqual(plain(pane.itemsView()), { state: 'loading', kind: 'feedback', weekly: false });
  pane._items = null;
  assert.deepEqual(plain(pane.itemsView()), { state: 'error', kind: 'feedback', weekly: false });

  pane._items = {
    measure: 'USEFUL_FEEDBACK', target: 4, weekly: true,
    items: [
      { key: 'feedback:1', title: 'A', app_name: 'Plant Pal', status: 'counted', points: 210, max: 250, reason_text: 'clear', link: null },
      { key: 'feedback:2', title: 'B', app_name: 'Homeroom', status: 'grading', link: null },
      { key: 'feedback:3', title: 'C', app_name: 'Mine', status: 'own_project', link: null },
      { key: 'feedback:4', title: 'D', app_name: 'Plant Pal', status: 'duplicate', link: null },
      { key: 'feedback:5', title: 'E', app_name: 'Plant Pal', status: 'over_target', link: null },
    ],
  };
  const view = pane.itemsView();
  assert.equal(view.state, 'ready');
  assert.equal(view.weekly, true);
  assert.deepEqual(view.rows.map((r) => r.word),
    ['Counted', 'Still grading', 'Not counted', 'Not counted', 'Not counted']);
  assert.deepEqual(view.rows.map((r) => r.counted), [true, false, false, false, false]);
  assert.equal(view.rows[0].subtitle, 'Plant Pal · Graded 210 of 250: clear');
  assert.equal(view.rows[1].subtitle, 'Homeroom · Graded at the next count.');
  assert.equal(view.rows[2].subtitle, "Mine · It's about a project you made.");
  assert.equal(view.rows[3].subtitle, 'Plant Pal · A copy of a report you already sent.');
  assert.equal(view.rows[4].subtitle, "Plant Pal · This week's 4 reports are already counted.");
});

test('#7152: a proposal row keeps the Workshop’s state word and says how it counts', () => {
  const pane = loadItemsController();
  pane._detailChallenge = PROPOSAL_CHALLENGE;
  pane._items = {
    measure: 'PROPOSAL_ACCEPTED', target: 2, weekly: false,
    items: [
      { key: 'change:1', title: 'Live one', app_name: 'Plant Pal', state: 'live', status: 'counted', points: 420, via: 'author', link: null },
      { key: 'change:2', title: 'Voting', app_name: 'Quiz Night', state: 'up_for_vote', status: 'needs_accept', via: 'request', link: null },
      { key: 'change:3', title: 'Forced', app_name: 'Homeroom', state: 'live', status: 'forced', via: 'author', link: null },
      { key: 'change:4', title: 'Ended', app_name: 'Homeroom', state: 'closed', status: 'closed', via: 'author', link: null },
      { key: 'change:5', title: 'Waiting', app_name: 'Plant Pal', state: 'going_live', status: 'pending_count', via: 'author', link: null },
    ],
  };
  const { rows } = pane.itemsView();
  assert.deepEqual(rows.map((r) => r.word), ['Live', 'Up for vote', 'Live', 'Closed', 'Going live']);
  assert.deepEqual(rows.map((r) => r.accent), [false, true, false, false, false]);
  assert.equal(rows[0].subtitle, 'Plant Pal · Counted: +420 pts.');
  assert.equal(rows[1].subtitle,
    "Quiz Night · Built for your request. Counts once it's accepted and live.");
  assert.equal(rows[2].subtitle, "Homeroom · An admin put it live without a vote, so it doesn't count.");
  assert.equal(rows[3].subtitle, "Homeroom · Closed without going live, so it doesn't count.");
  assert.equal(rows[4].subtitle, 'Plant Pal · Counts at the next count.');
});

test('#7152: detailView publishes the list on those two challenges only', () => {
  const pane = loadItemsController();
  pane._mine = new Map();
  pane._detailChallenge = FEEDBACK_CHALLENGE;
  pane._items = { measure: 'USEFUL_FEEDBACK', target: 4, weekly: false, items: [] };
  assert.equal(pane.detailView().items.kind, 'feedback');

  pane._detailChallenge = PROPOSAL_CHALLENGE;
  pane._items = { measure: 'PROPOSAL_ACCEPTED', target: 2, weekly: false, items: [] };
  assert.equal(pane.detailView().items.kind, 'proposals');

  pane._detailChallenge = {
    id: 9, card_preview: { goal: 'Try apps' }, counted_by: { measure: 'TRY_APPS', target: 3 },
  };
  assert.equal(pane.detailView().items, null, 'any other challenge draws no list');
});
