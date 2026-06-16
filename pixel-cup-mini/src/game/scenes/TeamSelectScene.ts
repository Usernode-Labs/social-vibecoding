import Phaser from 'phaser';
import { Scenes, GAME_WIDTH, GAME_HEIGHT, COLORS } from '../constants';
import { makeButton, setButtonEnabled } from '../ui/widgets';
import { TEAMS, pickOpponent, getTeam } from '../logic/teams';

// Team Select Screen: five national-team cards, pick one, see the
// auto-assigned opponent, then Kick Off.
export class TeamSelectScene extends Phaser.Scene {
  private selectedId: string | null = null;
  private opponentId: string | null = null;
  private cards: Phaser.GameObjects.Container[] = [];
  private kickBtn?: Phaser.GameObjects.Container;
  private vsText?: Phaser.GameObjects.Text;
  private rng = new Phaser.Math.RandomDataGenerator();

  constructor() {
    super(Scenes.TeamSelect);
  }

  create() {
    this.selectedId = null;
    this.opponentId = null;
    this.cards = [];
    this.cameras.main.setBackgroundColor(COLORS.panel);

    this.add
      .text(GAME_WIDTH / 2, 44, 'CHOOSE YOUR TEAM', {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setStroke('#06121f', 6);

    const cardW = 128;
    const gap = 14;
    const totalW = TEAMS.length * cardW + (TEAMS.length - 1) * gap;
    const startX = (GAME_WIDTH - totalW) / 2 + cardW / 2;
    const cardY = 188;

    TEAMS.forEach((team, i) => {
      const x = startX + i * (cardW + gap);
      const card = this.makeCard(x, cardY, cardW, team);
      this.cards.push(card);
    });

    this.vsText = this.add
      .text(GAME_WIDTH / 2, 300, '', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: '#ffdf1b',
      })
      .setOrigin(0.5);

    this.kickBtn = makeButton(this, GAME_WIDTH / 2, 360, 'KICK OFF ⚽', () => {
      if (!this.selectedId || !this.opponentId) return;
      this.scene.start(Scenes.Match, {
        playerTeamId: this.selectedId,
        opponentTeamId: this.opponentId,
      });
    });
    setButtonEnabled(this.kickBtn, false);

    makeButton(this, 90, GAME_HEIGHT - 36, '‹ BACK', () => this.scene.start(Scenes.Start), {
      color: 0x6c7bb0,
      width: 130,
      height: 40,
      fontSize: 16,
    });
  }

  private makeCard(x: number, y: number, w: number, team: { id: string; name: string; shirt: number; flag: number[] }) {
    const h = 150;
    const c = this.add.container(x, y);
    const frame = this.add.rectangle(0, 0, w, h, 0x1b2456, 1).setStrokeStyle(3, 0x3a4a8c, 1);

    // Kit swatch (shirt).
    const shirt = this.add.rectangle(0, -22, 56, 56, team.shirt, 1).setStrokeStyle(2, 0x06121f, 1);

    // Flag bar (three colour stripes).
    const flag = this.add.container(0, 30);
    const stripeW = 84 / team.flag.length;
    team.flag.forEach((col, i) => {
      flag.add(this.add.rectangle(-42 + stripeW * i + stripeW / 2, 0, stripeW, 16, col, 1));
    });

    const name = this.add
      .text(0, 56, team.name, { fontFamily: 'monospace', fontSize: '15px', color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5);

    c.add([frame, shirt, flag, name]);
    c.setSize(w, h);
    c.setInteractive({ useHandCursor: true });
    c.on('pointerup', () => this.select(team.id));
    (c as any)._frame = frame;
    (c as any)._teamId = team.id;
    return c;
  }

  private select(id: string) {
    this.selectedId = id;
    // Highlight selected, dim others.
    this.cards.forEach((c) => {
      const fr = (c as any)._frame as Phaser.GameObjects.Rectangle;
      const isSel = (c as any)._teamId === id;
      fr.setStrokeStyle(3, isSel ? 0xffdf1b : 0x3a4a8c, 1);
      c.setScale(isSel ? 1.06 : 1);
    });

    const opp = pickOpponent(id, () => this.rng.frac());
    this.opponentId = opp ? opp.id : null;
    if (opp) {
      this.vsText?.setText(`${getTeam(id)?.name}  vs  ${opp.name}`);
    }
    if (this.kickBtn) setButtonEnabled(this.kickBtn, true);
  }
}
