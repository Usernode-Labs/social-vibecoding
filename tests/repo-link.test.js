// What a repository, change, request or commit link is, read from its
// address (frontend/src/lib/repo-link.js).
//
// Since GitHub suspended the account that held the app repositories (25 Oct
// 2026), app code lives on Homeroom's own git host, a request's `htmlUrl` is
// its own page in Homeroom and a proposal's `pr_url` is its change page;
// only the platform's own repository stays on GitHub. Every site that used
// to say "GitHub" for those links asks this one reader instead of matching
// `github.com` itself, so the rule is pinned here once:
//
//   github     github.com (and www.): keeps its GitHub label and mark
//   homeroom   a Homeroom page (`…/#app/…`, `/#app/…`, `#app/…`): opens in
//              place at its route, or is no link where the viewer is on it
//   code       any other web address (the git host): "View code"
//   null       nothing usable: no link
//
// The sites are tests/github-link-decisions.test.js.
//
// Run with: node --test tests/repo-link.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { repoLink: L, installRepoLink, REPO_LINK_RAW } = require('./lib/repo-link');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('a github.com address is GitHub, whatever it names', () => {
  for (const url of [
    'https://github.com/Usernode-Labs/social-vibecoding',
    'https://github.com/Usernode-Labs/social-vibecoding/pull/5821',
    'https://www.github.com/o/r/issues/3',
    'https://github.com/o/r/commit/abc1234',
    '  https://github.com/o/r  ',
  ]) {
    assert.equal(L.linkKind(url), 'github', url);
    assert.equal(L.isGithubUrl(url), true, url);
    assert.equal(L.homeroomRoute(url), null, url);
  }
});

test('a Homeroom page is homeroom, absolute or relative, and its route is the hash', () => {
  const cases = [
    ['https://onhomeroom.com/#app/notes-1a2b3c/dev/issues/12', '#app/notes-1a2b3c/dev/issues/12'],
    ['https://onhomeroom.com/#app/notes-1a2b3c/dev/changes/7', '#app/notes-1a2b3c/dev/changes/7'],
    ['http://localhost:3000/#app/x/dev/changes/2', '#app/x/dev/changes/2'],
    // services/requests.js and native-pulls.js without USERNODE_DOMAIN.
    ['/#app/x/dev/issues/4', '#app/x/dev/issues/4'],
    ['#app/x/dev/issues/4', '#app/x/dev/issues/4'],
  ];
  for (const [url, route] of cases) {
    assert.equal(L.linkKind(url), 'homeroom', url);
    assert.equal(L.homeroomRoute(url), route, url);
    assert.equal(L.isGithubUrl(url), false, url);
  }
});

test('the git host (any other web address) is code', () => {
  for (const url of [
    'https://git.onhomeroom.com/apps/notes-1a2b3c',
    'https://git.onhomeroom.com/apps/notes-1a2b3c/commit/0123456789abcdef',
    'https://git.onhomeroom.com/apps/notes-1a2b3c/src/branch/main',
  ]) {
    assert.equal(L.linkKind(url), 'code', url);
    assert.equal(L.homeroomRoute(url), null, url);
  }
  // A git host page with a hash that is not a Homeroom route stays code.
  assert.equal(L.linkKind('https://git.onhomeroom.com/apps/x#L12'), 'code');
});

test('nothing usable is no link at all', () => {
  for (const url of ['', '   ', null, undefined, 42, 'javascript:alert(1)', 'git@github.com:o/r.git', 'not a url', 'mailto:a@b.c']) {
    assert.equal(L.linkKind(url), null, String(url));
    assert.equal(L.linkAttrs(url), null, String(url));
  }
});

test('linkAttrs: a Homeroom page opens in place, anything else in a new tab with no opener', () => {
  assert.deepEqual({ ...L.linkAttrs('https://onhomeroom.com/#app/x/dev/changes/7') }, { href: '#app/x/dev/changes/7' });
  assert.deepEqual({ ...L.linkAttrs('https://github.com/o/r/pull/7') },
    { href: 'https://github.com/o/r/pull/7', target: '_blank', rel: 'noopener' });
  assert.deepEqual({ ...L.linkAttrs('https://git.onhomeroom.com/apps/x') },
    { href: 'https://git.onhomeroom.com/apps/x', target: '_blank', rel: 'noopener' });
});

test('requestRoute: a request is Homeroom\'s own page for every project', () => {
  assert.equal(L.requestRoute('notes-1a2b3c', 12), '#app/notes-1a2b3c/dev/issues/12');
  assert.equal(L.requestRoute('usernode-2d5619', '5'), '#app/usernode-2d5619/dev/issues/5');
  assert.equal(L.requestRoute('a b', 3), '#app/a%20b/dev/issues/3', 'the slug is encoded');
  for (const [slug, n] of [['', 3], [null, 3], ['x', 0], ['x', -1], ['x', 1.5], ['x', 'abc']]) {
    assert.equal(L.requestRoute(slug, n), '', `${slug} ${n}`);
  }
});

test('it publishes itself as window.RepoLink, and the shell entry imports it before anything renders', () => {
  assert.match(REPO_LINK_RAW, /if \(typeof window !== 'undefined'\) \{\n\s+\/\*\* @type \{any\} \*\/ \(window\)\.RepoLink = RepoLink;\n\}/);
  assert.match(read('frontend/src/main.tsx'), /^import '\.\/lib\/repo-link\.js';$/m);
  // Plain JS with no import: the vm-evaluated modules' tests run its text.
  assert.doesNotMatch(REPO_LINK_RAW, /^import /m);
  const sandbox = {};
  const links = installRepoLink(sandbox);
  assert.equal(sandbox.RepoLink, links);
  assert.equal(links.linkKind('https://github.com/o/r'), 'github');
});
