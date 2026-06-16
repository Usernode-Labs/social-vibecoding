// Shared constants for Pixel Cup Mini. The logical world is a fixed
// 800x450 (16:9) pitch; the Scale Manager maps it to any device.

export const GAME_WIDTH = 800;
export const GAME_HEIGHT = 450;

// Scene keys.
export const Scenes = {
  Boot: 'Boot',
  Start: 'Start',
  TeamSelect: 'TeamSelect',
  Match: 'Match',
  Win: 'Win',
} as const;

// Pitch geometry (world units). Goals sit just inside the left/right
// margins; the goal mouth is a vertical band centred on the pitch.
export const PITCH = {
  marginX: 36,
  marginY: 28,
  get left() {
    return this.marginX;
  },
  get right() {
    return GAME_WIDTH - this.marginX;
  },
  get top() {
    return this.marginY;
  },
  get bottom() {
    return GAME_HEIGHT - this.marginY;
  },
  get centerX() {
    return GAME_WIDTH / 2;
  },
  get centerY() {
    return GAME_HEIGHT / 2;
  },
  goalMouthHeight: 130,
  goalDepth: 22,
};

// Movement / kick tuning (px/s). Opponent pace is a touch below the
// player's so a focused player can win.
export const SPEED = {
  player: 178,
  ai: 162,
  keeper: 150,
  ballMax: 420,
  ballDrag: 260, // arcade drag, px/s^2
};

export const KICK = {
  pass: 300,
  shootBase: 360,
  shootBonus: 90, // added when the shoot button is held briefly
  tackleLunge: 250,
  cooldownMs: 350,
  carryOffset: 15, // how far ahead of the carrier the ball rides
  pickupRadius: 16,
};

// Team side roles: 'home' is the player's team (defends LEFT, attacks
// RIGHT); 'away' is the AI (defends RIGHT, attacks LEFT).
export type Side = 'home' | 'away';
export type Role = 'gk' | 'field';

// Colours for chrome (non-team).
export const COLORS = {
  pitch: 0x2f8f4e,
  pitchStripe: 0x2a8246,
  line: 0xffffff,
  bgTop: 0x0b1020,
  panel: 0x10183a,
  accent: 0xffdf1b,
  text: '#ffffff',
};
