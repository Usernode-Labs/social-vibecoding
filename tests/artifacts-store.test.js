'use strict';

// Artifacts, stage 1 (docs/plans/artifacts.md): the one store of every page
// Homeroom bot writes with a person (src/services/artifacts.js), over the
// design tables, with the design code on top of it as the design kind
// (src/services/design-threads.js). tests/design-threads-postgres.test.js
// runs the same store against PostgreSQL; this suite holds its shape with a
// pool that keeps rows as the tables would.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../src/services/artifacts');
const designs = require('../src/services/design-threads');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A pool that holds the store's tables' rows and answers the store's own
// statements, with the defaults the migrations give their columns. K (20 Nov
// 2026): a thread's first artifact is design_threads' row and its versions
// design_versions'; later ones are thread_artifacts' (`later`) and their
// versions thread_artifact_versions' (`laterVersions`).
function tables() {
  const state = { threads: [], artifacts: [], versions: [], later: [], laterVersions: [], sql: [] };
  let nextThread = 100;
  let nextLater = 1;
  const maxOf = (list) => Math.max(0, ...list.map((v) => v.version));
  const query = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.sql.push(text);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
    if (text.startsWith('INSERT INTO private_threads')) {
      let row = state.threads.find((t) => t.root_message_id === params[2]);
      if (!row) {
        nextThread += 1;
        row = { id: nextThread, user_id: params[0], conversation_id: params[1], root_message_id: params[2], app_id: params[3], kind: 'idea', state: 'open', result_ref: null };
        state.threads.push(row);
      }
      return { rows: [{ id: row.id, user_id: row.user_id }] };
    }
    if (text.startsWith('INSERT INTO design_threads')) {
      const had = state.artifacts.find((a) => a.private_thread_id === params[0]);
      const names = /\(([^)]*)\) VALUES/.exec(text)[1].split(',').map((n) => n.trim());
      const given = Object.fromEntries(names.map((name, i) => [name, params[i]]));
      if (!had) {
        // The migration's defaults, for a build that names none of the new columns.
        state.artifacts.push({ kind: 'design', viewport: null, place: 'thread', pictures: [], ...given });
        return { rows: /RETURNING/.test(text) ? [{ private_thread_id: params[0] }] : [] };
      }
      if (/DO UPDATE/.test(text)) {
        Object.assign(had, { width: given.width, height: given.height, surface: given.surface, viewport: given.viewport ?? had.viewport, route: given.route ?? had.route });
      }
      return { rows: [] };
    }
    if (text.startsWith('SELECT p.id, p.root_message_id')) {
      const thread = state.threads.find((t) => t.root_message_id === params[0] && t.user_id === params[1]);
      const artifact = thread && state.artifacts.find((a) => a.private_thread_id === thread.id);
      if (!artifact) return { rows: [] };
      return { rows: [{
        id: thread.id, root_message_id: thread.root_message_id, conversation_id: thread.conversation_id, state: thread.state,
        result_ref: thread.result_ref, kind: thread.kind, about_kind: null, about_number: null, slug: null, name: null,
        title: artifact.title, surface: artifact.surface, route: artifact.route, width: artifact.width, height: artifact.height,
        artifact_kind: artifact.kind, viewport: artifact.viewport, place: artifact.place,
        first_latest: maxOf(state.versions.filter((v) => v.private_thread_id === thread.id)) || null,
      }] };
    }
    if (text.startsWith('SELECT t.id, t.number, t.title')) {
      return { rows: state.later.filter((a) => a.private_thread_id === params[0]).sort((a, b) => a.number - b.number).map((a) => ({
        ...a, artifact_kind: a.kind, latest: maxOf(state.laterVersions.filter((v) => v.artifact_id === a.id)) || null,
      })) };
    }
    if (text.startsWith('SELECT version, author, note, message_id, created_at FROM design_versions')) {
      return { rows: state.versions.filter((v) => v.private_thread_id === params[0]).sort((a, b) => a.version - b.version) };
    }
    if (text.startsWith('SELECT version, author, note, message_id, created_at FROM thread_artifact_versions')) {
      return { rows: state.laterVersions.filter((v) => v.artifact_id === params[0]).sort((a, b) => a.version - b.version) };
    }
    if (text.startsWith('SELECT version, html FROM design_versions')) {
      return { rows: state.versions.filter((v) => v.private_thread_id === params[0] && v.version === params[1]) };
    }
    if (text.startsWith('SELECT v.version, v.html FROM thread_artifact_versions v')) {
      const artifact = state.later.find((a) => a.private_thread_id === params[0] && a.number === params[1]);
      return { rows: artifact ? state.laterVersions.filter((v) => v.artifact_id === artifact.id && v.version === params[2]) : [] };
    }
    if (text.startsWith('SELECT id FROM private_threads WHERE id = $1 FOR UPDATE')) return { rows: [{ id: params[0] }] };
    if (text.startsWith('SELECT COALESCE(MAX(version), 0) AS n FROM design_versions')) {
      return { rows: [{ n: maxOf(state.versions.filter((v) => v.private_thread_id === params[0])) }] };
    }
    if (text.startsWith('SELECT COALESCE(MAX(version), 0) AS n FROM thread_artifact_versions')) {
      return { rows: [{ n: maxOf(state.laterVersions.filter((v) => v.artifact_id === params[0])) }] };
    }
    if (text.startsWith('SELECT COALESCE(MAX(number), 1) AS n FROM thread_artifacts')) {
      return { rows: [{ n: Math.max(1, ...state.later.filter((a) => a.private_thread_id === params[0]).map((a) => a.number)) }] };
    }
    if (text.startsWith('SELECT id FROM thread_artifacts WHERE private_thread_id = $1 AND number = $2')) {
      return { rows: state.later.filter((a) => a.private_thread_id === params[0] && a.number === params[1]).map((a) => ({ id: a.id })) };
    }
    if (text.startsWith('INSERT INTO thread_artifacts')) {
      if (state.later.some((a) => a.private_thread_id === params[0] && a.number === params[1])) throw new Error('duplicate key');
      state.later.push({
        id: nextLater++, private_thread_id: params[0], number: params[1], kind: params[2], title: params[3], surface: params[4],
        route: params[5], width: params[6], height: params[7], viewport: params[8], place: 'thread', pictures: [],
      });
      return { rows: [] };
    }
    if (text.startsWith('UPDATE thread_artifacts SET width')) {
      const row = state.later.find((a) => a.private_thread_id === params[0] && a.number === params[1]);
      if (row) Object.assign(row, { width: params[2], height: params[3], viewport: params[4], surface: params[5], route: params[6] ?? row.route });
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO design_versions')) {
      state.versions.push({ private_thread_id: params[0], version: params[1], html: params[2], author: params[3], note: params[4], message_id: params[5], created_at: new Date() });
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO thread_artifact_versions')) {
      state.laterVersions.push({ artifact_id: params[0], version: params[1], html: params[2], author: params[3], note: params[4], message_id: params[5], created_at: new Date() });
      return { rows: [] };
    }
    if (text.startsWith('UPDATE design_versions SET message_id')) {
      const row = state.versions.find((v) => v.private_thread_id === params[0] && v.version === params[1] && v.message_id == null);
      if (row) row.message_id = params[2];
      return { rows: [] };
    }
    if (text.startsWith('UPDATE thread_artifact_versions v SET message_id')) {
      const artifact = state.later.find((a) => a.private_thread_id === params[0] && a.number === params[1]);
      const row = artifact && state.laterVersions.find((v) => v.artifact_id === artifact.id && v.version === params[2] && v.message_id == null);
      if (row) row.message_id = params[3];
      return { rows: [] };
    }
    if (text.startsWith('SELECT n FROM (')) {
      const at = [];
      const first = state.versions.filter((v) => v.private_thread_id === params[0]);
      if (first.length) at.push({ n: 1, at: Math.max(...first.map((v) => v.created_at.getTime())) });
      for (const a of state.later.filter((l) => l.private_thread_id === params[0])) {
        const mine = state.laterVersions.filter((v) => v.artifact_id === a.id);
        if (mine.length) at.push({ n: a.number, at: Math.max(...mine.map((v) => v.created_at.getTime())) });
      }
      at.sort((x, y) => y.at - x.at || y.n - x.n);
      return { rows: at.slice(0, 1) };
    }
    if (text.startsWith('UPDATE private_threads SET updated_at')) return { rows: [] };
    throw new Error(`the store asked something this pool does not know: ${text.slice(0, 80)}`);
  };
  return { state, pool: { query } };
}

const ADA = { id: 7, username: 'ada' };
const THREAD = { rootId: 500, conversationId: 41, threadId: null, app: null };

test('an artifact has a kind, a viewport and a place; a page is written and read like a design', async () => {
  const { pool, state } = tables();
  const page = await store.ensureArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: 'Trip budget', viewport: 'desktop' });
  assert.equal(page.artifactKind, 'page');
  assert.equal(page.place, 'thread');
  assert.equal(page.viewport, 'desktop');
  assert.deepEqual([page.width, page.height], [1280, 800]);
  assert.equal(page.surface, 'new', 'of nothing that exists: what an older build reads as a design for no project yet');
  assert.equal(page.title, 'Trip budget');
  assert.equal(page.latest, 0);
  assert.deepEqual(state.artifacts[0].kind, 'page');

  const first = await store.addVersion(pool, { threadId: page.threadId, html: '<h1>Budget</h1>', note: 'A first page' });
  assert.deepEqual(first, { version: 1 });
  const second = await store.addVersion(pool, { threadId: page.threadId, html: '<h1>Budget</h1><p>Flights</p>', note: 'Flights added' });
  assert.deepEqual(second, { version: 2 });
  const read = await store.artifactFor(pool, { userId: ADA.id, rootId: THREAD.rootId });
  assert.equal(read.latest, 2);
  assert.deepEqual(read.versions.map((v) => [v.version, v.author, v.note]), [[1, 'bot', 'A first page'], [2, 'bot', 'Flights added']]);
  assert.equal((await store.versionOf(pool, { userId: ADA.id, rootId: THREAD.rootId })).html, '<h1>Budget</h1><p>Flights</p>', 'the newest when none is named');
  assert.equal((await store.versionOf(pool, { userId: ADA.id, rootId: THREAD.rootId, version: 1 })).html, '<h1>Budget</h1>');
  // Somebody else's read finds nothing: an artifact is its author's alone.
  assert.equal(await store.artifactFor(pool, { userId: 8, rootId: THREAD.rootId }), null);
  assert.equal(await store.versionOf(pool, { userId: 8, rootId: THREAD.rootId, version: 1 }), null);
  // Written again (no new one asked for), the first keeps its kind.
  const again = await store.ensureArtifact(pool, { user: ADA, thread: THREAD, kind: 'design', title: 'Other', viewport: 'phone' });
  assert.equal(again.artifactKind, 'page');
  assert.equal(again.title, 'Trip budget');
  assert.equal(again.viewport, 'phone', 'drawn at the size of its newest page');
});

test('a version is whole HTML within the store\'s limits, numbered in order, and the store holds no status', async () => {
  const { pool } = tables();
  const page = await store.ensureArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: 'Notes' });
  assert.equal(await store.addVersion(pool, { threadId: page.threadId, html: '   ' }), null, 'an empty page is no version');
  assert.equal(await store.addVersion(pool, { threadId: page.threadId, html: 'x'.repeat(store.MAX_HTML_BYTES + 1) }), null, 'nor one too big');
  assert.equal(await store.addVersion(pool, { threadId: page.threadId, html: '<p>x</p>', author: 'someone' }), null);
  assert.equal(store.MAX_HTML_BYTES, 900 * 1024);
  assert.equal(store.MAX_VERSIONS, 80);
  assert.deepEqual(store.VIEWPORTS, { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } });
  assert.deepEqual(Object.keys(store.KINDS), ['design', 'page']);
  assert.deepEqual(store.PLACES, ['thread'], 'its author\'s thread: nothing publishes one');
  assert.equal(store.KINDS.design.sheets, true, 'a design is drawn with the project\'s stylesheets');
  assert.equal(store.KINDS.page.sheets, false, 'a page needs none, so none are written in');
  // Stage 3: a kind's limits are its own, and they are what its capability's turn grows to.
  const profiles = require('../src/services/bot-profiles');
  for (const kind of Object.values(store.KINDS)) assert.equal(kind.limits, profiles.capabilityOf(kind.capability).limits, kind.kind);
  assert.ok(store.KINDS.page.limits.rounds < store.KINDS.design.limits.rounds, 'a plain page is cheaper than a design');
  assert.equal(store.kindOf('nonsense').kind, 'design', 'a row from before is a design');
  // No status of its own: the artifact's row and its read carry none.
  const src = read('src/services/artifacts.js').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(src, /\bstatus\b/);
  const fields = Object.keys(await store.artifactFor(pool, { userId: ADA.id, rootId: THREAD.rootId }));
  assert.deepEqual(fields.filter((f) => /status|stage|phase/i.test(f)), []);
});

test('a pinned comment is checked against the thread\'s artifact, whatever its kind', async () => {
  const { pool } = tables();
  const page = await store.ensureArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: 'Notes' });
  await store.addVersion(pool, { threadId: page.threadId, html: '<h1>Notes</h1>' });
  const pin = await store.pinFor(pool, {
    user: ADA, conversationId: 41, threadRootId: 500,
    pin: { version: 1, x: 0.25004, y: 0.5, element: { tag: 'h1', id: '', text: 'Notes' }, extra: 'dropped' },
  });
  assert.deepEqual(pin, { version: 1, x: 0.25, y: 0.5, element: { tag: 'h1', id: '', text: 'Notes' } });
  for (const bad of [
    { version: 2, x: 0.5, y: 0.5 }, { version: 1, x: 1.2, y: 0.5 }, { version: 1, x: 0.5, y: -0.1 }, null, [], 'pin',
  ]) assert.equal(await store.pinFor(pool, { user: ADA, conversationId: 41, threadRootId: 500, pin: bad }), null, JSON.stringify(bad));
  assert.equal(await store.pinFor(pool, { user: ADA, conversationId: 99, threadRootId: 500, pin: { version: 1, x: 0.5, y: 0.5 } }), null, 'another chat\'s');
  assert.equal(await store.pinFor(pool, { user: { id: 8 }, conversationId: 41, threadRootId: 500, pin: { version: 1, x: 0.5, y: 0.5 } }), null, 'somebody else\'s');
  // The design code's pin check is the store's.
  assert.equal(designs.pinFor, store.pinFor);
});

test('a design is the design kind on top of the store: the same rows, and nothing else writes them', async () => {
  const { pool, state } = tables();
  const design = await designs.ensureDesign(pool, { selfAppSlug: 'homeroom' }, { user: ADA, thread: THREAD, title: 'Settings', size: 'desktop' });
  assert.equal(design.artifactKind, 'design');
  assert.equal(design.viewport, 'desktop');
  assert.equal(design.surface, 'new');
  assert.equal(state.artifacts[0].kind, 'design');
  assert.equal(designs.designFor, store.artifactFor);
  assert.equal(designs.versionOf, store.versionOf);
  assert.equal(designs.addVersion, store.addVersion);
  assert.equal(designs.MAX_HTML_BYTES, store.MAX_HTML_BYTES);
  assert.deepEqual(designs.SCREEN_SIZES, store.VIEWPORTS);
  // A row an older build wrote names none of the new columns: it is a
  // design, drawn at the size its width says.
  state.artifacts.push({ private_thread_id: 900, title: 'Old', surface: 'app', route: null, width: 390, height: 700, kind: 'design', viewport: null, place: 'thread' });
  state.threads.push({ id: 900, user_id: 7, conversation_id: 41, root_message_id: 901, app_id: null, kind: 'design', state: 'open', result_ref: null });
  const old = await store.artifactFor(pool, { userId: 7, rootId: 901 });
  assert.deepEqual([old.artifactKind, old.viewport, old.place, old.kind], ['design', 'phone', 'thread', 'design']);
  // The design code holds no statement of its own against the store's tables.
  const src = read('src/services/design-threads.js').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(src, /(INSERT INTO|UPDATE|FROM|JOIN) design_(threads|versions)\b/);
});

test('the migration only adds: three columns with defaults an older build can live with', () => {
  const sql = read('src/db/migrations/artifact-store.sql').replace(/--[^\n]*/g, '');
  const statements = sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.equal(statements.length, 3);
  for (const statement of statements) assert.match(statement, /^ALTER TABLE design_threads ADD COLUMN IF NOT EXISTS /, statement);
  assert.match(statements[0], /kind VARCHAR\(16\) NOT NULL DEFAULT 'design' CHECK \(kind IN \('design', 'page'\)\)$/);
  assert.match(statements[1], /viewport VARCHAR\(8\) CHECK \(viewport IS NULL OR viewport IN \('phone', 'desktop'\)\)$/);
  assert.match(statements[2], /place VARCHAR\(16\) NOT NULL DEFAULT 'thread' CHECK \(place IN \('thread'\)\)$/);
  assert.doesNotMatch(sql, /\b(DROP|RENAME|DELETE|TRUNCATE)\b/i);
  // What the store writes is what the checks allow.
  assert.deepEqual(Object.keys(store.KINDS), ['design', 'page']);
  assert.deepEqual(Object.keys(store.VIEWPORTS), ['phone', 'desktop']);
});

// ── K (20 Nov 2026, live-draft review): a thread holds several artifacts ──

test('K: one thread holds a design and two pages, each with its own versions from 1, in the order they were made', async () => {
  const { pool, state } = tables();
  const design = await store.addArtifact(pool, { user: ADA, thread: THREAD, kind: 'design', title: 'Home', viewport: 'phone' });
  assert.equal(design.ok, true);
  assert.equal(design.artifact.artifactId, 1, 'the first is number 1');
  assert.equal(state.artifacts.length, 1, 'and is design_threads\' row, where a build from before reads it');
  assert.equal(state.later.length, 0);
  const layouts = await store.addArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: 'Layouts' });
  const budget = await store.addArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: 'Budget' });
  assert.deepEqual([layouts.artifact.artifactId, budget.artifact.artifactId], [2, 3]);
  assert.equal(state.artifacts.length, 1, 'a later one never touches the first\'s table');
  assert.deepEqual(state.later.map((a) => [a.number, a.kind, a.title]), [[2, 'page', 'Layouts'], [3, 'page', 'Budget']]);

  const threadId = design.artifact.threadId;
  assert.deepEqual(await store.addVersion(pool, { threadId, html: '<main>Home</main>', note: 'Home' }), { version: 1 });
  assert.deepEqual(await store.addVersion(pool, { threadId, artifactId: 1, html: '<main>Home 2</main>', note: 'Darker' }), { version: 2 });
  assert.deepEqual(await store.addVersion(pool, { threadId, artifactId: 2, html: '<ul><li>Rows</li></ul>', note: 'Rows' }), { version: 1 },
    'each artifact numbers its own versions from 1');
  assert.deepEqual(await store.addVersion(pool, { threadId, artifactId: 3, html: '<table></table>' }), { version: 1 });
  assert.deepEqual(await store.addVersion(pool, { threadId, artifactId: 2, html: '<ul><li>Cards</li></ul>', note: 'Cards' }), { version: 2 });
  assert.equal(await store.addVersion(pool, { threadId, artifactId: 9, html: '<p>x</p>' }), null, 'no such artifact');
  assert.equal(await store.addVersion(pool, { threadId, artifactId: 'two', html: '<p>x</p>' }), null);
  assert.deepEqual(state.versions.map((v) => v.version), [1, 2], 'the first\'s versions are design_versions\' rows, as before');

  // Read with no number: the first, as every address and row from before means.
  const first = await store.artifactFor(pool, { userId: ADA.id, rootId: THREAD.rootId });
  assert.deepEqual([first.artifactId, first.artifactKind, first.title, first.latest], [1, 'design', 'Home', 2]);
  assert.deepEqual(first.artifacts, [
    { artifactId: 1, title: 'Home', artifactKind: 'design', latest: 2, viewport: 'phone' },
    { artifactId: 2, title: 'Layouts', artifactKind: 'page', latest: 2, viewport: 'desktop' },
    { artifactId: 3, title: 'Budget', artifactKind: 'page', latest: 1, viewport: 'desktop' },
  ]);
  const second = await store.artifactFor(pool, { userId: ADA.id, rootId: THREAD.rootId, artifactId: 2 });
  assert.deepEqual([second.artifactId, second.artifactKind, second.title, second.latest, second.threadId], [2, 'page', 'Layouts', 2, threadId]);
  assert.deepEqual(second.versions.map((v) => [v.version, v.note]), [[1, 'Rows'], [2, 'Cards']]);
  assert.deepEqual(second.artifacts, first.artifacts, 'every read carries the whole list');
  assert.equal(await store.artifactFor(pool, { userId: ADA.id, rootId: THREAD.rootId, artifactId: 4 }), null);
  assert.equal(await store.artifactFor(pool, { userId: ADA.id, rootId: THREAD.rootId, artifactId: 0 }), null);
  assert.equal(await store.artifactFor(pool, { userId: 8, rootId: THREAD.rootId, artifactId: 2 }), null, 'its author\'s alone');

  assert.equal((await store.versionOf(pool, { userId: ADA.id, rootId: THREAD.rootId, artifactId: 2 })).html, '<ul><li>Cards</li></ul>');
  assert.equal((await store.versionOf(pool, { userId: ADA.id, rootId: THREAD.rootId, artifactId: 2, version: 1 })).html, '<ul><li>Rows</li></ul>');
  assert.equal((await store.versionOf(pool, { userId: ADA.id, rootId: THREAD.rootId, version: 1 })).html, '<main>Home</main>');
  assert.equal(await store.versionOf(pool, { userId: ADA.id, rootId: THREAD.rootId, artifactId: 3, version: 2 }), null);

  // Written again whole, a later one keeps its kind and title and takes its newest size.
  const again = await store.ensureArtifact(pool, { user: ADA, thread: THREAD, kind: 'design', title: 'Other', viewport: 'phone', artifactId: 2 });
  assert.deepEqual([again.artifactId, again.artifactKind, again.title, again.viewport], [2, 'page', 'Layouts', 'phone']);
  // `fresh` is a new one, the thread's next.
  const fresh = await store.ensureArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: 'Checklist', fresh: true });
  assert.equal(fresh.artifactId, 4);

  // A version's message is noted on its own artifact's row.
  await store.noteVersionMessage(pool, { threadId, artifactId: 2, version: 2, messageId: 777 });
  await store.noteVersionMessage(pool, { threadId, version: 2, messageId: 778 });
  assert.equal(state.laterVersions.find((v) => v.artifact_id === state.later[0].id && v.version === 2).message_id, 777);
  assert.equal(state.versions.find((v) => v.version === 2).message_id, 778);
  // The one the bot wrote last is the one a turn opens when nothing says
  // (ties, in one clock tick: the later artifact).
  const tick = new Date('2026-11-20T12:00:00Z');
  for (const v of [...state.versions, ...state.laterVersions]) v.created_at = tick;
  assert.equal(await store.newestWritten(pool, { threadId }), 3);
  state.laterVersions.find((v) => v.artifact_id === state.later[0].id && v.version === 2).created_at = new Date(Date.now() + 60_000);
  assert.equal(await store.newestWritten(pool, { threadId }), 2);
});

test('K: a thread holds at most MAX_ARTIFACTS_PER_THREAD artifacts, and an artifact 80 versions', async () => {
  const { pool } = tables();
  assert.equal(store.MAX_ARTIFACTS_PER_THREAD, 12);
  for (let n = 1; n <= store.MAX_ARTIFACTS_PER_THREAD; n += 1) {
    const made = await store.addArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: `Page ${n}` });
    assert.equal(made.artifact.artifactId, n);
  }
  assert.deepEqual(await store.addArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: 'One more' }), { ok: false, why: 'full' });
  assert.equal(await store.ensureArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: 'One more', fresh: true }), null);
  const page = await store.artifactFor(pool, { userId: ADA.id, rootId: THREAD.rootId, artifactId: 5 });
  for (let v = 1; v <= store.MAX_VERSIONS; v += 1) {
    assert.deepEqual(await store.addVersion(pool, { threadId: page.threadId, artifactId: 5, html: `<p>${v}</p>` }), { version: v });
  }
  assert.equal(await store.addVersion(pool, { threadId: page.threadId, artifactId: 5, html: '<p>81</p>' }), null);
  assert.deepEqual(await store.addVersion(pool, { threadId: page.threadId, artifactId: 6, html: '<p>1</p>' }), { version: 1 },
    'another artifact still has its own room');
  assert.deepEqual(await store.addArtifact(pool, { user: { id: 8 }, thread: THREAD, kind: 'page', title: 'Not hers' }), { ok: false, why: 'no_thread' });
});

test('K: a pin names the artifact it was pinned on; none is the first, as every pin from before', async () => {
  const { pool } = tables();
  const first = await store.addArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: 'Notes' });
  await store.addVersion(pool, { threadId: first.artifact.threadId, html: '<h1>Notes</h1>' });
  const second = await store.addArtifact(pool, { user: ADA, thread: THREAD, kind: 'page', title: 'Layouts' });
  await store.addVersion(pool, { threadId: first.artifact.threadId, artifactId: 2, html: '<h1>A</h1>' });
  await store.addVersion(pool, { threadId: first.artifact.threadId, artifactId: 2, html: '<h1>B</h1>' });
  assert.equal(second.artifact.artifactId, 2);
  const pin = (p) => store.pinFor(pool, { user: ADA, conversationId: 41, threadRootId: 500, pin: p });
  assert.deepEqual(await pin({ artifactId: 2, version: 2, x: 0.5, y: 0.5 }), { artifactId: 2, version: 2, x: 0.5, y: 0.5 });
  assert.deepEqual(await pin({ version: 1, x: 0.5, y: 0.5 }), { version: 1, x: 0.5, y: 0.5 }, 'none named: the first');
  assert.equal(await pin({ version: 2, x: 0.5, y: 0.5 }), null, 'the first has one version');
  assert.equal(await pin({ artifactId: 3, version: 1, x: 0.5, y: 0.5 }), null, 'no such artifact');
  assert.equal(await pin({ artifactId: 'x', version: 1, x: 0.5, y: 0.5 }), null);
  assert.equal(await pin({ artifactId: 0, version: 1, x: 0.5, y: 0.5 }), null);
});

test('K: the version line names the artifact when the thread holds more than one', () => {
  assert.equal(designs.versionLine(2, 'Darker cards'), 'Version 2: Darker cards.');
  assert.equal(designs.versionLine(2, 'Darker cards', { title: 'Layouts' }), 'Layouts, version 2: Darker cards.');
  assert.equal(designs.versionLine(2, 'Layouts, version 2: Darker cards', { title: 'Layouts' }), 'Layouts, version 2: Darker cards.',
    'a summary that already says it is not said twice');
  assert.equal(designs.versionLine(1, null, { title: 'Layouts' }), 'Layouts, version 1.');
});

test('K: a later artifact is reached only through the store; list queries read a thread\'s first, where it always was', () => {
  // Every module but the store, the seeds and the migrations: none names a
  // later artifact's tables, so none can read one without the store.
  const sources = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory()
    ? sources(`${dir}/${d.name}`) : d.name.endsWith('.js') ? [`${dir}/${d.name}`] : []));
  const naming = sources('src').filter((file) => /\bthread_artifact(s|_versions)\b/.test(read(file)));
  assert.deepEqual(naming.sort(), ['src/services/artifacts.js']);
  // The design kind's own code and the bot's turn reach every artifact through the store.
  for (const file of ['design-threads.js', 'homeroom-bot-mayor.js', 'design-bot.js', 'artifact-session.js', 'bot-pictures.js']) {
    const src = read(`src/services/${file}`).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(src, /(INSERT INTO|UPDATE|FROM|JOIN) design_(threads|versions)\b/, file);
  }
});

test('K: the migration only adds two tables and two nullable columns, and touches nothing an older build reads', () => {
  const sql = read('src/db/migrations/thread-artifacts.sql').replace(/--[^\n]*/g, '');
  const statements = sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements.map((s) => s.split(' (')[0].split(' IS ')[0]), [
    'CREATE TABLE IF NOT EXISTS thread_artifacts',
    'COMMENT ON TABLE thread_artifacts',
    'CREATE TABLE IF NOT EXISTS thread_artifact_versions',
    'COMMENT ON TABLE thread_artifact_versions',
    'ALTER TABLE chat_session_specs ADD COLUMN IF NOT EXISTS design_artifact_id INTEGER',
    'ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS design_artifact_id INTEGER',
  ]);
  // A foreign key's ON DELETE is how a row goes with its thread, not a statement.
  assert.doesNotMatch(sql.replace(/ON DELETE (CASCADE|SET NULL)/g, ''), /\b(DROP|RENAME|DELETE|TRUNCATE|UPDATE|ALTER COLUMN)\b/i);
  assert.doesNotMatch(sql, /\bdesign_(threads|versions)\b/, 'a thread\'s first artifact stays where a build from before reads it');
  for (const table of ['thread_artifacts', 'thread_artifact_versions']) {
    assert.match(sql, new RegExp(`COMMENT ON TABLE ${table} IS 'staging:private'`), `${table} is private on a staging copy`);
  }
  assert.match(sql, /UNIQUE \(private_thread_id, number\)/);
  assert.match(sql, /UNIQUE \(artifact_id, version\)/);
  assert.match(sql, /number\s+INTEGER NOT NULL CHECK \(number >= 2\)/, 'number 1 is design_threads\' row');
  const manifest = JSON.parse(read('src/db/migrations/manifest.json'));
  assert.ok(manifest.migrations.some((m) => m.id === 'thread-artifacts'), 'recorded in the manifest');
});
