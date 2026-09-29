// #3344: the owner's pencil on the proposal summary — shown only where the
// server's owner-only route will accept the save, and never where it would
// 404.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { BLANK_CARD, topicHeadHtml } = require('./lib/dev-card-html');

function context(user = { id: 42, username: 'Builder' }) {
  const c = {
    console,
    App: { user, currentApp: 'example', currentTab: 'dev', currentSubTab: 'topic', _appUrl: () => '#example' },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  vm.createContext(c);
  for (const p of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(p, 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  return c.av;
}

const session = (patch = {}) => ({
  id: 4073, user_id: 42, username: 'Builder', status: 'active', source: 'cli_handoff',
  session_title: 'Original proposal title', pr_title: null, branch_name: 'dev/example',
  linked_issues: [], created_at: '2026-09-16T12:00:00Z', ...patch,
});

const CARD = { ...BLANK_CARD };
const rendered = (item, body) => {
  const api = loadTsx('tests/fixtures/dev-card-api.ts');
  api.topicHeadStore.set({ item, card: CARD, body });
  return renderToHtml(createElement(api.TopicHead));
};

test('the model carries the raw markdown and the owner-only edit permission', () => {
  const owner = context();
  const v = owner._topicViewFor('session', session({ pr_summary_md: 'Previews wait for sign-in.' }));
  assert.deepEqual({ ...v.body.summaryEditor }, { markdown: 'Previews wait for sign-in.', canEdit: true });

  const reader = context({ id: 99, username: 'Reader' });
  assert.equal(reader._topicViewFor('session', session({ pr_summary_md: 'Words.' })).body.summaryEditor.canEdit, false);

  const readOnly = context();
  readOnly.appData.can_collaborate = false;
  assert.equal(readOnly._topicViewFor('session', session({ pr_summary_md: 'Words.' })).body.summaryEditor.canEdit, false);

  const mine = context();
  assert.equal(mine._topicViewFor('session', session({ source: 'imported', pr_summary_md: 'Words.' })).body.summaryEditor.canEdit, false);
  assert.equal(mine._topicViewFor('session', session({ status: 'merged', pr_summary_md: 'Words.' })).body.summaryEditor.canEdit, false);
  assert.equal(mine._topicViewFor('proposal', session({ status: 'promoted', pr_summary_md: 'Words.' })).body.summaryEditor.canEdit, false);
});

test('an empty summary is a valid add-a-summary draft, not a missing feature', () => {
  const av = context();
  const v = av._topicViewFor('session', session());
  assert.deepEqual({ ...v.body.summaryEditor }, { markdown: '', canEdit: true });
});

test('the pencil renders only for an editor who may save, and never breaks the hero chain', () => {
  const av = context();
  const editable = av._topicViewFor('session', session({ pr_summary_md: 'Previews wait for sign-in.' }));
  const html = rendered({ id: 4073, status: 'active' }, { ...editable.body, hero: av._topicHeroView('session', session({ pr_summary_md: 'Previews wait for sign-in.' })) });
  assert.match(html, /aria-label="Edit summary"/);
  assert.match(html, /data-topic-summary-edit="4073"/);
  assert.ok(html.indexOf('data-topic-part="summary"') < html.indexOf('data-topic-summary-edit'),
    'the pencil sits after the summary it edits');

  // The hero chain the change page pins: summary then issues, as siblings.
  const heroAt = html.indexOf('class="dev-topic-sheet dev-topic-hero"');
  const summaryAt = html.indexOf('data-topic-part="summary"');
  const issuesAt = html.indexOf('class="dev-topic-hero-issues"');
  assert.ok(heroAt >= 0 && summaryAt > heroAt && issuesAt > summaryAt, 'summary stays before the issues row');
});

test('a reader, an imported source and a settled proposal get no pencil', () => {
  const av = context();
  for (const row of [
    { ...session({ pr_summary_md: 'Words.' }), user_id: 99 },
    session({ source: 'imported', pr_summary_md: 'Words.' }),
    session({ status: 'merged', pr_summary_md: 'Words.' }),
    session({ status: 'promoted', pr_summary_md: 'Words.' }),
  ]) {
    const v = av._topicViewFor(['active', 'paused'].includes(row.status) ? 'session' : 'proposal', row);
    assert.equal(v.body.summaryEditor.canEdit, false, JSON.stringify({ status: row.status, source: row.source }));
    const html = rendered({ id: row.id, status: row.status }, { ...v.body, hero: av._topicHeroView('proposal', row) });
    assert.doesNotMatch(html, /data-topic-summary-edit/, 'no pencil for ' + JSON.stringify({ status: row.status }));
  }
});
