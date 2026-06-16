import Phaser from 'phaser';

// Small reusable pixel-styled button for the menu scenes. Returns a
// container that scales slightly on hover/press and fires `onClick`.
export function makeButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  onClick: () => void,
  opts: { color?: number; width?: number; height?: number; fontSize?: number } = {}
): Phaser.GameObjects.Container {
  const color = opts.color ?? 0xffdf1b;
  const w = opts.width ?? 200;
  const h = opts.height ?? 52;
  const fontSize = opts.fontSize ?? 20;

  const c = scene.add.container(x, y);
  const bg = scene.add.rectangle(0, 0, w, h, color, 1).setStrokeStyle(3, 0x06121f, 1);
  const txt = scene.add
    .text(0, 0, label, { fontFamily: 'monospace', fontSize: `${fontSize}px`, color: '#06121f', fontStyle: 'bold' })
    .setOrigin(0.5);
  c.add([bg, txt]);
  c.setSize(w, h);
  c.setInteractive({ useHandCursor: true });

  c.on('pointerover', () => c.setScale(1.05));
  c.on('pointerout', () => c.setScale(1));
  c.on('pointerdown', () => c.setScale(0.96));
  c.on('pointerup', () => {
    c.setScale(1.05);
    onClick();
  });
  return c;
}

export function setButtonEnabled(btn: Phaser.GameObjects.Container, enabled: boolean) {
  btn.setAlpha(enabled ? 1 : 0.4);
  if (enabled) btn.setInteractive({ useHandCursor: true });
  else btn.disableInteractive();
}
