// Procedural pixel-art textures generated at boot with Phaser Graphics →
// generateTexture. The repo ships no binary art; everything is drawn in
// code. Player/keeper bodies are white so they can be tinted per team via
// setTint(). The generation layer is isolated here so real sprite-sheet
// PNGs can replace it later without touching gameplay code.

import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, PITCH, COLORS } from './constants';

// Draw a single 14x16 player frame into a graphics object at (ox,oy).
// `legPhase` shifts the legs to fake a 2-frame run cycle.
function drawPlayerFrame(g: Phaser.GameObjects.Graphics, ox: number, oy: number, legPhase: number) {
  // Body (shirt) — drawn white for tinting.
  g.fillStyle(0xffffff, 1);
  g.fillRect(ox + 3, oy + 5, 8, 7); // torso
  // Head.
  g.fillRect(ox + 4, oy + 0, 6, 5); // head block
  // Arms.
  g.fillRect(ox + 1, oy + 5, 2, 5);
  g.fillRect(ox + 11, oy + 5, 2, 5);
  // Legs (shift with phase).
  const l = legPhase === 0 ? 0 : 1;
  g.fillRect(ox + 3 + l, oy + 12, 3, 4);
  g.fillRect(ox + 8 - l, oy + 12, 3, 4);
}

function makePlayerTextures(scene: Phaser.Scene) {
  for (let frame = 0; frame < 2; frame++) {
    const key = `player_run${frame}`;
    if (scene.textures.exists(key)) continue;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    drawPlayerFrame(g, 0, 0, frame);
    g.generateTexture(key, 14, 16);
    g.destroy();
  }
}

function makeBallTexture(scene: Phaser.Scene) {
  if (scene.textures.exists('ball')) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0xffffff, 1);
  g.fillCircle(5, 5, 5);
  // A couple of dark "pentagon" pixels for the classic football look.
  g.fillStyle(0x222222, 1);
  g.fillRect(4, 3, 2, 2);
  g.fillRect(2, 6, 2, 2);
  g.fillRect(6, 6, 2, 2);
  g.generateTexture('ball', 10, 10);
  g.destroy();
}

// A 1x1 white pixel used for flexible rectangle drawing / tinting.
function makePixel(scene: Phaser.Scene) {
  if (scene.textures.exists('px')) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0xffffff, 1);
  g.fillRect(0, 0, 1, 1);
  g.generateTexture('px', 1, 1);
  g.destroy();
}

// Full pitch background drawn once into a texture: grass + mowing
// stripes, centre line + circle, penalty boxes, goal nets.
function makePitchTexture(scene: Phaser.Scene) {
  if (scene.textures.exists('pitch')) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);

  // Grass base.
  g.fillStyle(COLORS.pitch, 1);
  g.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  // Mowing stripes.
  g.fillStyle(COLORS.pitchStripe, 1);
  const stripeW = 56;
  for (let x = 0; x < GAME_WIDTH; x += stripeW * 2) {
    g.fillRect(x, 0, stripeW, GAME_HEIGHT);
  }

  const L = PITCH.left;
  const R = PITCH.right;
  const T = PITCH.top;
  const B = PITCH.bottom;
  const cx = PITCH.centerX;
  const cy = PITCH.centerY;

  g.lineStyle(2, COLORS.line, 0.9);
  // Outer boundary.
  g.strokeRect(L, T, R - L, B - T);
  // Centre line.
  g.beginPath();
  g.moveTo(cx, T);
  g.lineTo(cx, B);
  g.strokePath();
  // Centre circle + spot.
  g.strokeCircle(cx, cy, 52);
  g.fillStyle(COLORS.line, 0.9);
  g.fillCircle(cx, cy, 3);

  // Penalty boxes (left & right).
  const boxH = PITCH.goalMouthHeight + 60;
  const boxW = 56;
  g.lineStyle(2, COLORS.line, 0.9);
  g.strokeRect(L, cy - boxH / 2, boxW, boxH);
  g.strokeRect(R - boxW, cy - boxH / 2, boxW, boxH);

  // Goal nets (just outside the boundary).
  const gmH = PITCH.goalMouthHeight;
  const gd = PITCH.goalDepth;
  g.fillStyle(0xffffff, 0.18);
  g.fillRect(L - gd, cy - gmH / 2, gd, gmH);
  g.fillRect(R, cy - gmH / 2, gd, gmH);
  g.lineStyle(1, 0xffffff, 0.5);
  g.strokeRect(L - gd, cy - gmH / 2, gd, gmH);
  g.strokeRect(R, cy - gmH / 2, gd, gmH);

  g.generateTexture('pitch', GAME_WIDTH, GAME_HEIGHT);
  g.destroy();
}

export function generateTextures(scene: Phaser.Scene) {
  makePixel(scene);
  makePlayerTextures(scene);
  makeBallTexture(scene);
  makePitchTexture(scene);

  // Run animation usable by any player sprite (frames live in separate
  // textures; an animation can reference multiple texture keys).
  if (!scene.anims.exists('run')) {
    scene.anims.create({
      key: 'run',
      frames: [{ key: 'player_run0' }, { key: 'player_run1' }],
      frameRate: 8,
      repeat: -1,
    });
  }
}
