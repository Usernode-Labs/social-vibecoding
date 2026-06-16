import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, COLORS } from './constants';
import { BootScene } from './scenes/BootScene';
import { StartScene } from './scenes/StartScene';
import { TeamSelectScene } from './scenes/TeamSelectScene';
import { MatchScene } from './scenes/MatchScene';
import { WinScene } from './scenes/WinScene';

// Phaser entry point. Fixed 800x450 logical canvas, FIT-scaled and
// centred on any device; pixelArt + roundPixels keep generated textures
// crisp.
const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: COLORS.bgTop,
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: 'arcade',
    arcade: { gravity: { x: 0, y: 0 }, debug: false },
  },
  scene: [BootScene, StartScene, TeamSelectScene, MatchScene, WinScene],
};

// eslint-disable-next-line no-new
new Phaser.Game(config);
