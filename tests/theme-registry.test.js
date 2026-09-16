// The merge of the Workshop's AI grouping with the community-voted
// attributes onto ONE mechanism (src/db/schema.sql `app_theme_registry`).
//
// What this pins, in the order the pieces have to hold:
//
//   * ONE SLUG. A member typing "Signing in" and the model drafting a theme
//     it calls `signing-in` must land on the same key, or a vote can never
//     name a theme the model drew — which is the whole feature.
//   * A GENERATIONAL registry. Discovery re-drafts an app's entire
//     vocabulary every run while the cap is 24; if the registry only ever
//     INSERTed, the model's churn would exhaust it within weeks and no new
//     theme could ever be minted again. So a draft retires what it dropped,
//     the cap counts LIVE rows, and a retired row is revived rather than
//     duplicated.
//   * A VOTE PINS. A theme the group has voted into is never retired by a
//     later draft, and comes back even when the model omits it. The prompt
//     is asked; `keepPinned` and the SQL's `pinned_at IS NULL` enforce —
//     a rule a model can ignore is not a guarantee.
//   * A VOTE OVERRIDES. The model's placement is a seed; the group's answer
//     wins at read time, without being written back into placements_json
//     where a re-draft could overwrite it or churn could be triggered by it.
//
// Run with: node --test tests/theme-registry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const attrs = require('../src/services/topic-attributes');

// A pool that answers by matching the SQL it is sent. Each entry is
// [pattern, handler]; the first match wins and everything else is an empty
// result, so a test declares only the reads it cares about.
function fakePool(routes) {
  const sent = [];
  return {
    sent,
    async query(sql, params) {
      sent.push({ sql, params });
      for (const [pattern, handler] of routes) {
        if (pattern.test(sql)) {
          return typeof handler === 'function' ? handler(params, sql) : handler;
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('one slug function: a typed theme and the model’s drafted id meet on the same key', () => {
  // The model's own ids come from this function (services/workshop-themes.js
  // assigns `slugify(t.name)`), so these two ARE the same call.
  assert.equal(attrs.slugifyTheme('Signing in'), 'signing-in');
  assert.deepEqual(attrs.normalizeThemeInput('  Signing   in '), { slug: 'signing-in', label: 'Signing in' });
  // Casing and inner whitespace collapse, so "SIGNING IN" votes for the
  // existing theme rather than minting a near-duplicate beside it.
  assert.equal(attrs.normalizeThemeInput('SIGNING IN').slug, 'signing-in');
  // A theme gets more room than a category chip, and still has a ceiling.
  assert.equal(attrs.normalizeThemeInput('x'.repeat(attrs.MAX_THEME_LEN)).slug.length > 0, true);
  assert.equal(attrs.normalizeThemeInput('x'.repeat(attrs.MAX_THEME_LEN + 1)), null);
  // Pure punctuation is not a theme, and neither is a non-string.
  assert.equal(attrs.normalizeThemeInput('---'), null);
  assert.equal(attrs.normalizeThemeInput(''), null);
  assert.equal(attrs.normalizeThemeInput(null), null);
  // `theme` is a field of the shared vote table now, not a system of its own.
  assert.ok(attrs.FIELDS.includes('theme'));
  assert.equal(attrs.normalizeValue('theme', 'Game Corner'), 'game-corner');
});

test('the cap counts LIVE rows, so a model that re-drafts daily never exhausts it', async () => {
  // Every slot taken, and all of them retired: the app is at its all-time
  // total but holds nothing, so the next draft mints freely. An append-only
  // registry is exactly what this would have blocked for good.
  const pool = fakePool([
    [/FROM app_theme_registry\s+WHERE app_id = \$1 AND theme_key/, { rows: [] }],
    [/COUNT\(\*\)::int AS live/, { rows: [{ live: 0 }] }],
  ]);
  await attrs.ensureTheme(pool, 7, { slug: 'new-theme', label: 'New theme' }, null, { pin: false });
  const insert = pool.sent.find((q) => /INSERT INTO app_theme_registry/.test(q.sql));
  assert.ok(insert, 'a fresh theme is minted');
  assert.equal(insert.params[5], 'ai', 'and attributed to the model, not a member');
  assert.equal(insert.params[7], null, 'an AI draft does not pin');

  // At the live cap, a NEW key is refused — the group is holding every slot.
  const full = fakePool([
    [/FROM app_theme_registry\s+WHERE app_id = \$1 AND theme_key/, { rows: [] }],
    [/COUNT\(\*\)::int AS live/, { rows: [{ live: attrs.MAX_THEMES_PER_APP }] }],
  ]);
  await assert.rejects(
    () => attrs.ensureTheme(full, 7, { slug: 'one-too-many', label: 'One too many' }, null, {}),
    (err) => err.message === attrs.THEME_CAP_ERROR
  );
  assert.ok(!full.sent.some((q) => /INSERT INTO app_theme_registry/.test(q.sql)), 'and nothing is written');
});

test('a retired theme is revived, never duplicated, and a member’s vote pins it', async () => {
  const pool = fakePool([
    [/FROM app_theme_registry\s+WHERE app_id = \$1 AND theme_key/, { rows: [{ id: 3, live: false }] }],
    [/COUNT\(\*\)::int AS live/, { rows: [{ live: 1 }] }],
  ]);
  await attrs.ensureTheme(pool, 7, { slug: 'signing-in', label: 'Signing in' }, 42, { pin: true });
  const revive = pool.sent.find((q) => /SET\s+retired_at\s+= NULL/.test(q.sql));
  assert.ok(revive, 'the existing row comes back rather than a second row being inserted');
  assert.equal(revive.params[5], true, 'and the vote that revived it pins it');
  assert.ok(!pool.sent.some((q) => /INSERT INTO app_theme_registry/.test(q.sql)));

  // Reviving consumes a live slot, so it goes through the cap like a mint.
  const full = fakePool([
    [/FROM app_theme_registry\s+WHERE app_id = \$1 AND theme_key/, { rows: [{ id: 3, live: false }] }],
    [/COUNT\(\*\)::int AS live/, { rows: [{ live: attrs.MAX_THEMES_PER_APP }] }],
  ]);
  await assert.rejects(
    () => attrs.ensureTheme(full, 7, { slug: 'signing-in', label: 'Signing in' }, 42, { pin: true }),
    (err) => err.message === attrs.THEME_CAP_ERROR
  );
});

test('retirement spares a pinned theme, in SQL rather than on trust', async () => {
  const pool = fakePool([[/UPDATE app_theme_registry/, { rows: [{ theme_key: 'dropped' }] }]]);
  const retired = await attrs.retireThemesExcept(pool, 7, ['kept', 'kept']);
  assert.deepEqual(retired, ['dropped']);
  const q = pool.sent[0];
  // The three clauses that make retirement safe. `pinned_at IS NULL` is the
  // protection rule and it is checked HERE, not asked of the prompt: a theme
  // somebody voted for cannot be retired by a model that stopped naming it.
  assert.match(q.sql, /retired_at IS NULL/);
  assert.match(q.sql, /pinned_at IS NULL/);
  assert.match(q.sql, /NOT \(theme_key = ANY\(\$2::text\[\]\)\)/);
  // A stamp, never a DELETE, so the votes and placements pointing at the
  // theme can never dangle.
  assert.match(q.sql, /SET\s+retired_at = NOW\(\)/);
  assert.ok(!/DELETE/i.test(q.sql));
  assert.deepEqual(q.params[1], ['kept'], 'the keep list is deduped');
});

test('a theme vote registers and PINS; a category vote does neither', async () => {
  const pool = fakePool([
    [/FROM app_theme_registry\s+WHERE app_id = \$1 AND theme_key/, { rows: [{ id: 9, live: true }] }],
  ]);
  await attrs.castVote(pool, 7, 'issue', 12, 'theme', 'signing-in', 42, [], 'Signing in');
  const pin = pool.sent.find((q) => /UPDATE app_theme_registry/.test(q.sql));
  assert.ok(pin, 'the registry row is touched');
  assert.equal(pin.params[5], true, 'and pinned, because a human cast this');
  const vote = pool.sent.find((q) => /INSERT INTO topic_attribute_votes/.test(q.sql));
  assert.ok(vote, 'the vote lands in the SAME table every other attribute uses');
  assert.equal(vote.params[3], 'theme');
  assert.equal(vote.params[4], 'signing-in', 'the slug is the stored value, not the typed label');
});

// ── The overlay: the group's answer beats the model's ─────────────────

const svc = require('../src/services/workshop-themes');

const ROW = (over) => ({
  themes: [
    { id: 'signing-in', name: 'Signing in', description: 'Auth', saying: null, icon: '\u{1F511}' },
    { id: 'game-corner', name: 'Game Corner', description: 'Games', saying: null, icon: '\u{1F3AE}' },
  ],
  placements: { 'issue:12': 'signing-in', 'issue:13': 'game-corner' },
  unplaced: [],
  ...over,
});

test('a member’s vote moves a card off the model’s placement', () => {
  const row = ROW();
  const keys = ['issue:12', 'issue:13'];
  const placed = svc.themesWithItems(row, keys, row.placements);
  assert.deepEqual(placed.map((t) => t.items), [['issue:12'], ['issue:13']], 'the model’s grouping');

  // One vote, and the card sits where the group put it instead.
  const voted = svc.themesWithItems(row, keys, row.placements, { 'issue:12': 'game-corner' });
  assert.deepEqual(voted.map((t) => t.items), [[], ['issue:12', 'issue:13']]);

  // A vote naming a theme that is no longer in the vocabulary falls THROUGH
  // to the placement rather than dropping the card off the board entirely.
  const stale = svc.themesWithItems(row, keys, row.placements, { 'issue:12': 'retired-theme' });
  assert.deepEqual(stale.map((t) => t.items), [['issue:12'], ['issue:13']]);
});

test('a theme only the registry knows is still drawn, so a vote can never point at nothing', () => {
  const row = ROW();
  const keys = ['issue:12', 'issue:13'];
  // A member minted "Onboarding" by typing it; the model's standing draft
  // predates it and does not contain it.
  const registry = [{ id: 'onboarding', name: 'Onboarding', description: 'First run', icon: '', pinned: true }];
  const out = svc.themesWithItems(row, keys, row.placements, { 'issue:13': 'onboarding' }, registry);
  const onboarding = out.find((t) => t.id === 'onboarding');
  assert.ok(onboarding, 'the member’s own theme is drawn');
  assert.deepEqual(onboarding.items, ['issue:13']);
  assert.deepEqual(out.find((t) => t.id === 'game-corner').items, [], 'and the card left where it was');
});

test('keepPinned re-adds a pinned theme the model dropped', () => {
  const drafted = [{ id: 'game-corner', name: 'Game Corner', description: 'Games', saying: null, icon: '', anchors: [] }];
  const previous = [
    { id: 'game-corner', name: 'Game Corner', pinned: false },
    { id: 'signing-in', name: 'Signing in', description: 'Auth', icon: '\u{1F511}', pinned: true },
    { id: 'gone', name: 'Gone', pinned: false },
  ];
  const kept = svc.keepPinned(drafted, previous);
  assert.deepEqual(kept.map((t) => t.id), ['game-corner', 'signing-in'],
    'the pinned theme comes back; the unpinned one the model dropped does not');
  const revived = kept.find((t) => t.id === 'signing-in');
  assert.equal(revived.name, 'Signing in', 'with its name intact — the group chose it');
  assert.equal(revived.icon, '\u{1F511}');
  assert.deepEqual(revived.anchors, [], 'and no anchors it was not given');
  // Idempotent: a draft that DID return the pinned theme is left alone.
  assert.equal(svc.keepPinned(kept, previous).length, 2);
});

test('board keys address the vote table, and a session outranks a governance ref', async () => {
  assert.deepEqual(svc.targetOfKey('issue:12'), { targetType: 'issue', ref: 12 });
  assert.deepEqual(svc.targetOfKey('session:34'), { targetType: 'proposal', ref: 34 });
  assert.deepEqual(svc.targetOfKey('gov:34'), { targetType: 'proposal', ref: 34 });
  assert.equal(svc.targetOfKey('nonsense'), null);
  assert.equal(svc.targetOfKey('issue:0'), null, 'a ref is a positive integer');

  // `session:` and `gov:` collide on ('proposal', N) — the same ambiguity the
  // Dev board's own card-order overlay carries. The first key wins, and the
  // snapshot lists sessions before governance rows, so the session card does.
  const pool = fakePool([]);
  const votes = await svc.loadThemeVotes(pool, 7, ['session:34', 'gov:34']);
  assert.deepEqual(votes, {}, 'no votes, no overlay');
  const proposalQueries = pool.sent.filter((q) => /target_type = \$2/.test(q.sql));
  for (const q of proposalQueries) {
    assert.deepEqual(q.params[2], [34], 'the ref is asked for once, not twice');
  }
});

test('the first vote on a pre-placements row does not drop every other card', () => {
  // A row written before placements_json existed carries `items` on the
  // definitions themselves. Those are still the grouping for every card
  // nobody has voted on, so one vote must not take the rest of the board
  // with it — which is exactly what reading `placements` unconditionally in
  // the vote branch would have done.
  const legacyRow = {
    themes: [
      { id: 'signing-in', name: 'Signing in', description: '', saying: null, icon: '', items: ['issue:12', 'issue:13'] },
      { id: 'game-corner', name: 'Game Corner', description: '', saying: null, icon: '', items: ['issue:14'] },
    ],
    placements: {},
    unplaced: [],
  };
  const keys = ['issue:12', 'issue:13', 'issue:14'];
  const out = svc.themesWithItems(legacyRow, keys, {}, { 'issue:12': 'game-corner' });
  assert.deepEqual(out.find((t) => t.id === 'signing-in').items, ['issue:13'],
    'the unvoted card keeps the grouping the row shipped with');
  assert.deepEqual(out.find((t) => t.id === 'game-corner').items, ['issue:12', 'issue:14'],
    'and the voted one moves');
});

test('an empty draft never empties the registry', async () => {
  const pool = fakePool([[/UPDATE app_theme_registry/, { rows: [{ theme_key: 'everything' }] }]]);
  assert.deepEqual(await attrs.retireThemesExcept(pool, 7, []), []);
  assert.equal(pool.sent.length, 0, 'no statement is sent at all');
});
