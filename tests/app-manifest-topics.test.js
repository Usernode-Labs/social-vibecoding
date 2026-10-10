'use strict';

// #4417: dapp.json's `topics` — a project's lasting conversations, each a
// channel and a category at once. Pinned here:
//
//   * the validation limits: ids and handles (2 to 32, lowercase, a letter
//     first, never `general`, never a built-in category, unique), names of 3
//     to 48, an about of up to 140, one emoji, at most 12 live, and a merge
//     only into a live topic, never itself;
//   * the reconcile, against the full schema, for each change: add (a pinned
//     registry row, origin 'topic', in the file's order), rename (name and
//     handle change, the old handle kept as an alias, and NO vote moves),
//     merge (the votes and the Workshop's placements move to the survivor,
//     the card's place is recorded, and no chat line is written), archive
//     (read-only, the votes stay and the tally reads past them, the
//     placements go), a topic missing from the file (archived), and an
//     absent block (nothing);
//   * the channel: a live topic takes posts, a retired one is read-only, a
//     reply thread may start from a topic message (on Homeroom's own app
//     too, whose old main stream is read-only), the general stream draws no
//     topic replies, and the read cursor counts each channel's unread;
//   * the places a project's page lists, and a request filed from a topic
//     message filed under it.
//
// Run with: node --test tests/app-manifest-topics.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const appManifest = require('../src/services/app-manifest');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const FOUR = [
  { id: 'onboarding', handle: 'onboarding', name: 'Onboarding', icon: '\u{1F6AA}', about: 'Signing up and the first week' },
  { id: 'homeroom-bot', handle: 'homeroom-bot', name: 'Homeroom bot', icon: '\u{1F916}', about: 'How it plans, builds and answers' },
  { id: 'proposal-pipeline', handle: 'proposal-pipeline', name: 'Proposal pipeline', icon: '\u{1F6A6}', about: 'From request to merge: proposals, checks, votes and merging' },
  { id: 'infra', handle: 'infra', name: 'Infra', icon: '\u{1F6E0}️', about: 'Builds, staging, deploys and the servers the apps run on' },
];

// The figures each of the four shows above its room (services/topic-figures.js).
const HOMEROOM_FIGURES = {
  onboarding: ['onboarding.sign-up', 'onboarding.first-project', 'onboarding.first-change', 'onboarding.found-project'],
  'homeroom-bot': ['bot.answered', 'bot.reply-cost', 'bot.reply-time', 'bot.merged', 'bot.merged-cost', 'bot.request-to-proposal'],
  'proposal-pipeline': ['pipeline.checks-time', 'pipeline.couldnt-tell', 'pipeline.shots', 'pipeline.vote-to-merged'],
  infra: ['infra.merge-to-live', 'infra.deploys-failed', 'infra.apps-up', 'infra.limits-filled'],
};

// Homeroom's own topics: the four it started with, each with its figures,
// then #project-workflows (from #4417's discussion: how work moves before
// it is a proposal), which names none.
const HOMEROOM = [
  ...FOUR.map((t) => ({ ...t, figures: HOMEROOM_FIGURES[t.id] })),
  { id: 'project-workflows', handle: 'project-workflows', name: 'Project workflows', icon: '\u{1F9ED}', about: 'How work moves before it\'s a proposal: request types, triage, discussion and decisions' },
];

// ── 1. Validation ────────────────────────────────────────────────────────

test('the platform\'s own dapp.json holds Homeroom\'s topics, valid, in this order', () => {
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../dapp.json'), 'utf8'));
  assert.deepEqual(manifest.topics, HOMEROOM);
  assert.deepEqual(appManifest.validateTopics(manifest.topics).errors, []);
  assert.deepEqual(appManifest.read(require('node:path').join(__dirname, '..')).topics.map((t) => [t.id, t.state]),
    HOMEROOM.map((t) => [t.id, 'live']));
});

test('a topic\'s id and handle: 2 to 32 lowercase letters, digits and hyphens, a letter first, never general or a built-in', () => {
  const ok = (topic) => appManifest.validateTopics([{ name: 'A topic', ...topic }]);
  assert.deepEqual(ok({ id: 'ab' }).errors, []);
  assert.equal(ok({ id: 'ab' }).topics[0].handle, 'ab', 'the handle starts as the id');
  assert.deepEqual(ok({ id: `a${'b'.repeat(31)}` }).errors, []);
  for (const id of ['a', `a${'b'.repeat(32)}`, 'A-b', '1ab', 'ab-', 'a b', 'a_b']) {
    assert.ok(ok({ id }).errors.length, `id ${JSON.stringify(id)} is refused`);
  }
  assert.match(ok({ id: 'bug' }).errors[0], /built-in category/);
  assert.match(ok({ id: 'x1', handle: 'general' }).errors[0], /never "general"/);
  assert.equal(ok({ id: 'x1', handle: '#Release-Notes' }).topics[0].handle, 'release-notes', 'a typed # and capitals are tidied');
  const dupHandle = appManifest.validateTopics([
    { id: 'aa', name: 'One' }, { id: 'bb', handle: 'aa', name: 'Two' },
  ]);
  assert.match(dupHandle.errors[0], /"#aa" is used twice/);
  const dupId = appManifest.validateTopics([{ id: 'aa', name: 'One' }, { id: 'aa', name: 'Two' }]);
  assert.match(dupId.errors[0], /"aa" is used twice/);
});

test('a name of 3 to 48, an about of at most 140, an icon of one emoji', () => {
  const one = (extra) => appManifest.validateTopics([{ id: 'aa', name: 'Abc', ...extra }]);
  assert.deepEqual(one({}).errors, []);
  assert.match(one({ name: 'Ab' }).errors[0], /3 to 48/);
  assert.match(one({ name: 'x'.repeat(49) }).errors[0], /3 to 48/);
  assert.deepEqual(one({ about: 'x'.repeat(140) }).errors, []);
  assert.match(one({ about: 'x'.repeat(141) }).errors[0], /at most 140/);
  for (const icon of ['\u{1F6AA}', '\u{1F6E0}️', '\u{1F469}‍\u{1F4BB}', '1️⃣']) {
    assert.deepEqual(one({ icon }).errors, [], `${icon} is one emoji`);
  }
  for (const icon of ['ab', '\u{1F6AA}\u{1F6AA}', 'x\u{1F6AA}', '\u{1F6AA} ']) {
    if (icon.trim() !== icon) continue;
    assert.match(one({ icon }).errors[0] || '', /one emoji/, `${icon} is not`);
  }
});

test('at most 12 live; a merge only into a live topic, never itself; retired ones do not count', () => {
  const live = Array.from({ length: 12 }, (_, i) => ({ id: `t${i + 10}`, name: `Topic ${i}` }));
  assert.deepEqual(appManifest.validateTopics(live).errors, []);
  const thirteen = appManifest.validateTopics([...live, { id: 'one-more', name: 'One more' }]);
  assert.match(thirteen.errors[0], /at most 12 live topics/);
  assert.equal(thirteen.topics.length, 12, 'the reader keeps the first twelve');
  const retired = appManifest.validateTopics([...live, { id: 'old', name: 'Old one', archived: true },
    { id: 'gone', name: 'Gone one', mergedInto: 't10' }]);
  assert.deepEqual(retired.errors, [], 'archived and merged topics are not live');
  assert.deepEqual(retired.topics.slice(-2).map((t) => [t.id, t.state, t.mergedInto]),
    [['old', 'archived', null], ['gone', 'merged', 't10']]);

  const bad = appManifest.validateTopics([
    { id: 'aa', name: 'Alpha' },
    { id: 'bb', name: 'Beta', mergedInto: 'bb' },
    { id: 'cc', name: 'Gamma', mergedInto: 'dd' },
    { id: 'dd', name: 'Delta', archived: true },
    { id: 'ee', name: 'Epsilon', mergedInto: 'ff' },
    { id: 'ff', name: 'Phi', mergedInto: 'aa' },
  ]);
  assert.deepEqual(bad.errors, [
    'topic "bb" can only be merged into a live topic',
    'topic "cc" can only be merged into a live topic',
    'topic "ee" can only be merged into a live topic',
  ]);
  assert.deepEqual(bad.topics.map((t) => [t.id, t.state]),
    [['aa', 'live'], ['bb', 'archived'], ['cc', 'archived'], ['dd', 'archived'], ['ee', 'archived'], ['ff', 'merged']],
    'a merge that cannot apply is kept as archived, so nothing moves and its channel stays readable');
});

test('an absent block is no topics block at all; a malformed one is ignored', () => {
  assert.equal(appManifest.readTopics({}), null);
  assert.equal(appManifest.readTopics({ topics: null }), null);
  assert.equal(appManifest.readTopics({ topics: 'onboarding' }), null);
  assert.deepEqual(appManifest.readTopics({ topics: [] }), []);
  assert.deepEqual(appManifest.validateTopics('x').errors, ['topics must be an array']);
});

// ── 2. Against the full schema ───────────────────────────────────────────

test('topics against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `topics_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, the new table and columns included

  require('../src/db/pool').getPool = () => pool;
  const wsBus = require('../src/services/ws-bus');
  const frames = [];
  wsBus.publish = (kind, routing, data) => frames.push({ kind, routing, data });
  const ws = require('../src/services/ws');
  const appChat = require('../src/services/app-chat');
  const places = require('../src/services/places');
  const attrs = require('../src/services/topic-attributes');
  const { chatRoutes } = require('../src/routes/chat');

  const users = {};
  async function user(username) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [username]
    );
    users[rows[0].id] = { id: rows[0].id, username };
    return users[rows[0].id];
  }
  async function makeApp(slug, { selfHosted = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, status, view_visibility, collab_visibility, self_hosted)
       VALUES ($1, $1, 'running', 'public', 'public', $2) RETURNING id, slug, name`,
      [slug, selfHosted]
    );
    return rows[0];
  }
  async function join(app, who) {
    await pool.query(
      `INSERT INTO community_members (community_id, user_id, source)
         SELECT community_id, $2, 'joined' FROM apps WHERE id = $1
       ON CONFLICT DO NOTHING`,
      [app.id, who.id]
    );
  }
  const client = (who, app) => ({ user: { id: who.id, username: who.username }, appId: app.id, appSlug: app.slug });
  const reconcile = (app, topics) => appManifest.reconcileAppTopics(pool, app, { topics: appManifest.validateTopics(topics).topics });
  const rowsOf = async (app) => (await pool.query(
    `SELECT id, category_key, label, description, icon, origin, topic_handle, topic_aliases, topic_state,
            merged_into, merged_at, topic_order, (pinned_at IS NOT NULL) AS pinned, (retired_at IS NOT NULL) AS retired
       FROM app_category_registry WHERE app_id = $1 ORDER BY topic_order NULLS LAST, id`,
    [app.id]
  )).rows;
  async function vote(app, ref, value, who) {
    await pool.query(
      `INSERT INTO topic_attribute_votes (app_id, target_type, target_ref, field, value, user_id)
       VALUES ($1, 'issue', $2, 'category', $3, $4)`,
      [app.id, ref, value, who.id]
    );
  }
  const votesOf = async (app) => (await pool.query(
    `SELECT target_ref, value, user_id FROM topic_attribute_votes WHERE app_id = $1 AND field = 'category' ORDER BY target_ref, user_id`,
    [app.id]
  )).rows.map((r) => [r.target_ref, r.value, r.user_id]);

  const ann = await user('ann');
  const bo = await user('bo');
  const cy = await user('cy');
  const app = await makeApp('page-turners');

  await t.test('an absent block changes nothing', async () => {
    assert.equal(await appManifest.reconcileAppTopics(pool, app, { topics: null }), null);
    assert.equal((await rowsOf(app)).length, 0);
  });

  await t.test('add: pinned topic rows, in the file\'s order; a category of the same key becomes the topic', async () => {
    // A category the group already voted for, under the key a topic takes.
    await pool.query(
      `INSERT INTO app_category_registry (app_id, category_key, label, origin, pinned_at)
       VALUES ($1, 'infra', 'infrastructure', 'member', NOW())`, [app.id]
    );
    await vote(app, 1, 'infra', ann);
    const out = await reconcile(app, FOUR);
    assert.deepEqual(out.added, ['onboarding', 'homeroom-bot', 'proposal-pipeline', 'infra']);
    const rows = await rowsOf(app);
    assert.deepEqual(rows.map((r) => [r.category_key, r.origin, r.topic_handle, r.topic_state, r.topic_order, r.pinned, r.retired]), [
      ['onboarding', 'topic', 'onboarding', 'live', 0, true, false],
      ['homeroom-bot', 'topic', 'homeroom-bot', 'live', 1, true, false],
      ['proposal-pipeline', 'topic', 'proposal-pipeline', 'live', 2, true, false],
      ['infra', 'topic', 'infra', 'live', 3, true, false],
    ]);
    assert.equal(rows[3].label, 'Infra', 'dapp.json names it');
    assert.deepEqual(await votesOf(app), [[1, 'infra', ann.id]], 'its votes are the topic\'s');
    const again = await reconcile(app, FOUR);
    assert.equal(again.changed, false, 'a second pass with the same file writes nothing');
    // A discovery never retires a topic: it is pinned and its origin is 'topic'.
    assert.deepEqual(await attrs.retireCategoriesExcept(pool, app.id, ['something-else']), []);
  });

  await t.test('rename: name and handle change, the old handle is kept, no vote moves', async () => {
    await vote(app, 2, 'onboarding', bo);
    const renamed = FOUR.map((tp) => (tp.id === 'onboarding' ? { ...tp, handle: 'first-week', name: 'The first week' } : tp));
    const out = await reconcile(app, renamed);
    assert.deepEqual(out.renamed, ['onboarding']);
    const row = (await rowsOf(app)).find((r) => r.category_key === 'onboarding');
    assert.equal(row.topic_handle, 'first-week');
    assert.deepEqual(row.topic_aliases, ['onboarding']);
    assert.equal(row.label, 'The first week');
    assert.deepEqual(await votesOf(app), [[1, 'infra', ann.id], [2, 'onboarding', bo.id]], 'the vote carries the id, which did not change');
    assert.equal((await places.resolveTopicHandle(pool, app.id, 'onboarding')).category_key, 'onboarding', 'the old link still finds it');
    assert.equal((await places.resolveTopicHandle(pool, app.id, '#first-week')).category_key, 'onboarding');
    assert.equal(await places.resolveTopicHandle(pool, app.id, 'general'), null);
    // And back: the handle it returns to leaves the aliases.
    await reconcile(app, FOUR);
    const back = (await rowsOf(app)).find((r) => r.category_key === 'onboarding');
    assert.equal(back.topic_handle, 'onboarding');
    assert.deepEqual(back.topic_aliases, ['first-week']);
  });

  // The Workshop's grouping row, so a merge and an archive have placements to move.
  await pool.query(
    `INSERT INTO app_workshop_themes (app_id, input_hash, themes_json, placements_json)
     VALUES ($1, '', $2::jsonb, $3::jsonb)`,
    [app.id, JSON.stringify([
      { id: 'onboarding', name: 'Onboarding', anchors: [] },
      { id: 'homeroom-bot', name: 'Homeroom bot', anchors: [] },
      { id: 'proposal-pipeline', name: 'Proposal pipeline', anchors: [] },
      { id: 'voting', name: 'Voting', anchors: [] },
    ]), JSON.stringify({ 'issue:5': 'homeroom-bot', 'issue:6': 'onboarding', 'issue:7': 'proposal-pipeline', 'issue:8': 'voting' })]
  );

  await t.test('merge: votes and placements move to the survivor, its place is recorded, and no line is written', async () => {
    await vote(app, 5, 'homeroom-bot', ann);
    await vote(app, 5, 'homeroom-bot', bo);
    await vote(app, 6, 'homeroom-bot', cy);
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1', [app.id])).rows[0].n;
    const merged = FOUR.map((tp) => (tp.id === 'homeroom-bot' ? { ...tp, mergedInto: 'onboarding' } : tp));
    const out = await reconcile(app, merged);
    assert.deepEqual(out.merged, [{ from: 'homeroom-bot', into: 'onboarding' }]);
    const row = (await rowsOf(app)).find((r) => r.category_key === 'homeroom-bot');
    assert.equal(row.topic_state, 'merged');
    assert.equal(row.merged_into, 'onboarding');
    assert.ok(row.merged_at, 'when it merged: where the channel draws its card');
    assert.equal(row.retired, true);
    assert.deepEqual((await votesOf(app)).filter(([ref]) => ref === 5 || ref === 6),
      [[5, 'onboarding', ann.id], [5, 'onboarding', bo.id], [6, 'onboarding', cy.id]]);
    const { rows: [themes] } = await pool.query('SELECT themes_json, placements_json FROM app_workshop_themes WHERE app_id = $1', [app.id]);
    assert.deepEqual(themes.placements_json, { 'issue:5': 'onboarding', 'issue:6': 'onboarding', 'issue:7': 'proposal-pipeline', 'issue:8': 'voting' });
    assert.deepEqual(themes.themes_json.map((d) => d.id), ['onboarding', 'proposal-pipeline', 'voting'], 'the merged definition leaves the draft, in order');
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1', [app.id])).rows[0].n;
    assert.equal(after, before, 'a merge is drawn from the registry, never posted as a message');
    const firstAt = row.merged_at;
    await reconcile(app, merged);
    assert.equal(String((await rowsOf(app)).find((r) => r.category_key === 'homeroom-bot').merged_at), String(firstAt), 'the merge keeps its time');
    // The vote that named it now resolves to where it went.
    assert.equal(await attrs.resolveCategoryKey(pool, app.id, 'homeroom-bot'), 'onboarding');
  });

  await t.test('archive: read-only, votes stay and the tally skips them, placements go; a topic left out of the file is archived', async () => {
    await vote(app, 7, 'proposal-pipeline', ann);
    await vote(app, 7, 'feature', bo);
    const archived = FOUR.map((tp) => (tp.id === 'homeroom-bot' ? { ...tp, mergedInto: 'onboarding' } : tp))
      .map((tp) => (tp.id === 'proposal-pipeline' ? { ...tp, archived: true } : tp))
      .filter((tp) => tp.id !== 'infra');
    const out = await reconcile(app, archived);
    assert.deepEqual(out.archived.sort(), ['infra', 'proposal-pipeline']);
    const rows = await rowsOf(app);
    assert.deepEqual(rows.map((r) => [r.category_key, r.topic_state, r.retired]), [
      ['onboarding', 'live', false],
      ['homeroom-bot', 'merged', true],
      ['proposal-pipeline', 'archived', true],
      ['infra', 'archived', true],
    ]);
    assert.ok((await votesOf(app)).some(([ref, value]) => ref === 7 && value === 'proposal-pipeline'), 'the vote stays on its row');
    const summary = await attrs.summarizeForTargets(pool, app.id, 'issue', [7, 1], null);
    assert.equal(summary.get(7).category.top, 'feature', 'the archived topic\'s vote is read past');
    assert.equal(summary.get(1).category.top, null);
    const { rows: [themes] } = await pool.query('SELECT themes_json, placements_json FROM app_workshop_themes WHERE app_id = $1', [app.id]);
    assert.ok(!('issue:7' in themes.placements_json), 'its cards are placed again');
    assert.deepEqual(themes.themes_json.map((d) => d.id), ['onboarding', 'voting']);
    await assert.rejects(() => attrs.castVote(pool, app.id, 'issue', 9, 'category', 'proposal-pipeline', cy.id), /topic_closed/);
    const listed = (await attrs.listCategories(pool, app.id)).filter((c) => c.custom).map((c) => c.value);
    assert.deepEqual(listed, ['onboarding'], 'only the live topic is on offer');
  });

  // ── The channel ──────────────────────────────────────────────────────
  const topicId = async (key) => (await rowsOf(app)).find((r) => r.category_key === key).id;

  await t.test('a live topic takes posts; a retired one is read-only, and says so', async () => {
    await join(app, ann);
    await join(app, bo);
    const live = await topicId('onboarding');
    const ok = await ws.handleMessage(pool, client(ann, app), { type: 'chat', content: 'Welcome to the first week', thread: { type: 'category', ref: live } });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.message.thread, { type: 'category', ref: live });
    const sent = [];
    const closed = await ws.handleMessage(pool, { ...client(ann, app), ws: { readyState: 1, send: (f) => sent.push(JSON.parse(f)) } },
      { type: 'chat', content: 'Anyone?', thread: { type: 'category', ref: await topicId('proposal-pipeline') } });
    assert.equal(closed.code, 'topic_closed');
    assert.equal(sent[0].code, 'topic_closed');
    const other = await makeApp('other-app');
    const foreign = await ws.handleMessage(pool, client(ann, app), { type: 'chat', content: 'x', thread: { type: 'category', ref: 999999 } });
    assert.equal(foreign.code, 'invalid_thread');
    assert.equal(await ws.validateThread(pool, other.id, { type: 'category', ref: live }), null, 'another app\'s topic is no thread here');
  });

  await t.test('a reply thread may start from a topic message, also on Homeroom\'s own app, whose old main stream takes no posts', async () => {
    const homeroom = await makeApp('homeroom-self', { selfHosted: true });
    await reconcile(homeroom, FOUR);
    await join(homeroom, ann);
    await join(homeroom, bo);
    const tid = (await rowsOf(homeroom))[0].id;
    const general = await ws.handleMessage(pool, client(ann, homeroom), { type: 'chat', content: 'In the old stream' });
    assert.equal(general.code, 'channel_moved', 'the old main stream stays read-only');
    const root = await ws.handleMessage(pool, client(ann, homeroom), { type: 'chat', content: 'A topic message', thread: { type: 'category', ref: tid } });
    assert.equal(root.ok, true, 'the topics are channels on the same app chat, and they take posts');
    const reply = await ws.handleMessage(pool, client(bo, homeroom), { type: 'chat', content: 'A reply', thread: { type: 'message', ref: root.message.id } });
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.message.threadRoot && reply.message.threadRoot.id, root.message.id);
  });

  const httpApp = express();
  httpApp.use(express.json());
  httpApp.use((req, _res, next) => { req.user = users[Number(req.get('x-test-user'))]; next(); });
  httpApp.use(chatRoutes({}));
  server = await new Promise((resolve) => { const l = httpApp.listen(0, '127.0.0.1', () => resolve(l)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (who, path) => {
    const res = await fetch(`${base}${path}`, { headers: { 'x-test-user': String(who.id) } });
    return { status: res.status, body: await res.json() };
  };
  const postJson = async (who, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'x-test-user': String(who.id), 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  await t.test('the channel reads as its own stream, with its replies; the general stream draws none of them', async () => {
    const live = await topicId('onboarding');
    const root = await ws.handleMessage(pool, client(bo, app), { type: 'chat', content: 'Threaded here', thread: { type: 'category', ref: live } });
    await ws.handleMessage(pool, client(ann, app), { type: 'chat', content: 'In the thread', thread: { type: 'message', ref: root.message.id } });
    await ws.handleMessage(pool, client(ann, app), { type: 'chat', content: 'In #general' });
    const channel = await get(bo, `/api/apps/${app.slug}/messages?thread_type=category&thread_ref=${live}`);
    assert.equal(channel.status, 200);
    assert.deepEqual(channel.body.messages.map((m) => m.content), ['Welcome to the first week', 'Threaded here', 'In the thread']);
    assert.equal(channel.body.channel.state, 'live');
    assert.equal(channel.body.messages[1].thread.reply_count, 1, 'a topic message carries its thread\'s summary');
    const generalStream = await get(bo, `/api/apps/${app.slug}/messages`);
    assert.deepEqual(generalStream.body.messages.map((m) => m.content), ['In #general'], 'no topic message, and no reply to one');
    const archived = await get(bo, `/api/apps/${app.slug}/messages?thread_type=category&thread_ref=${await topicId('proposal-pipeline')}`);
    assert.equal(archived.status, 200, 'a retired topic stays readable');
    assert.equal(archived.body.channel.state, 'archived');
    const missing = await get(bo, `/api/apps/${app.slug}/messages?thread_type=category&thread_ref=999999`);
    assert.equal(missing.status, 404);
  });

  await t.test('the read cursor: each channel counts its own unread, and the places list says so', async () => {
    const live = await topicId('onboarding');
    // No cursor yet: zero, and the list creates it at the newest message.
    assert.equal((await appChat.categoryUnreadCounts(pool, app.id, cy.id, [live])).get(live) || 0, 0);
    await join(app, cy);
    const first = await places.placesFor(pool, app, cy, { member: true, general: { unread_count: 2 } });
    assert.deepEqual(first.channels.map((c) => [c.kind, c.handle, c.state]), [
      ['general', 'general', 'live'],
      ['topic', 'onboarding', 'live'],
      ['topic', 'homeroom-bot', 'merged'],
      ['topic', 'proposal-pipeline', 'archived'],
      ['topic', 'infra', 'archived'],
    ]);
    assert.equal(first.channels[0].unread, 2);
    assert.equal(first.channels[1].unread, 0, 'a topic starts at zero, not at everything ever said');
    assert.equal(first.channels[2].merged_into, 'onboarding');
    assert.ok(first.channels[2].merged_at);
    // Two from somebody else, one of the reader's own.
    await ws.handleMessage(pool, client(ann, app), { type: 'chat', content: 'One', thread: { type: 'category', ref: live } });
    const two = await ws.handleMessage(pool, client(bo, app), { type: 'chat', content: 'Two', thread: { type: 'category', ref: live } });
    const again = await places.placesFor(pool, app, cy, { member: true });
    assert.equal(again.channels.find((c) => c.handle === 'onboarding').unread, 2);
    const read = await postJson(cy, `/api/apps/${app.slug}/messages/read`, { message_id: two.message.id, thread_type: 'category', thread_ref: live });
    assert.equal(read.status, 200);
    assert.equal(read.body.unread_count, 0);
    const unread = await postJson(cy, `/api/apps/${app.slug}/messages/unread`, { message_id: two.message.id, thread_type: 'category', thread_ref: live });
    assert.equal(unread.body.unread_count, 1);
    const wrong = await postJson(cy, `/api/apps/${app.slug}/messages/read`, { message_id: two.message.id, thread_type: 'issue', thread_ref: 3 });
    assert.equal(wrong.status, 400);
    const notInIt = await postJson(cy, `/api/apps/${app.slug}/messages/read`, { message_id: two.message.id, thread_type: 'category', thread_ref: await topicId('infra') });
    assert.equal(notInIt.status, 404, 'a message moves only its own channel\'s cursor');
    // Posting is reading: the poster's cursor moves to their own message.
    const mine = await ws.handleMessage(pool, client(cy, app), { type: 'chat', content: 'Mine', thread: { type: 'category', ref: live } });
    assert.equal(mine.ok, true);
    assert.equal(await appChat.categoryUnreadCount(pool, app.id, live, cy.id), 0);
    const firstPage = await get(cy, `/api/apps/${app.slug}/messages?thread_type=category&thread_ref=${live}`);
    assert.equal(firstPage.body.read.unread_count, 0);
    // A non-member has no cursor and no count.
    const outsider = await places.placesFor(pool, app, { id: 999999 }, { member: false });
    assert.equal(outsider.owed, null);
    assert.ok(outsider.channels.every((c) => c.unread === 0));
  });

  await t.test('a request filed from a topic message is filed under the topic', async () => {
    const live = await topicId('onboarding');
    const msg = await ws.handleMessage(pool, client(ann, app), { type: 'chat', content: 'Could the first week end inside a project?', thread: { type: 'category', ref: live } });
    const bot = require('../src/services/homeroom-bot-chat');
    assert.equal(await bot.seedTopicVote(pool, { appId: app.id, user: ann, messageId: msg.message.id, issueNumber: 41 }), true);
    const summary = await attrs.summarizeForTargets(pool, app.id, 'issue', [41], null);
    assert.equal(summary.get(41).category.top, 'onboarding');
    const generalMsg = await ws.handleMessage(pool, client(ann, app), { type: 'chat', content: 'Not in a topic' });
    assert.equal(await bot.seedTopicVote(pool, { appId: app.id, user: ann, messageId: generalMsg.message.id, issueNumber: 42 }), false);
    const archivedTopicMsg = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref)
       VALUES ($1, $2, 'old', 'message', 'category', $3) RETURNING id`,
      [app.id, ann.id, await topicId('proposal-pipeline')]
    );
    assert.equal(await bot.seedTopicVote(pool, { appId: app.id, user: ann, messageId: archivedTopicMsg.rows[0].id, issueNumber: 43 }), false,
      'a retired topic files nothing under it');
  });

  await t.test('the request counts read the Workshop\'s board, the group\'s vote first', async () => {
    const counts = await places.topicRequestCounts(pool, app.id, ['onboarding']);
    // Board: issue:5 and issue:6 placed (and voted) onboarding, issue:7's
    // placement went with the archive, issue:8 is voting.
    assert.equal(counts.get('onboarding'), 2);
  });
});
