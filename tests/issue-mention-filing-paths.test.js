'use strict';

// #3952: every way a request is filed tells the people its text names with
// @ (services/notifications.js notifyIssueMentions), after the request
// exists and without waiting on it. The behaviour itself is pinned against
// a real database in tests/issue-mention-notifications-postgres.test.js;
// this pins that no filing path is left out, since a path that forgets the
// call fails silently: the request files and nobody hears.
//
// #4271: the two paths that also tell a project's new-request followers
// ('issue_opened') make one call for both, notifyIssueFiled, which writes
// the mentions first and leaves the people they told out of the other.
// Two separate calls there would race and tell a mentioned follower twice.
//
// Run with: node --test tests/issue-mention-filing-paths.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// [file, what files the request, how many filing sites it has, the call]
const PATHS = [
  // The in-app form and the connector's create_request (mcp-tools.js posts here).
  ['src/routes/issues.js', /github\.createIssue\(parsed\.owner, parsed\.repo, \{/, 1, 'notifyIssueFiled'],
  // The feedback dialog: a project's own repo, and the platform's.
  ['src/routes/feedback.js', /announceIssueCreated\(pool, issueOwner, issueRepo, issue,/, 2, 'notifyIssueMentions'],
  // An agent's drafted report, once a person confirms it.
  ['src/routes/sessions.js', /issueAnnounce\.announceIssueCreated\(pool, owner, repo, issue,/, 1, 'notifyIssueMentions'],
  // Homeroom bot filing a request from a DM or a project's chat.
  ['src/services/homeroom-bot-mayor.js', /github\.createIssue\(m\[1\], m\[2\], \{/, 1, 'notifyIssueFiled'],
  // A project's first request, from its creator's description.
  ['src/services/homeroom-bot-dm.js', /github\.createIssue\(parsed\.owner, parsed\.repo, \{/, 1, 'notifyIssueMentions'],
  // Homeroom bot filing a report to the Homeroom team for a person.
  ['src/services/feedback-reports.js', /announceIssueCreated\(pool, owner, repo, issue, null\)/, 1, 'notifyIssueMentions'],
];

for (const [file, filing, sites, fn] of PATHS) {
  test(`${file} tells the people a filed request names`, () => {
    const src = read(file);
    assert.equal((src.match(new RegExp(filing.source, 'g')) || []).length, sites, 'the filing sites are where they were');
    const calls = src.match(new RegExp(`${fn}\\?\\.\\(pool, \\{[\\s\\S]*?\\}\\);`, 'g')) || [];
    assert.equal(calls.length, sites, 'one call per filing site');
    for (const call of calls) {
      assert.match(call, /issueNumber/, 'names the request');
      assert.match(call, /authorId: /, 'names who filed it, who is never told');
      assert.match(call, /text: [^`\n]*`\$\{/, 'reads the title and body as they were written');
      assert.ok(src.indexOf(call) > src.search(filing), 'after the request exists');
    }
    assert.doesNotMatch(src, /await [^;\n]*notifyIssue(?:Mentions|Filed)/, 'never holds up the filing');
    // #4271: the new-request row is never fanned out beside the mentions.
    assert.doesNotMatch(src, /createIssueOpenedNotifications/, 'issue_opened goes through notifyIssueFiled');
  });
}
