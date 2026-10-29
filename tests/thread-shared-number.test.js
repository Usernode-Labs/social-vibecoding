'use strict';

// #6019 follow-up, 29 Oct: a change and an unrelated request can share a
// number on a project still on GitHub (Change #6002, Request #6002). The
// Postgres suites (threads-postgres, thread-shared-number-postgres,
// requests-postgres) hold the schema rule, the one-time pass and the reads;
// this holds the page's side: a change's page asks for ITS thread, and the
// AI tab names a change's own numberless thread by the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('a change\'s page reads its thread as the change\'s, by its own pull request number', () => {
  const route = read('src/routes/threads.js');
  assert.match(route, /asChange: req\.query\.as === 'change',/);
  const items = read('frontend/src/features/dev-board/topic/thread-items.tsx');
  assert.match(items, /`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/threads\/\$\{number\}\$\{asChange \? '\?as=change' : ''\}`/);
  assert.match(items, /useThreadPayload\(slug, number, threadId, controlled, asChange\)/);
  const head = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(head, /threadNumber=\{Number\(session\?\.pr_number\) \|\| Number\(linkedIssues\[0\]\) \|\| null\} threadAsChange=\{Number\(session\?\.pr_number\) > 0\}/);
  assert.match(read('frontend/src/features/dev-board/topic/change-head.tsx'),
    /<ThreadItems slug=\{pageSlug\(\)\} number=\{threadNumber\} asChange=\{threadAsChange\} here=\{\{ type: 'change', id \}\} \/>/);
});

test('the AI tab names a change\'s own numberless thread by the change', () => {
  const { arrange } = require('../src/services/ai-work');
  const row = {
    id: 9, number: null, kind: 'work', thread_title: null, state: 'open', created_at: '2026-10-29T11:16:00Z',
    slug: 'usernode-2d5619', name: 'Homeroom', request_title: null, request_state: null,
    change_id: 11720, pr_number: 6002, change_status: 'promoted', change_user: 7, change_title: 'SEC-09',
    promoted_at: '2026-10-29T11:18:00Z', voted: false,
  };
  // Up for a vote and waiting on other people's: Up next (29 Oct 2026).
  const { waiting } = arrange([row], 7, new Date('2026-10-29T15:00:00Z'));
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].number, 6002);
  assert.equal(waiting[0].href, '#app/usernode-2d5619/dev/changes/6002');
  assert.equal(waiting[0].title, 'SEC-09');
});
