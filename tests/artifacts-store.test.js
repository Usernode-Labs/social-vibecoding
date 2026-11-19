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

// A pool that holds the three tables' rows and answers the store's own
// statements, with the defaults the migration gives the new columns.
function tables() {
  const state = { threads: [], artifacts: [], versions: [], sql: [] };
  let nextThread = 100;
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
        state.artifacts.push({ kind: 'design', viewport: null, place: 'thread', ...given });
      } else if (/DO UPDATE/.test(text)) {
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
      }] };
    }
    if (text.startsWith('SELECT version, author, note, message_id, created_at FROM design_versions')) {
      return { rows: state.versions.filter((v) => v.private_thread_id === params[0]).sort((a, b) => a.version - b.version) };
    }
    if (text.startsWith('SELECT version, html FROM design_versions')) {
      return { rows: state.versions.filter((v) => v.private_thread_id === params[0] && v.version === params[1]) };
    }
    if (text.startsWith('SELECT id FROM private_threads WHERE id = $1 FOR UPDATE')) return { rows: [{ id: params[0] }] };
    if (text.startsWith('SELECT COALESCE(MAX(version), 0) AS n FROM design_versions')) {
      return { rows: [{ n: Math.max(0, ...state.versions.filter((v) => v.private_thread_id === params[0]).map((v) => v.version)) }] };
    }
    if (text.startsWith('INSERT INTO design_versions')) {
      state.versions.push({ private_thread_id: params[0], version: params[1], html: params[2], author: params[3], note: params[4], message_id: params[5], created_at: new Date() });
      return { rows: [] };
    }
    if (text.startsWith('UPDATE design_versions SET message_id')) {
      const row = state.versions.find((v) => v.private_thread_id === params[0] && v.version === params[1] && v.message_id == null);
      if (row) row.message_id = params[2];
      return { rows: [] };
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
  // A thread holds one artifact, and it keeps its kind.
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
