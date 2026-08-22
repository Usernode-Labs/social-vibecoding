// The focused proposal view exposes the complete GitHub PR description in a
// collapsed disclosure. Compact cards keep using the short generated summary.
//
// Run with: node --test tests/proposal-body-details.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'), 'utf8'
);
const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8'
);
const VOTES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8'
);
const MIGRATE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrate.js'), 'utf8'
);

function makeAppView(renderMarkdown) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42 } },
    DevChat: { renderMarkdown },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${MERGE_STATUS_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`,
    sandbox
  );
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView.appData = { slug: 'recipe-box' };
  return AppView;
}

test('both live and completed proposal rows include the full PR body', () => {
  assert.match(
    VOTES_SRC,
    /function mergedRowSelect\(\)[\s\S]*?SELECT[^`]*cs\.pr_summary_md, cs\.pr_body,/
  );
  assert.match(
    VOTES_SRC,
    /\/api\/apps\/:slug\/promoted[\s\S]*?SELECT[^`]*cs\.pr_summary_md, cs\.pr_body,/
  );
  assert.match(
    APP_VIEW_SRC,
    /_proposalSummaryHtml\(item\)[\s\S]*?_proposalBodyHtml\(item\)[\s\S]*?_proposalDetailsHtml\(item\)/,
    'the focused topic places the full body between its summary and metadata'
  );
});

test('the proposal staging fixture carries a reviewable full body', () => {
  const fixture = MIGRATE_SRC.slice(
    MIGRATE_SRC.indexOf('async function seedStagingExternalAgentProposal'),
    MIGRATE_SRC.indexOf('\nasync function ', MIGRATE_SRC.indexOf('async function seedStagingExternalAgentProposal') + 1)
  );
  assert.match(fixture, /agent: 'codex',[\s\S]*?body: '## What changed/);
  assert.match(fixture, /pr_summary_md, pr_body/);
  assert.match(fixture, /SET source = 'imported'[\s\S]*?pr_body = \$5/,
    'existing staging rows are restamped, not only newly inserted rows');
});

test('the default open-proposal fixture also exposes the disclosure', () => {
  const start = MIGRATE_SRC.indexOf('async function seedStagingMyOpenPr');
  const fixture = MIGRATE_SRC.slice(
    start,
    MIGRATE_SRC.indexOf('\nasync function ', start + 1)
  );
  assert.match(fixture, /const prBody = '## What changed/);
  assert.match(fixture, /pr_summary_md, pr_body, status/);
  assert.match(fixture, /conflict_checked_at = NOW\(\),\s*pr_body = \$2/,
    'the first/default fixture is restamped when it already exists');
});

test('legacy and blank PR bodies render no disclosure', () => {
  const AppView = makeAppView(() => {
    assert.fail('blank bodies must not reach the Markdown renderer');
  });
  assert.equal(AppView._proposalBodyHtml({ id: 7 }), '');
  assert.equal(AppView._proposalBodyHtml({ id: 7, pr_body: '   ' }), '');
});

test('a full PR body is collapsed and rendered through the Markdown pipeline', () => {
  const seen = [];
  const AppView = makeAppView((md, opts) => {
    seen.push({ md, opts });
    return `<safe-markdown>${md}</safe-markdown>`;
  });
  const html = AppView._proposalBodyHtml({ id: 7, pr_body: '# Why\n\nMore context.' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].md, '# Why\n\nMore context.');
  assert.equal(seen[0].opts.images, true,
    'reviewer screenshots use the Markdown renderer\'s sanitized image mode');
  assert.match(html, /^<details /);
  assert.doesNotMatch(html, /^<details[^>]* open(?: |>|=)/, 'closed by default');
  assert.match(html, />Full proposal details<\/summary>/);
  assert.match(html, /<safe-markdown># Why\n\nMore context\.<\/safe-markdown>/);
  assert.match(html, /ontoggle="AppView\._setProposalBodyOpen\(7, this\.open\)"/);
});

test('the no-Markdown-renderer fallback escapes an untrusted PR body', () => {
  const AppView = makeAppView(undefined);
  const html = AppView._proposalBodyHtml({
    id: 7,
    pr_body: '<img src=x onerror="alert(1)">',
  });

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('the expanded state survives a focused-view repaint', () => {
  const AppView = makeAppView((md) => md);
  AppView._setProposalBodyOpen(7, true);
  assert.match(AppView._proposalBodyHtml({ id: 7, pr_body: 'Details' }), /^<details[^>]* open/);

  AppView._setProposalBodyOpen(7, false);
  assert.doesNotMatch(
    AppView._proposalBodyHtml({ id: 7, pr_body: 'Details' }),
    /^<details[^>]* open/
  );
});

test('compact proposal cards do not render the full body', () => {
  const AppView = makeAppView((md) => `<safe-markdown>${md}</safe-markdown>`);
  const html = AppView._renderProposalCard({
    id: 7,
    pr_number: 700,
    pr_title: 'Add details',
    pr_body: 'UNIQUE FULL BODY COPY',
    username: 'someone',
    user_id: 999,
    status: 'promoted',
    created_at: '2026-08-21T00:00:00Z',
  });

  assert.doesNotMatch(html, /Full proposal details/);
  assert.doesNotMatch(html, /UNIQUE FULL BODY COPY/);
});
