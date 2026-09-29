const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function context(username = 'Builder') {
  const c = {
    console,
    App: {
      user: { id: 42, username },
      currentApp: 'example',
      currentTab: 'dev',
      _appUrl: (slug, tab, ref) => `#app/${slug}/${tab}/issues/${ref?.id}`,
    },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null },
    addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8'), c);
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  c.av._govProposals = [];
  return c.av;
}

function issue(patch = {}) {
  return {
    number: 2427,
    state: 'open',
    title: 'Issue bodies should be editable',
    body: 'The old description.',
    created_by_username: 'Builder',
    bounty_count: 0,
    chatCount: 0,
    ...patch,
  };
}

test('the issue topic model carries raw Markdown and author permission to the About sheet', () => {
  const av = context();
  const row = issue();
  av._ghIssues = [row];
  const view = av._topicViewFor('issue', row);
  assert.deepEqual(
    JSON.parse(JSON.stringify(view.body.issueBodyEditor)),
    { issue: 2427, markdown: 'The old description.', canEdit: true }
  );
  assert.match(view.body.issueBodyHtml, /The old description/);
});

test('non-authors, closed issues and read-only views cannot edit the body', () => {
  const reader = context('Reader');
  let row = issue();
  reader._ghIssues = [row];
  assert.equal(reader._topicViewFor('issue', row).body.issueBodyEditor.canEdit, false);

  const author = context();
  row = issue({ state: 'closed' });
  author._ghIssues = [row];
  assert.equal(author._topicViewFor('issue', row).body.issueBodyEditor.canEdit, false);

  row = issue();
  author._ghIssues = [row];
  author.appData.can_collaborate = false;
  assert.equal(author._topicViewFor('issue', row).body.issueBodyEditor.canEdit, false);
});

test('_cacheIssueBody updates list and single-topic caches and returns rendered HTML', () => {
  const av = context();
  av._ghIssues = [issue()];
  av._topicIssue = issue({ state: 'closed' });
  const html = av._cacheIssueBody(2427, 'A **clearer** description.');
  assert.equal(av._ghIssues[0].body, 'A **clearer** description.');
  assert.equal(av._topicIssue.body, 'A **clearer** description.');
  assert.match(html, /A \*\*clearer\*\* description/);
});
