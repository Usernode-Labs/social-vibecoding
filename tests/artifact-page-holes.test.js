'use strict';

// Artifacts, stage 2 (docs/plans/artifacts.md): a plain page is its author's
// alone, in their private thread with Homeroom bot. Only a design leaves its
// thread, and only by its author's own tap: as a plan, or as a new project's
// first screen. Every way a design leaves is closed to a page here, at the
// boundary each one is entered by:
//
//   1. Posting it as a plan (design-threads.js postDesignPlan), and the pane's
//      Request it (proposeDesign, POST .../designs/:rootId/propose), and a
//      first version's plan, which posts through the same function.
//   2. Making a project of it: the create route's design (isDesign, read by
//      routes/apps.js; tests/app-from-design-postgres.test.js drives the
//      route itself) and a first version's early plan (designPlan).
//   3. The thread's New project door (private-threads.js stateOf, pinned in
//      tests/thread-page-menu.test.js) and the reply check that knows when
//      that door shows (reply-claims.js newProjectDoorShown).
//   4. The chat's turn in a page's thread: no screen is drawn into it, no new
//      project is offered from it, and a turn that holds a design is offered
//      no page tool.

const test = require('node:test');
const assert = require('node:assert/strict');

const designs = require('../src/services/design-threads');
const claims = require('../src/services/reply-claims');
const session = require('../src/services/artifact-session');
const realStore = require('../src/services/artifacts');
const { designChatTurn, call } = require('./lib/design-chat-turn');

const EAR = { id: 3, slug: 'ear', name: 'Ear Trainer', repo_url: 'https://github.com/usernode-bot/ear' };
const PAGE_HTML = '<!doctype html><html><body><h1>Trip budget</h1><table><tr><td>Flights</td><td>420</td></tr></table></body></html>';

// One thread's artifact as the store reads it (artifacts.js artifactFor):
// `kind` is the stored design_threads.kind (null: a row from before kinds).
function artifactPool(kind, { app = 'ear' } = {}) {
  return {
    async query(sql, params = []) {
      const text = String(sql);
      if (/FROM private_threads p\s+JOIN design_threads d/.test(text)) {
        return { rows: [{
          id: 7, root_message_id: 500, conversation_id: 41, state: 'open', result_ref: null, kind: 'idea',
          about_kind: 'request', about_number: 18, slug: app, name: app ? 'Ear Trainer' : null, title: 'Trip budget',
          surface: 'new', route: null, width: 1280, height: 800, artifact_kind: kind, viewport: 'desktop', place: 'thread',
        }] };
      }
      if (/SELECT version, author, note, message_id, created_at FROM design_versions/.test(text)) {
        return { rows: [{ version: 1, author: 'bot', note: null, message_id: null, created_at: new Date() }] };
      }
      if (/SELECT version, html FROM design_versions/.test(text)) return { rows: [{ version: params[1], html: '<main><p>Keys</p></main>' }] };
      if (/FROM private_threads p WHERE p\.id = \$1/.test(text)) return { rows: [{ about_kind: 'request', about_number: 18, result_ref: null, state: 'open' }] };
      return { rows: [] };
    },
  };
}

// Everything posting a plan reaches past the thread, recorded.
function postingDeps() {
  const did = [];
  return {
    did,
    deps: {
      mayor: {
        findApp: async () => { did.push('findApp'); return EAR; }, canView: async () => true, canFile: async () => true,
        fileRequest: async () => { did.push('fileRequest'); return { issueNumber: 14, queueId: '61' }; },
      },
      dm: { botAccount: async () => ({ id: 2 }), async sendDm() { did.push('sendDm'); return { messageId: 901 }; } },
      requestSpecs: {
        prepareSpec: () => ({ ok: true }),
        openRequest: async () => ({ ok: true, repo: { owner: 'usernode-bot', repo: 'ear' }, issue: { title: 'Ear' } }),
        async postRequestSpec() { did.push('postRequestSpec'); return { version: 1, sessionId: 77 }; },
      },
      homeroomBot: { readSettings: async () => ({ mode: 'live' }) },
      track: { async tracksForRequests() { return new Map(); } },
      domain: null,
    },
  };
}

test('a page is never posted as a plan: not by the card, not by Request it, not on the request its thread is about', async () => {
  const user = { id: 9, username: 'evan' };
  for (const issueNumber of [18, null]) {
    const { did, deps } = postingDeps();
    const posted = await designs.postDesignPlan(artifactPool('page'), {}, { user, rootId: 500, issueNumber, allowEmptier: true, deps });
    assert.deepEqual(posted, { ok: false, status: 409, error: 'not_a_design' }, `on #${issueNumber}`);
    assert.deepEqual(did, [], 'nothing is read, filed, posted or said');
  }
  const { did, deps } = postingDeps();
  const proposed = await designs.proposeDesign(artifactPool('page'), {}, { user, rootId: 500, deps });
  assert.deepEqual(proposed, { ok: false, status: 409, error: 'not_a_design' });
  assert.deepEqual(did, []);

  // A design posts as it always did, and so does a row from before kinds were stored.
  for (const kind of ['design', null]) {
    const ok = postingDeps();
    const result = await designs.proposeDesign(artifactPool(kind), {}, { user, rootId: 500, deps: ok.deps });
    assert.equal(result.ok, true, `a ${kind || 'kindless'} row`);
    assert.equal(result.number, 18, 'on the request its thread is about');
    assert.ok(ok.did.includes('postRequestSpec'));
  }
});

test('a page is never made into a project: the create route\'s check and a first version\'s early plan', () => {
  assert.equal(designs.isDesign({ artifactKind: 'design' }), true);
  assert.equal(designs.isDesign({ title: 'Watering' }), true, 'a row from before kinds were stored is a design');
  assert.equal(designs.isDesign({ artifactKind: 'page' }), false);
  assert.equal(designs.isDesign(null), false);
  const fvPlan = require('../src/services/first-version-plan');
  assert.equal(fvPlan.designPlan({ title: 'Trip budget', artifactKind: 'page' }, 1), null, 'no early plan is written from a page');
  assert.equal(fvPlan.designPlan({ title: 'Watering', artifactKind: 'design' }, 2).fromDesign, true);
});

test('the reply check knows a page\'s thread shows no New project door', () => {
  const at = (threadDesign) => claims.newProjectDoorShown({ deps: { threadDesign } });
  assert.equal(at({ app: null, surface: 'new' }), true, 'a design for no project yet draws the door');
  assert.equal(at({ app: null, surface: 'new', artifactKind: 'design' }), true);
  assert.equal(at({ app: null, surface: 'new', artifactKind: 'page' }), false, 'a page never does');
  assert.equal(at({ app: { slug: 'ear' }, surface: 'app' }), false);
});

// A thread that holds a plain page, at version 1, read from the store.
const PAGE = {
  threadId: 7, rootId: 500, conversationId: 41, state: 'open', kind: 'idea', artifactKind: 'page', title: 'Trip budget',
  app: null, surface: 'new', viewport: 'desktop', width: 1280, height: 800, latest: 1,
  versions: [{ version: 1, author: 'bot', note: null, messageId: 880 }],
};
const pageStore = () => ({ ...realStore, async versionOf() { return { version: 1, html: PAGE_HTML }; } });
const resultOf = (messages, id) => JSON.parse((messages.find((m) => m.role === 'tool' && m.tool_call_id === id) || { content: 'null' }).content);

test('in a page\'s thread no screen is drawn and no project is offered; with a design loaded, no page is started', async () => {
  const turn = designChatTurn([
    { calls: [
      call('start_design', { what: 'a budget screen', title: 'Budget' }),
      call('offer_new_project', { idea: 'A trip budget app', name: 'Trip budget' }),
    ] },
    { calls: [call('reply', { text: 'This thread holds the page, so start a new thread for that.' })] },
  ], { design: PAGE, ask: 'make this an app', deps: { artifacts: pageStore() } });
  await turn.run;
  assert.equal(turn.offered[0].includes('start_design'), false, 'not offered while the page is loaded');
  assert.deepEqual(resultOf(turn.seen[1], 'cstart_design'), { ok: false, error: session.NO_SCREEN_TEXT }, 'and refused if called');
  assert.deepEqual(resultOf(turn.seen[1], 'coffer_new_project'), { ok: false, error: session.NO_PROJECT_TEXT });
  assert.equal(turn.sent.length, 1);
  assert.equal(turn.sent[0].metadata?.makeProject, undefined, 'no New project card under the reply');

  // A page that cannot be opened in this turn (put away) is still a page.
  const closed = { ...PAGE, state: 'done' };
  const refused = await require('../src/services/homeroom-bot-mayor').startDesign({ async query() { return { rows: [] }; } },
    { user: { id: 9 }, deps: { threadDesign: closed }, loadDesign: async () => ({ ok: true }) }, { what: 'x', title: 'X' });
  assert.deepEqual(refused, { ok: false, error: session.NO_SCREEN_TEXT });
  assert.equal(session.holdsPage({ deps: { threadDesign: closed } }), true);
  assert.equal(session.holdsPage({ deps: { threadDesign: { artifactKind: 'design' } } }), false);
  assert.equal(session.holdsPage({ caps: { design: { capability: 'design' } } }), false);

  // A thread that holds a design: its tools, and no way to start a page in it.
  const design = { ...PAGE, artifactKind: 'design', title: 'Ear home', app: { slug: 'ear', name: 'Ear Trainer' }, surface: 'app', width: 390, height: 844 };
  const drawn = designChatTurn([{ calls: [call('reply', { text: 'Nothing to change yet.' })] }], {
    design, current: { version: 1, html: '<main>Ear</main>' },
  });
  await drawn.run;
  assert.ok(drawn.offered[0].includes('edit_design'));
  assert.equal(drawn.offered[0].includes('write_artifact'), false, 'a thread holds one artifact');
  assert.equal(drawn.offered[0].includes('start_design'), false);
});
