// #7134: the standard profile's Projects · Changes · Requests · Votes ·
// Activity row is real tabs, not five links to other pages.
//
//   1. ProfileSectionLinks draws five anchors that name the profile's own
//      tabs, lights only the tab that is up, and switches the column in place
//      on a plain click.
//   2. ProfileRoot's standard branch swaps the right column on the store's
//      tab, and keeps Projects' four blocks for the overview.
//   3. ProfileHistoryList draws one kind of the person's finished work in the
//      profile's own row markup, with the History card's words for its
//      loading, empty, failed and paging states.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

function sectionLinks(tab) {
  const shown = [];
  const { ProfileSectionLinks } = loadTsx('frontend/src/features/profile/profile-preferences.tsx', {
    stubs: {
      '../../lib/i18n/react': { useMessages: () => (id) => id },
      './profile.js': { Profile: { showTab: (next) => shown.push(next) } },
    },
  });
  return { html: renderToHtml(createElement(ProfileSectionLinks, { tab })), shown };
}

test('the section row draws the profile\'s five tabs and lights the one that is up', () => {
  const { html } = sectionLinks('changes');
  const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [
    '#profile',
    '#profile?tab=changes',
    '#profile?tab=requests',
    '#profile?tab=votes',
    '#profile?tab=activity',
  ], 'every tab has the profile\'s own address');
  assert.doesNotMatch(html, /homeroom-bot/, 'no tab sends the person off the profile');
  const current = [...html.matchAll(/<a href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
  assert.deepEqual(current, ['#profile?tab=changes'], 'only the tab that is up is current');
  for (const tab of ['requests', 'votes', 'activity']) {
    assert.match(sectionLinks(tab).html, new RegExp(`<a href="#profile\\?tab=${tab}" aria-current="page"`));
  }
  // A tab of another look is no tab here, so the row falls back to Projects.
  assert.match(sectionLinks('friends').html, /<a href="#profile" aria-current="page"/);
});

test('a plain click switches the tab on the profile page; a modified click keeps the link', () => {
  const { ProfileSectionLinks } = loadTsx('frontend/src/features/profile/profile-preferences.tsx', {
    stubs: {
      '../../lib/i18n/react': { useMessages: () => (id) => id },
      './profile.js': { Profile: { showTab: (next) => shown.push(next) } },
    },
  });
  const shown = [];
  const html = renderToHtml(createElement(ProfileSectionLinks, { tab: 'overview' }));
  assert.match(html, /#profile\?tab=activity/);
  // The handler is not serialized: read the source's contract instead.
  const src = read('frontend/src/features/profile/profile-preferences.tsx');
  assert.match(src, /event\.preventDefault\(\);\n\s+Profile\.showTab\(key as YouTab\);/);
  assert.match(src, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/, 'a modified click keeps the link');
  assert.deepEqual(shown, []);
});

test('the standard profile switches its right column on the tab and keeps Projects for the overview', () => {
  const src = read('frontend/src/features/profile/profile-view.tsx');
  assert.match(src, /const tab = state\.tab \|\| 'overview';/);
  assert.match(src, /<ProfileSectionLinks tab=\{tab\} \/>/);
  assert.match(src, /<ProfileHistoryList kind=\{HISTORY_KIND\[tab as keyof typeof HISTORY_KIND\]\} \/>/);
  assert.match(src, /<ProfileRecentActivity changes=\{contributions\} limit=\{5\} empty \/>/);
  assert.match(src, /<ProfileLiveProjects changes=\{contributions\} \/>/);
  assert.match(src, /!onHistoryTab && tab !== 'activity'/, 'the overview keeps its four blocks');
});

function historyList(state, lines) {
  const { ProfileHistoryList } = loadTsx('frontend/src/features/profile/profile-history-list.tsx', {
    stubs: {
      '../../lib/i18n/react': { useMessages: () => (id) => id },
      '../ai/history': { useHistory: () => state },
      '../ai/lines': { useAiLines: () => ({ historyLines: lines }) },
    },
  });
  return renderToHtml(createElement(ProfileHistoryList, { kind: state.kind || 'change' }));
}

test('the history tab reads after mount and shows the loading line first', () => {
  const html = historyList({ ready: false, loading: false, failed: false, rows: [], next: null, more: () => {}, retry: () => {} }, []);
  assert.equal((html.match(/id="profile-history"/g) || []).length, 1);
  assert.match(html, /messages:ai\.history\.loading/);
  assert.match(html, /<ul><li class="profile-history-state">messages:ai\.history\.loading<\/li><\/ul>/, 'the loading line sits in the paper card');
});

test('a history tab draws its rows in the profile card, with the project, title and end', () => {
  const html = historyList({
    ready: true, loading: false, failed: false, next: null,
    rows: [{ key: 'a', href: '#app/garden/dev/changes/3/12' }],
    more: () => {}, retry: () => {},
  }, [{
    key: 'a', title: 'A <change>', app: { name: 'Garden', slug: 'garden' }, sub: 'Went live today', end: { kind: 'tick', text: 'Live' },
  }]);
  assert.match(html, /<section id="profile-history" data-profile-history="change">/);
  assert.match(html, /href="#app\/garden\/dev\/changes\/3\/12"/, 'the row opens its item');
  assert.match(html, /<strong>Garden<\/strong>/);
  assert.match(html, /A &lt;change&gt;/);
  assert.match(html, /class="profile-history-end">Went live today</);
  assert.match(html, /class="profile-recent-icon"><svg/, 'a live row wears the tick');
});

test('the history tab says when it is empty or could not be read, and pages earlier months', () => {
  const base = { ready: true, loading: false, failed: false, rows: [], next: null, more: () => {}, retry: () => {} };
  assert.match(historyList(base, []), /messages:ai\.history\.empty/);
  assert.match(historyList({ ...base, failed: true }, []), /messages:ai\.history\.failed[\s\S]*core:common\.tryAgain/);
  assert.match(historyList({ ...base, next: '/api/ai/history?before=x' }, []), /messages:ai\.history\.earlier/);
});
