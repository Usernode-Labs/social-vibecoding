// #1914 — every challenge card wears its kind's icon, on BOTH surfaces.
//
// Home's block has drawn one since the kind icon landed: its panel query
// joins `challenge_kinds` and `HomePanels.challengeRowView` copies it onto
// the row. The Challenges screen drew an empty neutral tile for every card,
// and not because the tile was broken — `ChallengeTile` renders whatever
// `view.icon` holds, and tests/challenge-card-render.test.js already pins
// that. The payload behind that screen simply never carried one.
//
// So this pins the two seams that were missing, one per layer:
//   * the public list item publishes `card_preview.icon` from the joined
//     `kind_icon`, and null when the caller did not join it;
//   * the pane's `cardView` copies it onto the card view.
//
// Run with: node --test tests/challenge-kind-icon.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const { buildChallengeListItem } = require(path.join(root, 'src/routes/topochain/challenge-view.js'));

// A joined row, reduced to what buildChallengeListItem reads.
const row = (over) => ({
  id: 7,
  season_event_id: 3,
  challenge_template_id: 11,
  enabled: true,
  completed: false,
  t_id: 11,
  t_category: 'onboarding',
  ...over,
});

test('the public list item publishes the kind icon it was joined', () => {
  const item = buildChallengeListItem(row({ kind_icon: '🧪' }));
  assert.equal(item.card_preview.icon, '🧪');
});

test('a challenge whose kind is unset or has no icon publishes null, not undefined', () => {
  // `undefined` would vanish through JSON.stringify and leave the client
  // unable to tell "no icon" from "field not in this payload version".
  const missing = buildChallengeListItem(row());
  assert.equal(missing.card_preview.icon, null);
  assert.ok('icon' in missing.card_preview, 'the key is always present');
  assert.equal(buildChallengeListItem(row({ kind_icon: null })).card_preview.icon, null);
});

test('the public challenges query joins the kind the challenge resolves to', () => {
  // The icon is only ever as good as the join: the challenge's own kind
  // overrides its template's, which is the COALESCE Home's query uses too.
  const src = fs.readFileSync(path.join(root, 'src/routes/topochain/public.js'), 'utf8');
  assert.match(src, /ck\.icon AS kind_icon/);
  assert.match(src, /LEFT JOIN challenge_kinds ck ON ck\.id = COALESCE\(c\.kind, ct\.kind\)/);
});

// ── the pane's card view ──────────────────────────────────────────────

function loadPane() {
  const src = fs.readFileSync(
    path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8'
  );
  const sandbox = {
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: {},
    console,
    setTimeout,
    clearTimeout,
    location: { hash: '', search: '' },
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ success: true, data: [] }) }),
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'topochain-challenges.js' });
  const pane = sandbox.window.TopochainChallenges;
  pane._mine = new Map();
  return pane;
}

const challenge = (cardPreview) => ({
  id: 7,
  completed: false,
  effective: {},
  card_preview: { goal: 'Try three apps', ...cardPreview },
});

test('cardView carries the icon the payload gave it', () => {
  const pane = loadPane();
  assert.equal(pane.cardView(challenge({ icon: '🧪' }), 0).icon, '🧪');
});

test('cardView leaves the tile empty rather than blank-stringing it', () => {
  // '' would render an empty <span> inside the tile; null is the shape
  // ChallengeTile checks, and it draws the neutral face instead.
  const pane = loadPane();
  assert.equal(pane.cardView(challenge({}), 0).icon, null);
  assert.equal(pane.cardView(challenge({ icon: '' }), 0).icon, null);
  assert.equal(pane.cardView(challenge({ icon: '   ' }), 0).icon, null);
});

test('an over-long icon is capped, the way Home caps its own', () => {
  // The column is VARCHAR(16) and the tile is an 80px square: a kind whose
  // "icon" is a word must not stretch the tile on this screen when it does
  // not on Home.
  const pane = loadPane();
  assert.equal(pane.cardView(challenge({ icon: 'abcdefghijkl' }), 0).icon.length, 8);
});
