// The Kudos Top users rank note (#4786): a small muted line above the ranked
// list that says ranks are recalculated live, so a person's rank can move
// while they do nothing — kampred's rank jumped 5 → 11 and back with no
// activity of their own, and they asked for "even a tiny note on when ranks
// recalc".
//
// The note only belongs above rows: the empty, loading and error states each
// carry their own message that explains itself, and no other list (Top
// changes, profile, history) ranks people, so none of them gains the note.
//
// Run with: node --test tests/kudos-rank-note.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const USER_ROWS = [{
  key: 'u1', rank: 1, who: 'maya', initial: 'M', unmergedNote: null,
  meta: [{ text: '12 changes kudosed · 9 live' }], mergedKudos: 48,
}];
const PR_ROWS = [{
  key: 'p1', rank: 1, title: 'Add a thing', author: 'jo', authorUnknown: false,
  appName: 'App', badge: { tone: 'emerald', label: 'live' },
  slug: 'app/add-a-thing', sessionId: 1, kudos: 48,
}];

function renderBody(body) {
  const mod = loadTsx('frontend/src/features/leaderboard/kudos-pane.tsx', {
    stubs: {
      './kudos-pane-store.js': {
        kudosPaneStore: {
          get: () => ({ mounted: true, chrome: null, body }),
          subscribe: () => () => {},
        },
      },
    },
  });
  return renderToHtml(createElement(mod.KudosPane, {}));
}

const noteIn = (out) => out.match(/<p data-lb-rank-note=""[^>]*>([^<]*)<\/p>/);

test('the Top users list gains one muted note above its rows', () => {
  const out = renderBody({ kind: 'users', rows: USER_ROWS });
  const note = noteIn(out);
  assert.ok(note, 'the note renders above the ranked list');
  // The words come from the catalog, not a literal in the component.
  assert.equal(note[1], message('leaderboard:kudos.rankNote'));
  assert.ok(out.indexOf('data-lb-rank-note') < out.indexOf('data-lb-user="maya"'),
    'the note sits above the rows, not under them');
  // The row-detail muted style, not the centred empty-state HINT block.
  assert.match(note[0], /text-xs text-zinc-500 dark:text-zinc-400/);
  assert.ok(!note[0].includes('text-center'), 'not the empty-state hint style');
});

test('no other list and no empty, loading or error state carries the note', () => {
  const prs = renderBody({ kind: 'prs', rows: PR_ROWS });
  assert.ok(prs.includes('data-lb-pr-route'), 'the changes list itself rendered');
  assert.ok(!prs.includes('data-lb-rank-note'), 'Top changes does not rank people');

  const empty = renderBody({ kind: 'empty', message: 'No kudos yet.' });
  assert.ok(empty.includes('No kudos yet.'), 'the empty state rendered');
  assert.ok(!empty.includes('data-lb-rank-note'), 'the empty state explains itself');

  const error = renderBody({ kind: 'error', message: 'Couldn’t load leaderboard.' });
  assert.ok(!error.includes('data-lb-rank-note'), 'the error state explains itself');

  const loading = renderBody({ kind: 'loading' });
  assert.ok(!loading.includes('data-lb-rank-note'), 'nothing is ranked while loading');
});

test('the component reads the catalog entry and writes no English literal', () => {
  const source = read('frontend/src/features/leaderboard/kudos-pane.tsx');
  assert.match(source, /'leaderboard:kudos\.rankNote'/);
  assert.ok(!source.includes('Ranks update as people give kudos'),
    'the text lives in the catalog, not in the component');
  // Pinned where it renders: only the users branch, not PrRows' or the body
  // level (which would also dress the empty and error states in it).
  const userRows = source.slice(source.indexOf('function UserRows'), source.indexOf('function ProfileRows'));
  assert.match(userRows, /data-lb-rank-note/);
  const prRows = source.slice(source.indexOf('function PrRows'), source.indexOf('function UserRows'));
  assert.ok(!prRows.includes('rankNote'), 'PrRows carries no rank note');
  const body = source.slice(source.indexOf('function Body('), source.indexOf('export function KudosPane'));
  assert.ok(!body.includes('rankNote'), 'the Body wrapper carries no rank note');
});