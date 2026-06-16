const test = require('node:test');
const assert = require('node:assert');
const { MatchState, DEFAULT_DURATION } = require('../src/game/logic/matchState');

test('starts 0-0 with the full clock and not finished', () => {
  const m = new MatchState();
  assert.strictEqual(m.playerScore, 0);
  assert.strictEqual(m.opponentScore, 0);
  assert.strictEqual(m.timeLeft, DEFAULT_DURATION);
  assert.strictEqual(m.isOver(), false);
});

test('goals increment the right side', () => {
  const m = new MatchState();
  m.addGoal('player');
  m.addGoal('player');
  m.addGoal('opponent');
  assert.strictEqual(m.playerScore, 2);
  assert.strictEqual(m.opponentScore, 1);
});

test('clock counts down and clamps at zero', () => {
  const m = new MatchState({ duration: 5 });
  m.tick(3);
  assert.strictEqual(m.timeLeft, 2);
  m.tick(10);
  assert.strictEqual(m.timeLeft, 0);
});

test('time expiring with a lead ends the match', () => {
  const m = new MatchState({ duration: 2 });
  m.addGoal('player');
  m.tick(2);
  assert.strictEqual(m.isOver(), true);
  assert.strictEqual(m.result(), 'win');
});

test('time expiring level enters golden goal, not finished', () => {
  const m = new MatchState({ duration: 2 });
  m.tick(2);
  assert.strictEqual(m.goldenGoal, true);
  assert.strictEqual(m.isOver(), false);
});

test('golden goal: next goal ends the match and decides the result', () => {
  const m = new MatchState({ duration: 1 });
  m.tick(1); // 0-0 -> golden goal
  const ended = m.addGoal('opponent');
  assert.strictEqual(ended, true);
  assert.strictEqual(m.isOver(), true);
  assert.strictEqual(m.result(), 'lose');
});

test('clock is frozen during golden goal', () => {
  const m = new MatchState({ duration: 1 });
  m.tick(1);
  const before = m.timeLeft;
  m.tick(5);
  assert.strictEqual(m.timeLeft, before);
});

test('a finished match is never reported as a draw', () => {
  const m = new MatchState({ duration: 1 });
  m.tick(1); // golden goal
  m.addGoal('player');
  assert.notStrictEqual(m.result(), 'draw');
});
