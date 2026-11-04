'use strict';

// #6305: one request on several projects from one card. The tool takes a
// list of projects and makes one "file_many" card with a row for each, in
// the order they were named; a name that does not match asks "Did you mean
// ...?" with the closest projects on that same row; a row for an app that
// already does what the request asks says so in one sentence and starts
// unticked. Nothing is filed by the offer itself: only the card's tap files.

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');

const APPS = [
  { id: 1, slug: 'game-corner', name: 'Game Corner', repo_url: 'https://github.com/x/game-corner', view_visibility: 'public', collab_visibility: 'public', community_id: null },
  { id: 2, slug: 'block-game', name: 'block-game', repo_url: 'https://github.com/x/block-game', view_visibility: 'public', collab_visibility: 'public', community_id: null },
  { id: 3, slug: 'viatales', name: 'ViaTales', repo_url: 'https://github.com/x/viatales', view_visibility: 'public', collab_visibility: 'public', community_id: null },
  { id: 4, slug: 'ear-trainer', name: 'Ear Trainer', repo_url: 'https://github.com/x/ear-trainer', view_visibility: 'public', collab_visibility: 'public', community_id: null },
];

/** A pool that answers the offer's own reads and records every write. */
function fakePool() {
  const writes = [];
  return {
    writes,
    query: async (sql, params = []) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
        writes.push({ sql, params });
        return { rows: [] };
      }
      if (sql.includes('FROM conversation_messages')) return { rows: [] };
      if (sql.includes('WHERE slug = LOWER($1)')) {
        const q = String(params[0] || '').toLowerCase();
        return { rows: APPS.filter((a) => a.slug === q || a.name.toLowerCase() === q) };
      }
      if (sql.includes('FROM community_members')) return { rows: APPS.map((a) => ({ slug: a.slug, name: a.name })) };
      return { rows: [] };
    },
  };
}

function ctx(overrides = {}) {
  return {
    user: { id: 7, username: 'ada', isAdmin: false },
    settings: {},
    config: {},
    deps: {
      // A quick look at each app: the answer is scripted, no model call.
      alreadyDoneAsk: async (messages) => {
        const said = JSON.stringify(messages);
        return said.includes('App: Game Corner')
          ? { content: '{"done": true, "sentence": "Game Corner already lets guests play today\'s board."}' }
          : { content: '{"done": false}' };
      },
    },
    offer: null,
    appIds: new Set(),
    conversationId: 11,
    messageId: 12,
    bot: { id: 900 },
    ...overrides,
  };
}

const ARGS = {
  title: 'Work for people who are not signed in',
  details: 'Visitors without an account can open the app and use it.',
  doneWhen: ['A visitor can open the app without signing up'],
  projects: [
    { project: 'Game Corner', named: 'Game Corner' },
    { project: 'block-game', named: 'Block World' },
    { project: 'viatales', named: 'ViaTales' },
  ],
};

test('#6305: a name that is not a project\'s is closest to the projects this person has', () => {
  const close = mayor.closestProjects('Block World', APPS);
  assert.deepEqual(close.map((c) => c.slug), ['block-game']);
  // Case, spaces and punctuation aside, and a slug's own suffix aside.
  assert.deepEqual(mayor.closestProjects('game corner', APPS).map((c) => c.slug), ['game-corner']);
  assert.deepEqual(mayor.closestProjects('viatales', APPS).map((c) => c.slug), ['viatales']);
  // Nothing close enough offers nothing, rather than a random project.
  assert.deepEqual(mayor.closestProjects('Pourover Coffee', [{ slug: 'ear-trainer', name: 'Ear Trainer' }]), []);
});

test('#6305: offer_request takes a list of projects and says one offer per turn', () => {
  const tool = mayor.TOOLS.find((t) => t.function.name === 'offer_request').function;
  assert.ok(tool.parameters.properties.projects, 'the tool takes several projects');
  assert.equal(tool.parameters.properties.projects.maxItems, 12);
  assert.ok(!tool.parameters.required.includes('project'), 'a single project is not required when several are given');
  assert.match(tool.description, /one card files them all/);
  // The prompt says it once, and never asks about names one reply at a time.
  const prompt = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src/services/homeroom-bot-mayor.js'), 'utf8',
  );
  assert.match(prompt, /Never ask about their names one/);
  assert.match(prompt, /say yes once and say it works by one card and one tap/);
});

test('#6305: several projects make one card, one row each, in the named order', async () => {
  const pool = fakePool();
  const c = ctx();
  const out = await mayor.runTool(pool, c, 'offer_request', ARGS);
  assert.equal(out.ok, true);
  assert.equal(c.card.type, 'file_many');
  assert.equal(c.offer.kind, 'file_many');
  assert.equal(c.card.state, 'open');
  assert.equal(c.card.forUserId, 7);
  assert.deepEqual(c.card.rows.map((r) => r.name), ['Game Corner', 'Block World', 'ViaTales']);
  // The exact names are matched; "Block World" is a guess with its closest.
  assert.equal(c.card.rows[0].match, 'exact');
  assert.equal(c.card.rows[1].match, 'guess');
  assert.deepEqual(c.card.rows[1].choices.map((ch) => ch.slug), ['block-game']);
  assert.equal(c.card.rows[2].match, 'exact');
  // Nothing is filed by the offer: no request, no action row.
  assert.equal(pool.writes.filter((w) => /homeroom_bot_dm_actions|INTO issues/.test(w.sql)).length, 0);
});

test('#6305: a row for an app that already does it says so and starts unticked', async () => {
  const pool = fakePool();
  const c = ctx();
  await mayor.runTool(pool, c, 'offer_request', ARGS);
  const row = c.card.rows.find((r) => r.slug === 'game-corner');
  assert.equal(row.done, 'Game Corner already lets guests play today\'s board.');
  assert.equal(row.ticked, false);
  // The ones the look said nothing about stay ticked.
  assert.equal(c.card.rows.find((r) => r.slug === 'viatales').ticked, true);
});

test('#6305: a second offer in the turn is refused', async () => {
  const pool = fakePool();
  const c = ctx();
  await mayor.runTool(pool, c, 'offer_request', ARGS);
  const again = await mayor.runTool(pool, c, 'offer_request', ARGS);
  assert.equal(again.ok, false);
  assert.match(again.error, /One offer per turn/);
});

test('#6305: an unanswered look leaves its row ticked with no sentence', async () => {
  const pool = fakePool();
  const c = ctx({ deps: { alreadyDoneAsk: async () => { throw new Error('timeout'); } } });
  await mayor.runTool(pool, c, 'offer_request', ARGS);
  for (const row of c.card.rows.filter((r) => r.match === 'exact')) {
    assert.equal(row.done, null);
    assert.equal(row.ticked, true);
  }
});
