import Phaser from 'phaser';
import { Scenes } from '../constants';
import { generateTextures } from '../textures';

// Generates all procedural textures/animations, then hands off to the
// Start screen. No binary assets to preload.
export class BootScene extends Phaser.Scene {
  constructor() {
    super(Scenes.Boot);
  }

  create() {
    generateTextures(this);
    this.scene.start(Scenes.Start);
  }
}
