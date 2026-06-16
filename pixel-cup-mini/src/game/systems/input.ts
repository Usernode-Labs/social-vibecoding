import Phaser from 'phaser';

// Unified match controls: a floating virtual joystick (left half) + two
// action buttons (right half) for touch, with a full keyboard fallback so
// the game is playable on desktop during review.
//
// The scene calls update() each frame, reads getMove() for the movement
// vector, and consumePass()/consumeShoot() for edge-triggered actions.
export class MatchControls {
  private scene: Phaser.Scene;
  private touch: boolean;

  // Movement state.
  private move = new Phaser.Math.Vector2(0, 0);

  // Edge-triggered action buffers (set on press, cleared on consume).
  private passQueued = false;
  private shootQueued = false;
  private shootHoldMs = 0;
  private shootDownAt = 0;

  // Joystick visuals/state.
  private joyBase?: Phaser.GameObjects.Arc;
  private joyThumb?: Phaser.GameObjects.Arc;
  private joyPointerId = -1;
  private joyOrigin = new Phaser.Math.Vector2(0, 0);
  private readonly joyRadius = 46;

  // Buttons.
  private passBtn?: Phaser.GameObjects.Container;
  private shootBtn?: Phaser.GameObjects.Container;
  private shootBtnDown = false;

  // Keyboard.
  private keys?: Record<string, Phaser.Input.Keyboard.Key>;

  constructor(scene: Phaser.Scene, touch: boolean) {
    this.scene = scene;
    this.touch = touch;
    this.setupKeyboard();
    if (touch) {
      this.setupTouch();
    }
  }

  private setupKeyboard() {
    const kb = this.scene.input.keyboard;
    if (!kb) return;
    this.keys = kb.addKeys(
      'W,A,S,D,UP,DOWN,LEFT,RIGHT,J,K,SPACE,SHIFT'
    ) as Record<string, Phaser.Input.Keyboard.Key>;

    // Edge events for actions (so a tap fires once).
    kb.on('keydown-J', () => (this.passQueued = true));
    kb.on('keydown-SPACE', () => (this.passQueued = true));
    kb.on('keydown-K', () => this.onShootDown());
    kb.on('keyup-K', () => this.onShootUp());
    kb.on('keydown-SHIFT', () => this.onShootDown());
    kb.on('keyup-SHIFT', () => this.onShootUp());
  }

  private onShootDown() {
    if (this.shootBtnDown) return;
    this.shootBtnDown = true;
    this.shootDownAt = this.scene.time.now;
  }

  private onShootUp() {
    if (!this.shootBtnDown) return;
    this.shootBtnDown = false;
    this.shootHoldMs = this.scene.time.now - this.shootDownAt;
    this.shootQueued = true;
  }

  private setupTouch() {
    const { width, height } = this.scene.scale.gameSize;

    // Joystick base + thumb (hidden until touched). Fixed to the camera.
    this.joyBase = this.scene.add
      .circle(0, 0, this.joyRadius, 0xffffff, 0.12)
      .setStrokeStyle(2, 0xffffff, 0.4)
      .setScrollFactor(0)
      .setDepth(1000)
      .setVisible(false);
    this.joyThumb = this.scene.add
      .circle(0, 0, 20, 0xffffff, 0.35)
      .setScrollFactor(0)
      .setDepth(1001)
      .setVisible(false);

    this.passBtn = this.makeButton(width - 120, height - 56, 'PASS', 0x2bd17e);
    this.shootBtn = this.makeButton(width - 52, height - 96, 'SHOOT', 0xff5b5b);

    this.scene.input.addPointer(2); // allow 3 simultaneous touches
    this.scene.input.on('pointerdown', this.onPointerDown, this);
    this.scene.input.on('pointermove', this.onPointerMove, this);
    this.scene.input.on('pointerup', this.onPointerUp, this);
    this.scene.scale.on('resize', this.layout, this);
  }

  private makeButton(x: number, y: number, label: string, color: number) {
    const c = this.scene.add.container(x, y).setScrollFactor(0).setDepth(1000);
    const circle = this.scene.add.circle(0, 0, 34, color, 0.85).setStrokeStyle(2, 0xffffff, 0.6);
    const txt = this.scene.add
      .text(0, 0, label, { fontFamily: 'monospace', fontSize: '11px', color: '#06121f' })
      .setOrigin(0.5);
    c.add([circle, txt]);
    (c as any)._radius = 38;
    return c;
  }

  private layout() {
    if (!this.touch) return;
    const { width, height } = this.scene.scale.gameSize;
    this.passBtn?.setPosition(width - 120, height - 56);
    this.shootBtn?.setPosition(width - 52, height - 96);
  }

  private hitButton(btn: Phaser.GameObjects.Container | undefined, px: number, py: number): boolean {
    if (!btn) return false;
    const r = (btn as any)._radius as number;
    return Phaser.Math.Distance.Between(px, py, btn.x, btn.y) <= r;
  }

  private onPointerDown(p: Phaser.Input.Pointer) {
    // Buttons take priority over the joystick.
    if (this.hitButton(this.passBtn, p.x, p.y)) {
      this.passQueued = true;
      return;
    }
    if (this.hitButton(this.shootBtn, p.x, p.y)) {
      this.onShootDown();
      (this.shootBtn as any)._pointerId = p.id;
      return;
    }
    // Otherwise start the floating joystick wherever the finger landed
    // (anchored in the left ~60% of the screen).
    if (this.joyPointerId === -1 && p.x < this.scene.scale.gameSize.width * 0.6) {
      this.joyPointerId = p.id;
      this.joyOrigin.set(p.x, p.y);
      this.joyBase?.setPosition(p.x, p.y).setVisible(true);
      this.joyThumb?.setPosition(p.x, p.y).setVisible(true);
    }
  }

  private onPointerMove(p: Phaser.Input.Pointer) {
    if (p.id !== this.joyPointerId) return;
    const dx = p.x - this.joyOrigin.x;
    const dy = p.y - this.joyOrigin.y;
    const dist = Math.min(this.joyRadius, Math.hypot(dx, dy));
    const ang = Math.atan2(dy, dx);
    const tx = this.joyOrigin.x + Math.cos(ang) * dist;
    const ty = this.joyOrigin.y + Math.sin(ang) * dist;
    this.joyThumb?.setPosition(tx, ty);
    // Normalised vector (magnitude reflects how far the thumb is pushed).
    const mag = dist / this.joyRadius;
    this.move.set(Math.cos(ang) * mag, Math.sin(ang) * mag);
  }

  private onPointerUp(p: Phaser.Input.Pointer) {
    if (p.id === this.joyPointerId) {
      this.joyPointerId = -1;
      this.move.set(0, 0);
      this.joyBase?.setVisible(false);
      this.joyThumb?.setVisible(false);
    }
    if ((this.shootBtn as any)?._pointerId === p.id) {
      (this.shootBtn as any)._pointerId = -1;
      this.onShootUp();
    }
  }

  // Resolve keyboard movement each frame (touch sets this.move directly).
  update() {
    if (!this.keys) return;
    if (this.joyPointerId !== -1) return; // joystick active, ignore keys

    let x = 0;
    let y = 0;
    if (this.keys.A.isDown || this.keys.LEFT.isDown) x -= 1;
    if (this.keys.D.isDown || this.keys.RIGHT.isDown) x += 1;
    if (this.keys.W.isDown || this.keys.UP.isDown) y -= 1;
    if (this.keys.S.isDown || this.keys.DOWN.isDown) y += 1;
    if (x !== 0 || y !== 0) {
      const l = Math.hypot(x, y);
      this.move.set(x / l, y / l);
    } else if (!this.touch) {
      this.move.set(0, 0);
    }
  }

  getMove(): Phaser.Math.Vector2 {
    return this.move;
  }

  consumePass(): boolean {
    const v = this.passQueued;
    this.passQueued = false;
    return v;
  }

  // Returns { fired, held } where held is the press duration in ms (for
  // the shoot power bonus).
  consumeShoot(): { fired: boolean; held: number } {
    if (!this.shootQueued) return { fired: false, held: 0 };
    this.shootQueued = false;
    const held = this.shootHoldMs;
    this.shootHoldMs = 0;
    return { fired: true, held };
  }

  destroy() {
    this.scene.input.off('pointerdown', this.onPointerDown, this);
    this.scene.input.off('pointermove', this.onPointerMove, this);
    this.scene.input.off('pointerup', this.onPointerUp, this);
    this.scene.scale.off('resize', this.layout, this);
    this.joyBase?.destroy();
    this.joyThumb?.destroy();
    this.passBtn?.destroy();
    this.shootBtn?.destroy();
  }
}
