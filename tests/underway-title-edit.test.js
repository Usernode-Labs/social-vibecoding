// #2327: author-only inline title editing on a full open change page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { cardHtml } = require('./lib/dev-card-html');

function context(user = { id: 42, username: 'Builder' }) {
  const elements = {};
  const calls = [];
  const c = {
    console,
    App: {
      user, currentApp: 'example', currentTab: 'dev', currentSubTab: 'topic',
      _appUrl: () => '#example',
    },
    relTime: () => 'just now',
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      addEventListener() {},
    },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ title: 'New proposal title', prTitle: 'New proposal title' }) };
    },
    localStorage: { getItem: () => null },
    addEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync('public/js/merge-status.js', 'utf8'), c);
  vm.runInContext(fs.readFileSync('public/js/app-view.js', 'utf8'), c);
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  return { av: c.av, c, elements, calls };
}

const session = (patch = {}) => ({
  id: 4073,
  user_id: 42,
  username: 'Builder',
  status: 'active',
  source: 'cli_handoff',
  session_title: 'Original proposal title',
  pr_title: null,
  branch_name: 'dev/example',
  linked_issues: [],
  created_at: '2026-09-16T12:00:00Z',
  ...patch,
});

test('the author gets an edit pencil on active and paused full pages, not dense cards', () => {
  const { av } = context();
  for (const status of ['active', 'paused']) {
    const row = session({ status });
    const full = av._topicViewFor('session', row).card;
    assert.equal(full.title.edit.session, row.id);
    assert.match(cardHtml(full), /aria-label="Edit title"/);
    assert.equal(av._mySessionCardModel(row).title.edit, undefined);
    assert.equal(av._sharedSessionCardModel(row).title.edit, undefined);
  }
});

test('the author keeps the title editor while the proposal is in review', () => {
  const { av } = context();
  for (const status of ['promoted', 'merging']) {
    const row = session({ status, pr_number: 91, pr_title: 'Reviewed title' });
    const full = av._topicViewFor('proposal', row).card;
    assert.equal(full.title.edit.session, row.id);
    assert.match(cardHtml(full), /aria-label="Edit title"/);
    assert.equal(av._proposalCardModel(row).title.edit, undefined,
      'dense review cards remain a single navigation target');
  }
});

test('readers, read-only viewers, imported PRs and completed work get no pencil', () => {
  const reader = context({ id: 99, username: 'Reader' }).av;
  assert.equal(reader._topicViewFor('session', session()).card.title.edit, undefined);

  const readOnly = context().av;
  readOnly.appData.can_collaborate = false;
  assert.equal(readOnly._topicViewFor('session', session()).card.title.edit, undefined);

  const owner = context().av;
  assert.equal(owner._topicViewFor('session', session({ source: 'imported' })).card.title.edit, undefined);
  assert.equal(owner._topicViewFor('proposal', session({
    status: 'promoted', source: 'imported', pr_number: 91,
  })).card.title.edit, undefined);
  assert.equal(owner._topicViewFor('proposal', session({ status: 'merged' })).card.title.edit, undefined);
});

test('edit mode renders the session editor and protects both unified URL kinds from repaint', () => {
  const { av } = context();
  av._editingSessionTitle = 4073;
  const card = av._topicViewFor('session', session()).card;
  assert.equal(card.title.editing.session, 4073);
  assert.equal(card.title.editing.initial, 'Original proposal title');
  const html = cardHtml(card);
  assert.match(html, /id="dev-session-title-input"/);
  assert.match(html, /maxlength="256"/i);
  for (const kind of ['session', 'proposal']) {
    assert.equal(av._titleEditBlocksRepaint(
      { kind, id: 4073 }, null, false, 4073, true
    ), true);
  }
  assert.equal(av._titleEditBlocksRepaint(
    { kind: 'proposal', id: 4073 }, null, false, 4073, false
  ), false);
});

test('saving normalizes the request and updates every local copy before repaint', async () => {
  const { av, elements, calls } = context();
  const mine = session({ pr_number: 88, pr_title: 'Original proposal title' });
  const shared = { ...mine };
  av._mySessions = [mine];
  av._sharedSessions = [];
  av._sharedById = { [mine.id]: shared };
  av._editingSessionTitle = mine.id;
  let paints = 0;
  av._renderTopicHead = () => { paints += 1; };
  elements['dev-session-title-input'] = {
    value: '  New\n proposal   title ',
    disabled: false,
  };
  elements['dev-session-title-error'] = {
    textContent: '', classList: { remove() {} },
  };

  await av.saveSessionTitle(mine.id);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/sessions/4073/title');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { title: 'New proposal title' });
  for (const row of [mine, shared]) {
    assert.equal(row.session_title, 'New proposal title');
    assert.equal(row.proposed_pr_title, 'New proposal title');
    assert.equal(row.pr_title, 'New proposal title');
    assert.equal(row.pr_title_fallback, false);
  }
  assert.equal(av._editingSessionTitle, null);
  assert.equal(paints, 1);
});

test('a failed save keeps the editor open and shows the server error', async () => {
  const { av, c, elements } = context();
  av._mySessions = [session()];
  av._editingSessionTitle = 4073;
  c.fetch = async () => ({
    ok: false,
    json: async () => ({ error: 'Could not update the title' }),
  });
  const removed = [];
  const input = { value: 'Changed', disabled: false };
  const error = { textContent: '', classList: { remove: (name) => removed.push(name) } };
  elements['dev-session-title-input'] = input;
  elements['dev-session-title-error'] = error;

  await av.saveSessionTitle(4073);

  assert.equal(input.disabled, false);
  assert.equal(error.textContent, 'Could not update the title');
  assert.deepEqual(removed, ['hidden']);
  assert.equal(av._editingSessionTitle, 4073);
});
