const test = require('node:test');
const assert = require('node:assert');
const { choosePassTarget, shootAim, canPickup, _vec } = require('../src/game/logic/mechanics');

test('choosePassTarget prefers the well-aligned teammate', () => {
  const from = { x: 0, y: 0 };
  const facing = { x: 1, y: 0 }; // aiming right
  const mates = [
    { x: 100, y: 5, id: 'ahead' }, // straight ahead
    { x: -100, y: 0, id: 'behind' }, // behind, should be rejected
    { x: 0, y: 120, id: 'side' }, // perpendicular
  ];
  const t = choosePassTarget(from, facing, mates);
  assert.strictEqual(t.id, 'ahead');
});

test('choosePassTarget returns null when nobody is in range', () => {
  const t = choosePassTarget({ x: 0, y: 0 }, { x: 1, y: 0 }, [{ x: 9999, y: 0 }], { maxRange: 200 });
  assert.strictEqual(t, null);
});

test('choosePassTarget rejects strongly mis-aligned (behind) teammates', () => {
  const t = choosePassTarget({ x: 0, y: 0 }, { x: 1, y: 0 }, [{ x: -50, y: 0, id: 'behind' }]);
  assert.strictEqual(t, null);
});

test('shootAim points generally toward the goal', () => {
  const v = shootAim({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0 }, { power: 300 });
  assert.ok(v.x > 0, 'should drive toward +x goal');
  assert.ok(Math.abs(v.y) < 1e-6, 'no vertical drift with no movement input');
});

test('shootAim speed equals power + bonus', () => {
  const v = shootAim({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { power: 300, bonus: 60 });
  const speed = _vec.len(v);
  assert.ok(Math.abs(speed - 360) < 1e-6, `expected 360, got ${speed}`);
});

test('shootAim nudges aim toward the movement direction', () => {
  // Goal is straight right; player moving down should bend the shot down.
  const v = shootAim({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 1 }, { power: 300, aimWeight: 0.5 });
  assert.ok(v.y > 0, 'movement should bend the shot downward');
});

test('canPickup blocks within the cooldown and allows after', () => {
  assert.strictEqual(canPickup(1000, 900, 350), false); // 100ms since kick
  assert.strictEqual(canPickup(1300, 900, 350), true); // 400ms since kick
  assert.strictEqual(canPickup(1000, null, 350), true); // never kicked
});
