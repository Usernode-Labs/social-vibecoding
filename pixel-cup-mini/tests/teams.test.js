const test = require('node:test');
const assert = require('node:assert');
const { TEAMS, getTeam, pickOpponent } = require('../src/game/logic/teams');

test('there are exactly five national teams', () => {
  assert.strictEqual(TEAMS.length, 5);
  const ids = TEAMS.map((t) => t.id).sort();
  assert.deepStrictEqual(ids, ['argentina', 'brazil', 'france', 'germany', 'japan']);
});

test('every team has a name and valid 24-bit colours', () => {
  for (const t of TEAMS) {
    assert.ok(typeof t.name === 'string' && t.name.length > 0);
    for (const c of [t.shirt, t.shorts, t.trim]) {
      assert.ok(Number.isInteger(c) && c >= 0 && c <= 0xffffff, `bad colour on ${t.id}`);
    }
    assert.ok(Array.isArray(t.flag) && t.flag.length >= 2);
  }
});

test('team ids are distinct', () => {
  const ids = new Set(TEAMS.map((t) => t.id));
  assert.strictEqual(ids.size, TEAMS.length);
});

test('getTeam returns the matching team or null', () => {
  assert.strictEqual(getTeam('brazil').name, 'Brazil');
  assert.strictEqual(getTeam('nope'), null);
});

test('pickOpponent never returns the player team', () => {
  for (const t of TEAMS) {
    // Sweep the injected RNG across the full [0,1) range.
    for (let i = 0; i < 20; i++) {
      const r = i / 20;
      const opp = pickOpponent(t.id, () => r);
      assert.ok(opp, 'should always find an opponent');
      assert.notStrictEqual(opp.id, t.id);
    }
  }
});

test('pickOpponent is deterministic for a fixed RNG', () => {
  const a = pickOpponent('brazil', () => 0.5);
  const b = pickOpponent('brazil', () => 0.5);
  assert.strictEqual(a.id, b.id);
});
