import Phaser from 'phaser';
import { Side, Role, SPEED } from '../constants';

export interface TeamColors {
  id: string;
  name: string;
  shirt: number;
  shorts: number;
  trim: number;
  flag: number[];
}

// A single footballer. Outfield players and goalkeepers share this class;
// `role` distinguishes them. The sprite is tinted to the team's shirt
// colour (keepers get the trim colour so they stand out).
export class Player extends Phaser.Physics.Arcade.Sprite {
  side: Side;
  role: Role;
  team: TeamColors;
  baseSpeed: number;
  // Last non-zero movement direction, used for aiming passes/shots and
  // flipping the sprite. Defaults toward the attacking goal.
  facing: Phaser.Math.Vector2;
  // Home formation slot (the spot this player drifts back to), set by the
  // scene; used by teammate/AI positioning.
  homeSlot: Phaser.Math.Vector2;

  constructor(scene: Phaser.Scene, x: number, y: number, side: Side, role: Role, team: TeamColors) {
    super(scene, x, y, 'player_run0');
    this.side = side;
    this.role = role;
    this.team = team;
    this.baseSpeed = role === 'gk' ? SPEED.keeper : side === 'home' ? SPEED.player : SPEED.ai;
    this.facing = new Phaser.Math.Vector2(side === 'home' ? 1 : -1, 0);
    this.homeSlot = new Phaser.Math.Vector2(x, y);

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setOrigin(0.5, 0.6);
    this.setTint(role === 'gk' ? team.trim || 0xdddddd : team.shirt);
    this.setCollideWorldBounds(true);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setCircle(6, 1, 4);
    body.setDamping(true);
    body.setDrag(0.0001, 0.0001);
  }

  // Drive the player toward a normalised-ish direction at `speedScale` of
  // base speed. Zero direction stops and idles.
  drive(dx: number, dy: number, speedScale = 1) {
    const body = this.body as Phaser.Physics.Arcade.Body;
    const len = Math.hypot(dx, dy);
    if (len < 0.05) {
      body.setVelocity(0, 0);
      this.anims.stop();
      this.setTexture('player_run0');
      return;
    }
    const nx = dx / len;
    const ny = dy / len;
    const sp = this.baseSpeed * speedScale;
    body.setVelocity(nx * sp, ny * sp);
    this.facing.set(nx, ny);
    this.setFlipX(nx < 0);
    if (!this.anims.isPlaying) this.anims.play('run', true);
  }

  stop2() {
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
    this.anims.stop();
  }
}
