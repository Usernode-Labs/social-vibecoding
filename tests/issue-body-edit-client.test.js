const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function context(username = 'Builder', globals = {}) {
  const c = {
    ...globals,
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
  c.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
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

test('#3952: the body and its GitHub comments go through the request mention pass', () => {
  // group-chat.js publishes renderRequestMentions as a page global; this
  // stand-in marks what passed through it.
  const seen = [];
  const av = context('Builder', {
    renderRequestMentions: (html) => { seen.push(html); return `[mentions]${html}`; },
  });
  const row = issue({ body: 'ping @​snait lmk wyt' });
  av._ghIssues = [row];
  assert.match(av._topicViewFor('issue', row).body.issueBodyHtml, /^<div class="dev-issue-body">\[mentions\]/);
  assert.match(seen[seen.length - 1], /ping @​snait lmk wyt/);
  // #4453: a GitHub comment is a row of the request page's thread now.
  av._ghComments.set(av._ghCommentsKey('example', row.number), { truncated: false, comments: [{ id: 1, author: 'ada', body: 'cc @​snait' }] });
  assert.match(av._requestThreadRows(row.number).rows[0].bodyHtml, /^\[mentions\]/);
  assert.match(seen[seen.length - 1], /cc @​snait/);

  // Without group-chat.js on the page, the body renders exactly as before.
  const bare = context();
  bare._ghIssues = [row];
  assert.doesNotMatch(bare._topicViewFor('issue', row).body.issueBodyHtml, /\[mentions\]/);
});
