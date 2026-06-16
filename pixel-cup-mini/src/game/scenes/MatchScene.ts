import Phaser from 'phaser';
import { Scenes, GAME_WIDTH, GAME_HEIGHT, PITCH, SPEED, KICK, COLORS, Side } from '../constants';
import { Player, TeamColors } from '../entities/player';
import { MatchControls } from '../systems/input';
import { runAI } from '../systems/ai';
import { MatchState } from '../logic/matchState';
import { shootAim, choosePassTarget, canPickup } from '../logic/mechanics';
import { getTeam } from '../logic/teams';

interface MatchData {
  playerTeamId: string;
  opponentTeamId: string;
}

const STEAL_RADIUS = 15;

export class MatchScene extends Phaser.Scene {
  // Public-ish fields read by the AI system.
  homePlayers: Player[] = [];
  awayPlayers: Player[] = [];
  ball!: Phaser.Physics.Arcade.Sprite;
  carrier: Player | null = null;
  controlled: Player | null = null;
  rng = new Phaser.Math.RandomDataGenerator();

  private match!: MatchState;
  private controls!: MatchControls;
  private playerTeam!: TeamColors;
  private oppTeam!: TeamColors;
  private lastKickAt = 0;
  private stealLockUntil = 0;
  private frozen = true; // true during kickoff/celebration freeze
  private paused = false; // true while the rotate-device overlay is up

  // HUD.
  private homeScoreText!: Phaser.GameObjects.Text;
  private awayScoreText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private goalText!: Phaser.GameObjects.Text;
  private indicator!: Phaser.GameObjects.Triangle;
  private rotateOverlay!: Phaser.GameObjects.Container;

  constructor() {
    super(Scenes.Match);
  }

  create(data: MatchData) {
    this.playerTeam = getTeam(data.playerTeamId) as TeamColors;
    this.oppTeam = getTeam(data.opponentTeamId) as TeamColors;
    this.match = new MatchState({ duration: 90 });
    this.homePlayers = [];
    this.awayPlayers = [];
    this.carrier = null;
    this.controlled = null;
    this.lastKickAt = 0;
    this.frozen = true;

    this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'pitch');
    this.physics.world.setBounds(PITCH.left, PITCH.top, PITCH.right - PITCH.left, PITCH.bottom - PITCH.top);

    this.spawnTeam('home', this.playerTeam);
    this.spawnTeam('away', this.oppTeam);

    this.ball = this.physics.add.sprite(PITCH.centerX, PITCH.centerY, 'ball');
    this.ball.setCircle(5);
    const bb = this.ball.body as Phaser.Physics.Arcade.Body;
    bb.setDamping(true);
    bb.setDrag(0.4, 0.4);
    bb.setMaxVelocity(SPEED.ballMax, SPEED.ballMax);
    this.ball.setDepth(5);

    const touch = this.sys.game.device.input.touch || this.scale.width < 700;
    this.controls = new MatchControls(this, touch);

    this.buildHud();
    this.buildRotateOverlay();

    // Controlled-player indicator.
    this.indicator = this.add.triangle(0, 0, 0, 0, 12, 0, 6, 10, 0xffdf1b).setDepth(20);

    this.scale.on('resize', this.checkOrientation, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.checkOrientation, this);
      this.controls.destroy();
    });

    // First kickoff to a random side after a brief beat.
    this.kickoff(this.rng.pick(['home', 'away']) as Side);
    this.checkOrientation();
  }

  // ---- setup helpers -------------------------------------------------

  private formation(side: Side): { x: number; y: number; role: 'gk' | 'field' }[] {
    const cy = PITCH.centerY;
    const homeSlots: { x: number; y: number; role: 'gk' | 'field' }[] = [
      { x: PITCH.left + 16, y: cy, role: 'gk' },
      { x: PITCH.left + 150, y: cy - 85, role: 'field' },
      { x: PITCH.left + 150, y: cy + 85, role: 'field' },
      { x: PITCH.centerX - 120, y: cy - 35, role: 'field' },
      { x: PITCH.centerX - 60, y: cy + 35, role: 'field' },
    ];
    if (side === 'home') return homeSlots;
    // Mirror across the vertical centre line for the away team.
    return homeSlots.map((s) => ({ x: GAME_WIDTH - s.x, y: s.y, role: s.role }));
  }

  private spawnTeam(side: Side, team: TeamColors) {
    const slots = this.formation(side);
    const arr = side === 'home' ? this.homePlayers : this.awayPlayers;
    for (const s of slots) {
      const p = new Player(this, s.x, s.y, side, s.role, team);
      p.homeSlot.set(s.x, s.y);
      arr.push(p);
    }
  }

  private buildHud() {
    const bar = this.add.rectangle(GAME_WIDTH / 2, 16, GAME_WIDTH, 32, 0x06121f, 0.82).setScrollFactor(0).setDepth(50);
    bar.setOrigin(0.5);
    this.add.rectangle(GAME_WIDTH / 2 - 120, 16, 20, 20, this.playerTeam.shirt).setScrollFactor(0).setDepth(51).setStrokeStyle(1, 0xffffff);
    this.add.rectangle(GAME_WIDTH / 2 + 120, 16, 20, 20, this.oppTeam.shirt).setScrollFactor(0).setDepth(51).setStrokeStyle(1, 0xffffff);

    const style = { fontFamily: 'monospace', fontSize: '20px', color: '#ffffff', fontStyle: 'bold' };
    this.homeScoreText = this.add.text(GAME_WIDTH / 2 - 90, 16, '0', style).setOrigin(0.5).setScrollFactor(0).setDepth(51);
    this.awayScoreText = this.add.text(GAME_WIDTH / 2 + 90, 16, '0', style).setOrigin(0.5).setScrollFactor(0).setDepth(51);
    this.clockText = this.add
      .text(GAME_WIDTH / 2, 16, '1:30', { fontFamily: 'monospace', fontSize: '22px', color: '#ffdf1b', fontStyle: 'bold' })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(51);

    this.goalText = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'GOAL!', {
        fontFamily: 'monospace',
        fontSize: '72px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setStroke('#06121f', 8)
      .setDepth(60)
      .setVisible(false);
  }

  private buildRotateOverlay() {
    const c = this.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2).setScrollFactor(0).setDepth(200).setVisible(false);
    const bg = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x06121f, 0.96);
    const t1 = this.add.text(0, -20, '↻', { fontFamily: 'monospace', fontSize: '64px', color: '#ffdf1b' }).setOrigin(0.5);
    const t2 = this.add
      .text(0, 50, 'Rotate your device\nto landscape to play', {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: '#ffffff',
        align: 'center',
      })
      .setOrigin(0.5);
    c.add([bg, t1, t2]);
    this.rotateOverlay = c;
  }

  // ---- geometry helpers (used by AI) ---------------------------------

  attackGoal(side: Side): Phaser.Math.Vector2 {
    return new Phaser.Math.Vector2(side === 'home' ? PITCH.right : PITCH.left, PITCH.centerY);
  }
  defendGoal(side: Side): Phaser.Math.Vector2 {
    return new Phaser.Math.Vector2(side === 'home' ? PITCH.left : PITCH.right, PITCH.centerY);
  }

  // ---- kicks (called by human input + AI) ----------------------------

  shoot(p: Player, heldMs: number) {
    if (this.carrier !== p) return;
    const goal = this.attackGoal(p.side);
    const bonus = Phaser.Math.Clamp(heldMs / 1000, 0, 1) * KICK.shootBonus;
    const v = shootAim(
      { x: this.ball.x, y: this.ball.y },
      { x: goal.x, y: goal.y },
      { x: p.facing.x, y: p.facing.y },
      { power: KICK.shootBase, bonus }
    );
    this.kickBall(v.x, v.y);
  }

  passFrom(p: Player): boolean {
    if (this.carrier !== p) return false;
    const mates = (p.side === 'home' ? this.homePlayers : this.awayPlayers).filter((m) => m !== p && m.role !== 'gk');
    const target = choosePassTarget(
      { x: p.x, y: p.y },
      { x: p.facing.x, y: p.facing.y },
      mates.map((m) => ({ x: m.x, y: m.y }))
    );
    if (!target) return false;
    const dx = target.x - this.ball.x;
    const dy = target.y - this.ball.y;
    const l = Math.hypot(dx, dy) || 1;
    this.kickBall((dx / l) * KICK.pass, (dy / l) * KICK.pass);
    return true;
  }

  tackleTowardBall(p: Player) {
    (p as any)._tackling = true;
    const dx = this.ball.x - p.x;
    const dy = this.ball.y - p.y;
    const l = Math.hypot(dx, dy) || 1;
    const body = p.body as Phaser.Physics.Arcade.Body;
    body.setVelocity((dx / l) * KICK.tackleLunge, (dy / l) * KICK.tackleLunge);
  }

  private kickBall(vx: number, vy: number) {
    this.carrier = null;
    this.lastKickAt = this.time.now;
    const bb = this.ball.body as Phaser.Physics.Arcade.Body;
    bb.setVelocity(vx, vy);
  }

  // ---- kickoff / goals -----------------------------------------------

  private kickoff(side: Side) {
    this.frozen = true;
    this.carrier = null;
    this.controlled = null;
    const bb = this.ball.body as Phaser.Physics.Arcade.Body;
    this.ball.setPosition(PITCH.centerX, PITCH.centerY);
    bb.setVelocity(0, 0);

    for (const team of [this.homePlayers, this.awayPlayers]) {
      for (const p of team) {
        p.setPosition(p.homeSlot.x, p.homeSlot.y);
        p.stop2();
        p.facing.set(p.side === 'home' ? 1 : -1, 0);
      }
    }
    // Give the kicking team's forward the ball at the centre.
    const fwd = (side === 'home' ? this.homePlayers : this.awayPlayers)[4];
    fwd.setPosition(PITCH.centerX + (side === 'home' ? -14 : 14), PITCH.centerY);
    this.carrier = fwd;
    this.lastKickAt = this.time.now;

    // Unfreeze shortly so players settle into place first.
    this.time.delayedCall(500, () => {
      this.frozen = false;
    });
  }

  private scoreGoal(scorer: Side) {
    if (this.frozen) return;
    this.frozen = true;
    const ended = this.match.addGoal(scorer === 'home' ? 'player' : 'opponent');
    this.refreshHud();

    this.goalText.setText(scorer === 'home' ? 'GOAL!' : 'CONCEDED').setVisible(true).setScale(0.4);
    this.tweens.add({ targets: this.goalText, scale: 1, duration: 350, ease: 'Back.out' });

    this.time.delayedCall(1200, () => {
      this.goalText.setVisible(false);
      if (ended || this.match.isOver()) {
        this.endMatch();
      } else {
        // Conceding side kicks off.
        this.kickoff(scorer === 'home' ? 'away' : 'home');
      }
    });
  }

  private endMatch() {
    this.scene.start(Scenes.Win, {
      playerTeamId: this.playerTeam.id,
      opponentTeamId: this.oppTeam.id,
      playerScore: this.match.playerScore,
      opponentScore: this.match.opponentScore,
    });
  }

  // ---- HUD / orientation ---------------------------------------------

  private refreshHud() {
    this.homeScoreText.setText(String(this.match.playerScore));
    this.awayScoreText.setText(String(this.match.opponentScore));
  }

  private formatClock(): string {
    const s = this.match.clockSeconds();
    if (this.match.goldenGoal) return 'GOLDEN';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
  }

  private checkOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    this.paused = portrait;
    this.rotateOverlay?.setVisible(portrait);
    if (portrait) {
      // Stop everything moving while the overlay is up.
      [...this.homePlayers, ...this.awayPlayers].forEach((p) => p.stop2());
      (this.ball?.body as Phaser.Physics.Arcade.Body)?.setVelocity(0, 0);
    }
  }

  // ---- main loop -----------------------------------------------------

  update(time: number, delta: number) {
    if (this.paused) return;
    this.controls.update();

    const dt = delta / 1000;
    if (!this.frozen) this.match.tick(dt);
    this.clockText.setText(this.formatClock());

    // Reset per-frame tackle flags.
    [...this.homePlayers, ...this.awayPlayers].forEach((p) => ((p as any)._tackling = false));

    if (this.frozen) {
      // During the freeze, still glue the ball to the kickoff carrier.
      if (this.carrier) this.glueBall();
      this.updateIndicator();
      return;
    }

    this.updatePossession(time);
    this.chooseControlled();
    runAI(this);
    this.applyHumanInput();
    if (this.carrier) this.glueBall();
    this.constrainBall();
    this.updateIndicator();

    if (this.match.isOver()) this.endMatch();
  }

  private updatePossession(time: number) {
    // Loose ball: nearest player within pickup radius grabs it.
    if (!this.carrier && canPickup(time, this.lastKickAt, KICK.cooldownMs)) {
      let best: Player | null = null;
      let bestD = KICK.pickupRadius;
      for (const p of [...this.homePlayers, ...this.awayPlayers]) {
        const d = Phaser.Math.Distance.Between(p.x, p.y, this.ball.x, this.ball.y);
        if (d <= bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best) {
        this.carrier = best;
      }
      return;
    }

    // Steal: an opponent close to the carrier can take it (on a tackle or
    // a small random chance), with a brief lock after to prevent ping-pong.
    if (this.carrier && time >= this.stealLockUntil) {
      const opponents = this.carrier.side === 'home' ? this.awayPlayers : this.homePlayers;
      for (const o of opponents) {
        if (o.role === 'gk') continue;
        const d = Phaser.Math.Distance.Between(o.x, o.y, this.carrier.x, this.carrier.y);
        if (d <= STEAL_RADIUS && ((o as any)._tackling || this.rng.frac() < 0.02)) {
          this.carrier = o;
          this.stealLockUntil = time + 280;
          break;
        }
      }
    }
  }

  private chooseControlled() {
    if (this.carrier && this.carrier.side === 'home' && this.carrier.role !== 'gk') {
      this.controlled = this.carrier;
      return;
    }
    // Not in possession (or our GK has it): control the nearest home
    // outfield player to the ball.
    let best: Player | null = null;
    let bestD = Infinity;
    for (const p of this.homePlayers) {
      if (p.role === 'gk') continue;
      const d = Phaser.Math.Distance.Between(p.x, p.y, this.ball.x, this.ball.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    this.controlled = best;
  }

  private applyHumanInput() {
    const p = this.controlled;
    if (!p) return;
    const move = this.controls.getMove();
    p.drive(move.x, move.y, 1);

    if (this.controls.consumePass()) {
      if (this.carrier === p) this.passFrom(p);
      else this.switchControlled();
    }
    const shoot = this.controls.consumeShoot();
    if (shoot.fired) {
      if (this.carrier === p) this.shoot(p, shoot.held);
      else this.tackleTowardBall(p);
    }
  }

  private switchControlled() {
    // Cycle control to the next-nearest home outfield player to the ball.
    const candidates = this.homePlayers
      .filter((p) => p.role !== 'gk' && p !== this.controlled)
      .sort(
        (a, b) =>
          Phaser.Math.Distance.Between(a.x, a.y, this.ball.x, this.ball.y) -
          Phaser.Math.Distance.Between(b.x, b.y, this.ball.x, this.ball.y)
      );
    if (candidates.length) this.controlled = candidates[0];
  }

  private glueBall() {
    const c = this.carrier!;
    const bx = c.x + c.facing.x * KICK.carryOffset;
    const by = c.y + c.facing.y * KICK.carryOffset;
    this.ball.setPosition(bx, by);
    const cb = c.body as Phaser.Physics.Arcade.Body;
    const bb = this.ball.body as Phaser.Physics.Arcade.Body;
    bb.setVelocity(cb.velocity.x, cb.velocity.y);
  }

  // Walls + goal-line detection. The ball is not world-bounded so it can
  // cross the goal lines; we reflect it off the side walls except within
  // the goal mouth, and off the top/bottom always.
  private constrainBall() {
    const bb = this.ball.body as Phaser.Physics.Arcade.Body;
    const cy = PITCH.centerY;
    const mouth = PITCH.goalMouthHeight / 2;
    const inMouth = Math.abs(this.ball.y - cy) < mouth;

    if (this.ball.y < PITCH.top) {
      this.ball.y = PITCH.top;
      bb.setVelocityY(Math.abs(bb.velocity.y) * 0.6);
    } else if (this.ball.y > PITCH.bottom) {
      this.ball.y = PITCH.bottom;
      bb.setVelocityY(-Math.abs(bb.velocity.y) * 0.6);
    }

    // Left line.
    if (this.ball.x < PITCH.left) {
      if (inMouth) {
        this.scoreGoal('away'); // crossed home's line → away scores
        return;
      }
      this.ball.x = PITCH.left;
      bb.setVelocityX(Math.abs(bb.velocity.x) * 0.6);
    }
    // Right line.
    if (this.ball.x > PITCH.right) {
      if (inMouth) {
        this.scoreGoal('home'); // crossed away's line → home scores
        return;
      }
      this.ball.x = PITCH.right;
      bb.setVelocityX(-Math.abs(bb.velocity.x) * 0.6);
    }
  }

  private updateIndicator() {
    if (this.controlled) {
      this.indicator.setVisible(true).setPosition(this.controlled.x - 6, this.controlled.y - 22);
    } else {
      this.indicator.setVisible(false);
    }
  }
}
