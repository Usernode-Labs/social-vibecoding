'use strict';

// Homeroom mobile polish, item 05 (24 Nov 2026): the Homeroom bot list marks
// what is new since your last visit, at every width. Each band puts its new
// rows first, gives each a dot, draws a line in the accent under the last of
// them ("New since 9:40") and says "2 new" at its heading's end.
// frontend/src/features/ai/visit.ts (the rules), use-visit.ts (the visit as
// the page lives it), lines.ts and lists.tsx (the marks); the server half is
// tests/ai-visits.test.js and tests/ai-visits-postgres.test.js.
//
// What this pins:
//   1. What is new: a row that arrived in its band, one that moved stage in
//      In progress, one with unread messages; in Done, History's older rows
//      only when they also finished after the last visit. A first visit has
//      nothing before it.
//   2. Where the line goes (between the new rows and the seen ones only),
//      what the count counts, and the time the line names.
//   3. The bands as drawn: the dot, the line as a real separator with its
//      words, the pill beside the heading's own count, the spoken heading;
//      none of it on a first visit.
//   4. The page's visit: read in an effect, a leave said before the next
//      visit opens, a reload carrying the same visit on.
//   5. The page and the server name the rows the same way: the staging demo's
//      last visit marks exactly the rows it means to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const { withWords } = require('./lib/work-words');

const VISIT = 'frontend/src/features/ai/visit.ts';
const MODEL = 'frontend/src/features/ai/model.ts';
const LISTS = 'frontend/src/features/ai/lists.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const app = { slug: 'garden', name: 'Garden club', icon_url: null, icon_emoji: null };
const SINCE = '2026-11-24T09:40:00Z';
const visitOf = (seen) => ({ since: SINCE, seen: { needs: {}, busy: {}, done: {}, ...seen } });
const thread = (threadId, group, stage, extra = {}) => ({
  threadId, number: threadId, kind: 'work', title: `T${threadId}`, app, change: null,
  href: `#app/garden/dev/issues/${threadId}`, group, at: '2026-11-24T08:00:00Z',
  work: withWords({ why: null, reason: null, line: null, since: null, stage }),
  ...extra,
});
const need = (id, title, extra = {}) => ({
  key: `need:proposal:${id}`, title, app, who: 'all',
  sub: { id: 'messages:ai.row.where', values: { project: 'Garden club', number: id } },
  pill: { id: 'messages:ai.pill.vote' }, href: `#app/garden/dev/changes/${id}`, rootId: null,
  threadId: id + 1000, unread: 0, at: '2026-11-24T08:00:00Z', ...extra,
});

test('what is new since your last visit: arrived, moved stage, unread; nothing on a first visit', () => {
  const v = loadTsx(VISIT);
  // Identities: a feed card by its card, a private thread by its root, anything else by its thread.
  assert.equal(v.needIdentity({ key: 'need:proposal:12', rootId: null, threadId: 41 }), 'need:proposal:12');
  assert.equal(v.needIdentity({ key: 'private:9', rootId: 9, threadId: null }), 'root:9');
  assert.equal(v.needIdentity({ key: 'plan:7', rootId: null, threadId: 7 }), 'thread:7');
  // Mobile 04's @ row is its thread: one that arrives in Needs you is new.
  assert.equal(v.needIdentity({ key: 'named:8', rootId: null, threadId: 8 }), 'thread:8');
  assert.equal(v.threadIdentity({ threadId: 0, kind: 'private', rootId: 5 }), 'root:5');
  assert.equal(v.threadIdentity({ threadId: 6, kind: 'work', rootId: 3 }), 'thread:6', 'a request filed from a private thread is its own thread');

  const last = visitOf({
    needs: { 'need:proposal:1': '', 'thread:8': '' },
    busy: { 'thread:20': 'next:building', 'thread:21': 'waiting:up_for_vote' },
    done: { 'thread:30': '' },
  });
  // Needs you: there before, or arrived since.
  assert.equal(v.arrivedInNeeds(last, { key: 'need:proposal:1', rootId: null, threadId: 41 }), false);
  assert.equal(v.arrivedInNeeds(last, { key: 'need:proposal:2', rootId: null, threadId: 42 }), true, 'a vote that arrived');
  assert.equal(v.arrivedInNeeds(last, { key: 'named:8', rootId: null, threadId: 8 }), false, 'the same thread, asked of you in another way');
  // In progress: same list and stage, moved (Building to Checking), or arrived.
  assert.equal(v.movedInProgress(last, thread(20, 'next', 'building')), false);
  assert.equal(v.movedInProgress(last, thread(20, 'waiting', 'checking')), true, 'Building to Checking');
  assert.equal(v.movedInProgress(last, thread(22, 'next', 'reading')), true, 'arrived in In progress');
  // Done: this week's by the record alone; History's only when finished after the visit.
  assert.equal(v.arrivedInDone(last, 'thread:30', '2026-11-24T10:00:00Z', true), false, 'seen as done');
  assert.equal(v.arrivedInDone(last, 'thread:31', '2026-11-23T10:00:00Z', true), true, 'went live: this week\'s part was in view');
  assert.equal(v.arrivedInDone(last, 'thread:32', '2026-11-10T10:00:00Z', false), false, 'an older History row finished before the visit');
  assert.equal(v.arrivedInDone(last, 'thread:33', '2026-11-24T10:00:00Z', false), true);
  // A first visit has nothing before it.
  assert.equal(v.arrivedInNeeds(null, { key: 'need:proposal:2', rootId: null, threadId: 42 }), false);
  assert.equal(v.movedInProgress(null, thread(22, 'next', 'reading')), false);
  assert.equal(v.arrivedInDone(null, 'thread:31', '2026-11-23T10:00:00Z', true), false);

  // The record of a visit is every row of every band, as the page has them.
  const { needsYou, inProgress, upNext, liveThisWeek } = loadTsx(MODEL);
  const work = {
    private: [{ rootId: 9, title: 'An idea', kind: 'idea', app: null, at: null },
      { rootId: 10, title: 'Done this week', kind: 'idea', app, at: null, state: 'done', doneAt: new Date().toISOString() }],
    needs: [thread(7, 'needs', 'waiting_for_you', { work: withWords({ stage: 'waiting_for_you', why: 'plan' }) })],
    next: [thread(20, 'next', 'building')], waiting: [thread(21, 'waiting', 'up_for_vote')],
    live: [thread(30, 'live', 'live')],
  };
  const feed = [{ kind: 'proposal', id: 1, number: 500, title: 'A vote', app, threadId: 41 }];
  const seen = v.visitSeen(needsYou(feed, work), inProgress(feed, work), upNext(feed, work), liveThisWeek(work));
  assert.deepEqual(Object.keys(seen.needs).sort(), ['need:proposal:1', 'root:9', 'thread:7']);
  assert.deepEqual(seen.busy, { 'thread:20': 'next:building', 'thread:21': 'waiting:up_for_vote' });
  assert.deepEqual(Object.keys(seen.done).sort(), ['root:10', 'thread:30']);
  assert.equal(v.seenIsEmpty(seen), false);
  assert.equal(v.seenIsEmpty({ needs: {}, busy: {}, done: {} }), true, 'a list not read yet is no record');
  // The server's answer, read: a first visit is null.
  assert.equal(v.asLastVisit({ visit: 'tabAAAAAAAA', since: null, seen: null }), null);
  assert.deepEqual(v.asLastVisit({ visit: 'tabAAAAAAAA', since: SINCE, seen: { needs: { a: '' } } }), { since: SINCE, seen: { needs: { a: '' }, busy: {}, done: {} } });
});

test('the line goes between the new rows and the seen ones only; the count counts every new row; the time it names', () => {
  const v = loadTsx(VISIT);
  const rows = (...flags) => flags.map((isNew, i) => ({ key: `r${i}`, isNew }));
  assert.deepEqual(v.newFirst(rows(false, true, false, true)).map((r) => r.key), ['r1', 'r3', 'r0', 'r2'], 'stable: each run keeps its order');
  assert.equal(v.lineBefore(rows(true, true, false, false)), 'r2', 'under the last new row');
  assert.equal(v.lineBefore(rows(false, false)), null, 'nothing new: no line');
  assert.equal(v.lineBefore(rows(true, true)), null, 'everything new: no line');
  assert.equal(v.lineBefore([]), null);
  assert.equal(v.newCount(rows(true, false, true)), 2);
  // Today a time, this week a weekday, else a date, and the year when it is another one.
  const now = Date.parse('2026-11-24T15:00:00Z');
  assert.equal(v.sinceWords('2026-11-24T09:40:00Z', 'en-GB', now), '9:40');
  assert.equal(v.sinceWords('2026-11-23T09:40:00Z', 'en-GB', now), 'Mon');
  assert.equal(v.sinceWords('2026-11-12T09:40:00Z', 'en-GB', now), '12 Nov');
  assert.equal(v.sinceWords('2025-11-12T09:40:00Z', 'en-GB', now), '12 Nov 2025');
  assert.equal(v.sinceWords('not a time', 'en-GB', now), '');
  // The words, in the catalog.
  assert.equal(message('messages:ai.band.newSince', { time: '9:40' }), 'New since 9:40');
  assert.equal(message('messages:ai.band.newCount', { count: 2 }), '2 new');
  assert.equal(message('messages:ai.band.newCount', { count: 1 }), '1 new');
  assert.equal(message('messages:ai.band.withNew', { heading: 'Needs you, 3 items', count: 2 }), 'Needs you, 3 items, 2 new');
  // Kept in step with the Workshop's week page.
  assert.equal(message('project:weekPage.group.new'), 'New since your last visit');
  assert.equal(message('messages:ai.row.newSpoken'), 'New since your last visit');
});

test('the bands as drawn: the dot, the new rows first, the line, the pill; none of it on a first visit', () => {
  const props = (rows, visit, extra = {}) => ({
    ready: true, owed: rows.length, rows, lit: null, progress: [], waiting: [], live: [],
    openRow() {}, openThread() {}, visit, ...extra,
  });
  const rows = [
    need(1, 'Seen vote'),
    need(2, 'Arrived vote'),
    need(3, 'Unread vote', { unread: 2 }),
  ];
  const last = visitOf({ needs: { 'need:proposal:1': '', 'need:proposal:3': '' } });
  const html = renderComponent(LISTS, 'AiLists', props(rows, last));
  const needs = html.slice(html.indexOf('data-ai-list="work"'), html.indexOf('data-ai-sheet="busy"'));
  // New first, each with its dot; then the line; then what was seen.
  const at = (s) => needs.indexOf(s);
  assert.ok(at('Arrived vote') < at('data-ai-new-line') && at('Unread vote') < at('data-ai-new-line'), 'the new rows sit above the line');
  assert.ok(at('data-ai-new-line') < at('Seen vote'), 'and what you have seen below it');
  assert.equal((needs.match(/data-ai-dot=""/g) || []).length, 2, 'a dot on each new row');
  assert.equal((needs.match(/data-ai-new=""/g) || []).length, 2);
  // The line is a real separator, with the last visit's time in its words.
  assert.match(needs, /<div role="separator" aria-label="New since [^"]+" class="[^"]*" data-ai-new-line="">/);
  assert.match(needs, /h-\[1\.5px\] min-w-0 flex-1 rounded-full bg-\[color:var\(--accent\)\]/, '1.5px, in the accent: a bar, which no browser snaps to 1px');
  // The pill: "2 new" beside the heading's own count, which stays 3.
  assert.match(needs, /data-ai-band-count="">3</, 'the heading keeps its total');
  assert.match(needs, /bg-\[color:var\(--accent\)\][^"]*text-\[color:var\(--accent-ink\)\]" aria-hidden="true" data-ai-band-new="">2 new</);
  assert.match(needs, new RegExp(`<span class="sr-only">${message('messages:ai.band.withNew', { heading: message('messages:ai.work.titleCount', { count: 3 }), count: 2 })}</span>`),
    'a screen reader hears the count with the heading');
  assert.match(needs, /data-ai-new-spoken="">New since your last visit</, 'and a new row says so');

  // A first visit: no line and no count; an unread row keeps today's dot.
  const first = renderComponent(LISTS, 'AiLists', props(rows, null));
  assert.ok(!first.includes('data-ai-new-line') && !first.includes('data-ai-band-new') && !first.includes('data-ai-new='), 'nothing from this rule');
  assert.equal((first.match(/data-ai-dot=""/g) || []).length, 1, 'the unread row keeps its dot');
  // Every row new: no line; nothing new: no line and no pill.
  const allNew = renderComponent(LISTS, 'AiLists', props(rows, visitOf({})));
  assert.ok(!allNew.includes('data-ai-new-line'), 'everything new: no line');
  assert.match(allNew, /data-ai-band-new="">3 new</);
  const quiet = renderComponent(LISTS, 'AiLists', props([need(1, 'Seen vote')], last));
  assert.ok(!quiet.includes('data-ai-new-line') && !quiet.includes('data-ai-band-new'), 'nothing new: no line, no count');

  // In progress: a move marks its row; Done: what went live since.
  const progress = [thread(20, 'next', 'building'), thread(21, 'waiting', 'checking'), thread(22, 'next', 'reading')];
  const live = [thread(30, 'live', 'live', { at: '2026-11-24T11:00:00Z' }), thread(31, 'live', 'live', { at: '2026-11-23T11:00:00Z' })];
  const both = renderComponent(LISTS, 'AiLists', props([need(1, 'Seen vote')], visitOf({
    needs: { 'need:proposal:1': '' },
    busy: { 'thread:20': 'next:building', 'thread:21': 'next:building', 'thread:22': 'next:reading' },
    done: { 'thread:31': '' },
  }), { progress, live }));
  const busy = both.slice(both.indexOf('data-ai-list="busy"'), both.indexOf('data-ai-sheet="live"'));
  assert.match(busy, /data-ai-band-new="">1 new</, 'Building to Checking is new in In progress');
  assert.ok(busy.indexOf('T21') < busy.indexOf('data-ai-new-line') && busy.indexOf('data-ai-new-line') < busy.indexOf('T20'));
  const done = both.slice(both.indexOf('data-ai-list="live"'));
  assert.match(done, /data-ai-band-new="">1 new</);
  assert.ok(done.indexOf('T30') < done.indexOf('data-ai-new-line') && done.indexOf('data-ai-new-line') < done.indexOf('T31'), 'what went live sits above the line');

  // Never folded away in Needs you (./model.ts groupRows).
  const { groupRows } = loadTsx(MODEL);
  const many = Array.from({ length: 8 }, (_, i) => ({ key: `r${i}`, isNew: i === 7 }));
  assert.deepEqual(groupRows(many, 5, false).items.slice(0, 6).map((r) => r.key), ['r0', 'r1', 'r2', 'r3', 'r4', 'r7']);
  assert.equal(groupRows(many, 5, false, false).shown, 5, 'Done folds them with the rest: its count says how many');
  // #7138: In progress folds a new row past its first five (mode 'moved'),
  // and the rendered band still marks it with the dot and counts it as new.
  const progressMode = groupRows(many, 5, false, 'moved');
  assert.equal(progressMode.shown, 5, 'In progress keeps its default length whatever arrives');
  assert.ok(!progressMode.items.slice(0, 5).includes(many[7]), 'r7 waits behind Show more');
  assert.match(busy, /data-ai-dot=""/, 'a new row still carries its dot');
});

test('a row opened stops being new: its dot, its count and its place above the line go; the line keeps its time', () => {
  const v = loadTsx(VISIT);
  // Pure: a first visit marks nothing; a visit's record learns the row.
  assert.equal(v.withOpened(null, 'needs', 'need:proposal:2', ''), null);
  const last = visitOf({ needs: { 'need:proposal:1': '' } });
  const after = v.withOpened(last, 'needs', 'need:proposal:2', '');
  assert.equal(after.since, last.since, 'the line keeps its time');
  assert.deepEqual(after.seen.needs, { 'need:proposal:1': '', 'need:proposal:2': '' });
  assert.deepEqual(last.seen.needs, { 'need:proposal:1': '' }, 'the visit it came from is not changed');
  assert.equal(v.arrivedInNeeds(after, { key: 'need:proposal:2', rootId: null, threadId: 42 }), false);

  // The entry each kind of row adds, by the identity its band is keyed by.
  assert.deepEqual(v.openedNeed({ key: 'need:proposal:5', rootId: null, threadId: 9 }), ['needs', 'need:proposal:5', '']);
  assert.deepEqual(v.openedNeed({ key: 'private:4', rootId: 4, threadId: null }), ['needs', 'root:4', '']);
  assert.deepEqual(v.openedThread(thread(20, 'next', 'building')), ['busy', 'thread:20', 'next:building']);
  assert.deepEqual(v.openedThread(thread(21, 'waiting', 'checking')), ['busy', 'thread:21', 'waiting:checking']);
  assert.deepEqual(v.openedThread(thread(30, 'live', 'live')), ['done', 'thread:30', '']);
  assert.deepEqual(v.openedHistory({ rootId: 4, threadId: null }), ['done', 'root:4', '']);
  assert.deepEqual(v.openedHistory({ rootId: null, threadId: 7 }), ['done', 'thread:7', '']);

  // Three rows new, one opened: two dots become one, the count drops with
  // it, and the opened row joins what was seen below the line.
  const props = (rows, visit) => ({
    ready: true, owed: rows.length, rows, lit: null, progress: [], waiting: [], live: [],
    openRow() {}, openThread() {}, visit,
  });
  const rows = [need(1, 'Seen vote'), need(2, 'Opened vote'), need(3, 'Still new vote')];
  const opened = v.withOpened(last, ...v.openedNeed(rows[1]));
  const html = renderComponent(LISTS, 'AiLists', props(rows, opened));
  const needs = html.slice(html.indexOf('data-ai-list="work"'), html.indexOf('data-ai-sheet="busy"'));
  assert.equal((needs.match(/data-ai-new=""/g) || []).length, 1, 'only the row that was not opened is new');
  assert.equal((needs.match(/data-ai-dot=""/g) || []).length, 1);
  assert.match(needs, /data-ai-band-new="">1 new</, 'the band says one fewer');
  assert.ok(needs.indexOf('Still new vote') < needs.indexOf('data-ai-new-line'), 'the row not opened stays above the line');
  assert.ok(needs.indexOf('data-ai-new-line') < needs.indexOf('Opened vote'), 'the opened row sits below it');
  const beforeHtml = renderComponent(LISTS, 'AiLists', props(rows, last));
  const lineOf = (s) => (s.match(/aria-label="New since [^"]+"/) || [])[0];
  const beforeNeeds = beforeHtml.slice(beforeHtml.indexOf('data-ai-list="work"'), beforeHtml.indexOf('data-ai-sheet="busy"'));
  assert.ok(lineOf(needs), 'the line is drawn while rows are still new');
  assert.equal(lineOf(needs), lineOf(beforeNeeds), 'the line names the same time after a row is opened');

  // In progress: an opened row is new again when it moves stage; a Done
  // row clears by its done identity, this week's or History's.
  const busyOpened = v.withOpened(visitOf({}), ...v.openedThread(thread(20, 'next', 'building')));
  assert.equal(v.movedInProgress(busyOpened, thread(20, 'next', 'building')), false);
  assert.equal(v.movedInProgress(busyOpened, thread(20, 'waiting', 'checking')), true, 'a move after opening is new again');
  const doneOpened = v.withOpened(visitOf({}), ...v.openedHistory({ rootId: null, threadId: 7 }));
  assert.equal(v.arrivedInDone(doneOpened, 'thread:7', '2026-11-10T10:00:00Z', false), false);
});

test('the page\'s visit: read in an effect, a leave said before the next one opens, a reload the same visit', () => {
  const hook = read('frontend/src/features/ai/use-visit.ts');
  // Nothing in the first render: the visit is state, set from an effect's answer.
  assert.match(hook, /const \[visit, setVisit\] = useState<LastVisit \| null>\(null\);/);
  assert.equal((hook.match(/fetch\(/g) || []).length, 3, 'one open, one word, one row opened');
  assert.match(hook, /export function noteOpened\(band: keyof VisitSeen, identity: string, standing: string, demo = ''\): void/);
  assert.match(hook, /if \(!token\) return;[\s\S]*fetch\(`\/api\/ai\/visit\/opened\$\{demo\}`/, 'a row opened is said with this tab\'s token');
  assert.match(hook, /fetch\(`\/api\/ai\/visit\$\{demo\}`/);
  assert.match(hook, /fetch\(`\/api\/ai\/visit\/seen\$\{demo\}`[\s\S]*keepalive: left,/, 'a leave outlives the page');
  // The next visit waits for the last one's leave.
  assert.match(hook, /void leaving\.current\.then\(\(\) => fetch\(`\/api\/ai\/visit\$\{demo\}`/);
  // A reload or a phone put away keeps this browser tab's token; leaving the tab drops it.
  assert.match(hook, /window\.sessionStorage\.getItem\(TOKEN_KEY\)/);
  assert.match(hook, /window\.addEventListener\('pagehide', away\);/);
  assert.match(hook, /if \(document\.visibilityState === 'hidden'\) away\(\);\s+else open\(\);/);
  assert.match(hook, /if \(latest\.current\.session === account\) \{\s+leaving\.current = note\(true\);\s+writeToken\(null\);/,
    'leaving the tab ends the visit; the shell naming who is signed in does not');
  assert.match(hook, /window\.setInterval\(\(\) => \{\s+if \(document\.visibilityState !== 'hidden'\) void note\(false\);\s+\}, VISIT_NOTE_MS\);/);
  // The page: what the bands hold, every row, and the visit handed to the standard list only.
  const index = read('frontend/src/features/ai/index.tsx');
  assert.match(index, /const listSeen = useMemo\(\(\) => visitSeen\(rows, progress, waiting, live\), \[rows, progress, waiting, live\]\);/);
  assert.match(index, /const lastVisit = useListVisit\(\{ visible, session, ready: !!work && !!needs, seen: listSeen, demo: demoQuery\(\) \}\);/);
  // The page patches its copy of the visit when a row opens, and says so to
  // the server; the standard list draws the patched copy (the look's does not).
  assert.match(index, /const \[shownVisit, setShownVisit\] = useState\(lastVisit\);/);
  assert.match(index, /useEffect\(\(\) => \{ setShownVisit\(lastVisit\); \}, \[lastVisit\]\);/);
  assert.match(index, /setShownVisit\(\(now\) => withOpened\(now \?\? lastVisit, \.\.\.entry\)\);/);
  assert.equal((index.match(/seeOpened\(openedNeed\(row\)\);/g) || []).length, 1, 'a Needs you row opened');
  assert.equal((index.match(/seeOpened\(openedThread\(th\)\);/g) || []).length, 1, 'a thread opened');
  assert.equal((index.match(/seeOpened\(openedHistory\(row\)\);/g) || []).length, 1, 'a History row opened');
  assert.equal((index.match(/visit=\{shownVisit\}/g) || []).length, 1, 'the look\'s list draws no marks');
});

test('the page and the server name the rows alike: the staging demo marks the rows it means to', () => {
  const { demoWork } = require('../src/routes/ai-work');
  const { DEMO_NEEDS_FEED } = require('../src/routes/workshop-overview');
  const { demoVisit } = require('../src/services/ai-visits');
  const { needsYou, inProgress, upNext, liveThisWeek } = loadTsx(MODEL);
  const v = loadTsx(VISIT);
  const work = demoWork();
  const answer = demoVisit({ feed: DEMO_NEEDS_FEED, work, privateRoots: [] });
  const last = v.asLastVisit(answer);
  assert.ok(last, 'the demo answer is a last visit');
  const rows = needsYou(DEMO_NEEDS_FEED, work);
  const arrived = rows.filter((row) => v.arrivedInNeeds(last, row)).map((row) => row.key);
  assert.deepEqual(arrived, ['need:proposal:-103'], 'one vote arrived; every other row of Needs you was seen');
  assert.ok(rows.some((row) => row.unread > 0), 'and an unread one is new by its own rule');
  const busy = [...inProgress(DEMO_NEEDS_FEED, work), ...upNext(DEMO_NEEDS_FEED, work)];
  assert.deepEqual(busy.filter((t) => v.movedInProgress(last, t)).map((t) => t.threadId), [-9208], 'the tag filter moved from Reading to Building');
  const live = liveThisWeek(work);
  assert.deepEqual(live.filter((t) => v.arrivedInDone(last, v.threadIdentity(t), t.at, true)).map((t) => t.threadId), [-9221], 'the bigger cover picture went live');
});
