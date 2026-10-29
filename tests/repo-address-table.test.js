// One table of repository addresses, run through both sides of the rule
// "is this app's stored address (apps.repo_url) a repository" (#6016).
//
//   server   src/services/repo-ref.js `parse`: what the request routes and
//            every other server gate accept.
//   browser  frontend/src/lib/repo-link.js `isRepoAddress`: whether the
//            feedback dialog and comment mode offer "this app" as a
//            request's target. Both screens call that one helper.
//
// #5887: the server learned Homeroom's git host (a83033367) while the
// browser's two hand-copied regexes still matched only github.com, so "this
// app" was greyed out for every project. Each row says what both sides must
// answer, so a change to either that the other does not follow fails here.
//
// The browser cannot know which host is the git host, or under which path
// (GIT_HOST_URL is the server's), so it stays as loose as the screens' rule
// has been since #5940: any http(s) host followed by at least two path
// segments, plus GitHub's ssh form. The difference is allowed only in that
// direction: the browser may offer an address the server then refuses, never
// refuse one the server accepts, nor one the old screens accepted.
//
// Run with: node --test tests/repo-address-table.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRef = require('../src/services/repo-ref');
const { repoLink } = require('./lib/repo-link');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HOMEROOM = 'https://git.onhomeroom.com';
const FORGEJO = 'https://forge.example.org';
const FORGEJO_SUBPATH = 'https://forge.example.org/git';

// The screens' own copies before #6016 (feedback-controller.js once,
// comment-pin.tsx twice): the browser must stay at least this loose.
const OLD_SCREEN_RULE = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+/;

// [address, the git host the server runs with, server accepts, browser accepts]
const TABLE = [
  // GitHub
  ['https://github.com/Usernode-Labs/social-vibecoding', HOMEROOM, true, true],
  ['https://github.com/acme/example-app.git', HOMEROOM, true, true],
  ['https://github.com/acme/example-app/', HOMEROOM, true, true],
  ['https://www.github.com/acme/example-app', HOMEROOM, true, true],
  ['http://github.com/acme/example-app', HOMEROOM, true, true],
  ['https://github.com/acme/example-app?tab=readme', HOMEROOM, true, true],
  ['  https://github.com/acme/example-app  ', HOMEROOM, true, true],
  ['git@github.com:acme/example-app.git', HOMEROOM, true, true],
  ['git@github.com:acme/example-app', HOMEROOM, true, true],
  // Homeroom's git host
  ['https://git.onhomeroom.com/apps/mountain-trail', HOMEROOM, true, true],
  ['https://git.onhomeroom.com/apps/mountain-trail.git', HOMEROOM, true, true],
  ['https://git.onhomeroom.com/apps/mountain-trail/', HOMEROOM, true, true],
  ['https://GIT.onhomeroom.com/apps/mountain-trail', HOMEROOM, true, true],
  ['https://git.onhomeroom.com/someone/fork-of-trail', HOMEROOM, true, true],
  // A self-hosted Forgejo, configured as the git host
  ['https://forge.example.org/apps/tier-list', FORGEJO, true, true],
  ['https://forge.example.org/team.one/tier_list.v2.git', FORGEJO, true, true],
  // ... and one served under a path (GIT_HOST_URL=https://forge.example.org/git)
  ['https://forge.example.org/git/apps/tier-list', FORGEJO_SUBPATH, true, true],
  ['https://forge.example.org/git/apps/tier-list.git', FORGEJO_SUBPATH, true, true],
  // The allowed one-way difference: the server refuses, the browser offers
  // (a host or path the server is not configured for, or more than an
  // owner and a name, which the old screens accepted too)
  ['https://forge.example.org/apps/tier-list', HOMEROOM, false, true],
  ['https://git.onhomeroom.com/apps/mountain-trail', FORGEJO, false, true],
  ['https://forge.example.org/git/apps/tier-list', FORGEJO, false, true],
  ['https://github.com/acme/example-app/tree/main', HOMEROOM, false, true],
  ['https://github.com/acme/example-app/pull/12', HOMEROOM, false, true],
  ['https://git.onhomeroom.com/apps/mountain-trail/src/branch/main', HOMEROOM, false, true],
  ['https://git.onhomeroom.com/apps/mountain-trail?x=1', HOMEROOM, false, true],
  ['https://forge.example.org/apps/tier-list/commit/abc1234', FORGEJO, false, true],
  ['https://github.com/acme/exa mple', HOMEROOM, false, true],
  ['https://app.onhomeroom.com/#app/mountain-trail/dev', HOMEROOM, false, true],
  // Malformed: neither side takes them
  ['', HOMEROOM, false, false],
  ['   ', HOMEROOM, false, false],
  [null, HOMEROOM, false, false],
  [undefined, HOMEROOM, false, false],
  ['mountain-trail', HOMEROOM, false, false],
  ['https://github.com/acme', HOMEROOM, false, false],
  ['https://github.com/', HOMEROOM, false, false],
  ['https://git.onhomeroom.com/apps', HOMEROOM, false, false],
  ['ftp://github.com/acme/example-app', HOMEROOM, false, false],
  ['javascript:alert(1)//github.com/acme/example-app', HOMEROOM, false, false],
  ['git@gitlab.com:acme/example-app.git', HOMEROOM, false, false],
  ['git@github.com:acme', HOMEROOM, false, false],
];

function serverAccepts(url, gitHostUrl) {
  const saved = process.env.GIT_HOST_URL;
  const savedInternal = process.env.GIT_HOST_INTERNAL_URL;
  process.env.GIT_HOST_URL = gitHostUrl;
  delete process.env.GIT_HOST_INTERNAL_URL;
  try {
    return !!repoRef.parse(url);
  } finally {
    if (saved === undefined) delete process.env.GIT_HOST_URL; else process.env.GIT_HOST_URL = saved;
    if (savedInternal === undefined) delete process.env.GIT_HOST_INTERNAL_URL;
    else process.env.GIT_HOST_INTERNAL_URL = savedInternal;
  }
}

for (const [url, gitHost, server, browser] of TABLE) {
  test(`${JSON.stringify(url)} with the git host at ${gitHost}`, () => {
    assert.equal(serverAccepts(url, gitHost), server, 'repo-ref.js parse');
    assert.equal(repoLink.isRepoAddress(url), browser, 'repo-link.js isRepoAddress');
  });
}

test('the browser accepts everything the server or the old screens accepted (#5887)', () => {
  for (const [url, gitHost] of TABLE) {
    if (serverAccepts(url, gitHost)) {
      assert.equal(repoLink.isRepoAddress(url), true, `${url} is a repository to the server`);
    }
    if (OLD_SCREEN_RULE.test(url || '')) {
      assert.equal(repoLink.isRepoAddress(url), true, `${url} was offered by the old screens`);
    }
  }
});

test('the feedback dialog and comment mode both ask the one helper', () => {
  const sites = {
    'frontend/src/features/dialogs/feedback-controller.js': 1,
    'frontend/src/features/comment-pin/comment-pin.tsx': 2,
  };
  for (const [file, calls] of Object.entries(sites)) {
    const src = read(file);
    assert.match(src, /^import \{ isRepoAddress \} from '\.\.\/\.\.\/lib\/repo-link\.js';$/m, file);
    assert.equal(src.match(/isRepoAddress\(\w+\?\.repo_url\)|isRepoAddress\(data\.repo_url\)/g)?.length, calls, file);
    // No hand-written copy of the rule left beside it.
    assert.doesNotMatch(src, /\.test\([^)]*repo_url/, file);
    assert.doesNotMatch(src, /\.test\(repoUrl\)/, file);
  }
});
