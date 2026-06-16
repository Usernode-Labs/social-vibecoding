import Phaser from 'phaser';
import { Player } from '../entities/player';

// Lightweight per-agent AI run every frame. Loosely typed against the
// MatchScene (passed as `scene`) to avoid an import cycle; it reads public
// fields and calls back into the scene's kick helpers.
//
// Drives: every player except the human-controlled one — i.e. both
// goalkeepers, the away team, and the player's non-controlled teammates.

interface AISceneLike {
  homePlayers: Player[];
  awayPlayers: Player[];
  ball: Phaser.Physics.Arcade.Sprite;
  carrier: Player | null;
  controlled: Player | null;
  rng: Phaser.Math.RandomDataGenerator;
  attackGoal(side: 'home' | 'away'): Phaser.Math.Vector2;
  defendGoal(side: 'home' | 'away'): Phaser.Math.Vector2;
  shoot(p: Player, heldMs: number): void;
  passFrom(p: Player): boolean;
  tackleTowardBall(p: Player): void;
}

const SHOOT_RANGE = 250;
const TACKLE_RANGE = 26;
const KEEPER_DANGER = 150;

function nearestToBall(team: Player[], ball: Phaser.GameObjects.Sprite): Player | null {
  let best: Player | null = null;
  let bestD = Infinity;
  for (const p of team) {
    if (p.role === 'gk') continue;
    const d = Phaser.Math.Distance.Between(p.x, p.y, ball.x, ball.y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function driveKeeper(scene: AISceneLike, gk: Player) {
  const own = scene.defendGoal(gk.side);
  const ball = scene.ball;
  // Hold near the goal line; track the ball's y within the mouth.
  const lineX = own.x + (gk.side === 'home' ? 26 : -26);
  const targetY = Phaser.Math.Clamp(ball.y, own.y - 58, own.y + 58);
  let tx = lineX;
  let ty = targetY;

  const distToBall = Phaser.Math.Distance.Between(gk.x, gk.y, ball.x, ball.y);
  const ballOnOurSide = gk.side === 'home' ? ball.x < own.x + KEEPER_DANGER : ball.x > own.x - KEEPER_DANGER;
  if (ballOnOurSide && distToBall < KEEPER_DANGER && scene.carrier?.side !== gk.side) {
    // Lunge at the ball to smother.
    tx = ball.x;
    ty = ball.y;
  }
  gk.drive(tx - gk.x, ty - gk.y, distToBall < KEEPER_DANGER ? 1 : 0.7);

  // If the keeper somehow has the ball, clear it upfield immediately.
  if (scene.carrier === gk) {
    scene.shoot(gk, 0);
  }
}

function driveCarrier(scene: AISceneLike, p: Player) {
  const goal = scene.attackGoal(p.side);
  const dist = Phaser.Math.Distance.Between(p.x, p.y, goal.x, goal.y);

  // Shoot when in range (with a small random reaction gate so it isn't
  // robotic).
  if (dist < SHOOT_RANGE && scene.rng.frac() < 0.04) {
    scene.shoot(p, 0);
    return;
  }
  // Occasionally pass to a better-placed teammate.
  if (scene.rng.frac() < 0.012 && scene.passFrom(p)) {
    return;
  }
  // Dribble toward goal, steering slightly toward the centre channel.
  const steerY = Phaser.Math.Clamp(goal.y - p.y, -60, 60);
  p.drive(goal.x - p.x, (goal.y - p.y) * 0.4 + steerY * 0.2, 0.95);
}

function driveSupport(scene: AISceneLike, p: Player) {
  // Team has the ball but this player doesn't: spread toward the attack
  // goal and offer a passing lane.
  const goal = scene.attackGoal(p.side);
  const tx = (p.homeSlot.x + goal.x) / 2;
  const ty = p.homeSlot.y * 0.6 + p.y * 0.4;
  p.drive(tx - p.x, ty - p.y, 0.8);
}

function driveDefend(scene: AISceneLike, p: Player, isChaser: boolean) {
  const ball = scene.ball;
  if (isChaser) {
    const d = Phaser.Math.Distance.Between(p.x, p.y, ball.x, ball.y);
    if (d < TACKLE_RANGE) {
      scene.tackleTowardBall(p);
    }
    p.drive(ball.x - p.x, ball.y - p.y, 1);
  } else {
    // Hold formation, biased toward the ball's vertical position.
    const tx = p.homeSlot.x;
    const ty = p.homeSlot.y * 0.55 + ball.y * 0.45;
    p.drive(tx - p.x, ty - p.y, 0.75);
  }
}

export function runAI(scene: AISceneLike) {
  const carrier = scene.carrier;
  const homeChaser = carrier?.side === 'home' ? null : nearestToBall(scene.homePlayers, scene.ball);
  const awayChaser = carrier?.side === 'away' ? null : nearestToBall(scene.awayPlayers, scene.ball);

  for (const team of [scene.homePlayers, scene.awayPlayers] as const) {
    const teamHasBall = carrier != null && carrier.side === team[0].side;
    const chaser = team[0].side === 'home' ? homeChaser : awayChaser;
    for (const p of team) {
      if (p === scene.controlled) continue; // human drives this one
      if (p.role === 'gk') {
        driveKeeper(scene, p);
        continue;
      }
      if (carrier === p) {
        driveCarrier(scene, p);
      } else if (teamHasBall) {
        driveSupport(scene, p);
      } else {
        driveDefend(scene, p, p === chaser);
      }
    }
  }
}
