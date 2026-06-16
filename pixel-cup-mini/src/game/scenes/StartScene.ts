import Phaser from 'phaser';
import { Scenes, GAME_WIDTH, GAME_HEIGHT, COLORS } from '../constants';
import { makeButton } from '../ui/widgets';

// Start Screen: title, Play button, How-to-play toggle, World Cup tagline.
export class StartScene extends Phaser.Scene {
  private howto?: Phaser.GameObjects.Text;
  private howtoVisible = false;

  constructor() {
    super(Scenes.Start);
  }

  create() {
    this.cameras.main.setBackgroundColor(COLORS.bgTop);
    // Pitch backdrop, dimmed.
    this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'pitch').setAlpha(0.35);

    const cx = GAME_WIDTH / 2;

    // Title with a subtle bob.
    const title = this.add
      .text(cx, 110, 'PIXEL CUP\nMINI', {
        fontFamily: 'monospace',
        fontSize: '56px',
        color: '#ffdf1b',
        fontStyle: 'bold',
        align: 'center',
      })
      .setOrigin(0.5)
      .setStroke('#06121f', 8)
      .setLineSpacing(-6);
    this.tweens.add({ targets: title, y: 100, duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.inOut' });

    // A bouncing ball flourish.
    const ball = this.add.image(cx + 150, 70, 'ball').setScale(2.4);
    this.tweens.add({ targets: ball, y: 50, duration: 600, yoyo: true, repeat: -1, ease: 'Quad.inOut' });

    this.add
      .text(cx, 178, 'WORLD CUP CELEBRATION ⚽', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: '#bcd0ff',
      })
      .setOrigin(0.5);

    makeButton(this, cx, 250, '▶  PLAY', () => this.scene.start(Scenes.TeamSelect));

    makeButton(
      this,
      cx,
      318,
      'HOW TO PLAY',
      () => this.toggleHowto(),
      { color: 0x2bd17e, width: 200, height: 44, fontSize: 16 }
    );

    this.howto = this.add
      .text(
        cx,
        388,
        [
          'Move with the joystick (or WASD / arrows).',
          'PASS button (J / Space): pass — or switch player.',
          'SHOOT button (K / Shift): shoot — or tackle.',
          'Score the most in 90s. A tie goes to golden goal!',
        ].join('\n'),
        { fontFamily: 'monospace', fontSize: '13px', color: '#e7eefc', align: 'center', lineSpacing: 4 }
      )
      .setOrigin(0.5)
      .setVisible(false);

    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.onResize, this));
  }

  private toggleHowto() {
    this.howtoVisible = !this.howtoVisible;
    this.howto?.setVisible(this.howtoVisible);
  }

  private onResize() {
    // Camera FIT handles scaling; nothing layout-specific needed here as
    // all elements are centred on the fixed logical canvas.
  }
}
