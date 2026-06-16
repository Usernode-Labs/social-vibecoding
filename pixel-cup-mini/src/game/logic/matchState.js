// Pure match clock + scoring + win-condition logic, free of Phaser so it
// can be unit-tested headlessly. The MatchScene owns one instance and
// drives it from the Phaser update loop.
//
// Rules (per spec):
//  - 90s countdown.
//  - At 0s: higher score wins; a tie enters golden-goal mode (clock
//    stops, next goal ends the match) so a draw is impossible.

const DEFAULT_DURATION = 90;

class MatchState {
  constructor(opts = {}) {
    this.duration = opts.duration != null ? opts.duration : DEFAULT_DURATION;
    this.timeLeft = this.duration;
    this.playerScore = 0;
    this.opponentScore = 0;
    this.goldenGoal = false;
    this.finished = false;
  }

  // Advance the clock by dt seconds. No-op once finished or in golden
  // goal (where the clock is stopped and only a goal can end the match).
  tick(dt) {
    if (this.finished || this.goldenGoal) return;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      if (this.playerScore === this.opponentScore) {
        this.goldenGoal = true;
      } else {
        this.finished = true;
      }
    }
  }

  // Record a goal for 'player' or 'opponent'. Returns true if this goal
  // ended the match (only possible during golden goal).
  addGoal(side) {
    if (this.finished) return false;
    if (side === 'player') this.playerScore += 1;
    else if (side === 'opponent') this.opponentScore += 1;
    else return false;
    if (this.goldenGoal) this.finished = true;
    return this.finished;
  }

  isOver() {
    return this.finished;
  }

  // 'win' | 'lose' | 'draw' from the player's perspective. 'draw' only
  // appears mid-match; a finished match is never a draw.
  result() {
    if (this.playerScore > this.opponentScore) return 'win';
    if (this.playerScore < this.opponentScore) return 'lose';
    return 'draw';
  }

  // Whole seconds remaining, for the HUD clock.
  clockSeconds() {
    return Math.max(0, Math.ceil(this.timeLeft));
  }
}

module.exports = { MatchState, DEFAULT_DURATION };
