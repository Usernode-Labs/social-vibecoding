import Phaser from 'phaser';
import { Scenes, GAME_WIDTH, GAME_HEIGHT, COLORS } from '../constants';
import { makeButton } from '../ui/widgets';
import { getTeam } from '../logic/teams';

interface WinData {
  playerTeamId: string;
  opponentTeamId: string;
  playerScore: number;
  opponentScore: number;
}

// Result ("Win") Screen. Headline reflects the player's outcome; a win
// gets a confetti flourish. By construction a finished match is never a
// draw (golden goal resolves ties).
export class WinScene extends Phaser.Scene {
  constructor() {
    super(Scenes.Win);
  }

  create(data: WinData) {
    const player = getTeam(data.playerTeamId);
    const opp = getTeam(data.opponentTeamId);
    const won = data.playerScore > data.opponentScore;

    this.cameras.main.setBackgroundColor(won ? 0x123a1f : 0x3a1212);

    const cx = GAME_WIDTH / 2;

    const headline = this.add
      .text(cx, 96, won ? 'YOU WIN!' : 'YOU LOSE', {
        fontFamily: 'monospace',
        fontSize: '60px',
        color: won ? '#ffdf1b' : '#ff8b8b',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setStroke('#06121f', 8);
    this.tweens.add({ targets: headline, scale: 1.06, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.inOut' });

    // Scoreline with team colour swatches.
    const lineY = 188;
    this.add.rectangle(cx - 150, lineY, 34, 34, player?.shirt ?? 0xffffff).setStrokeStyle(2, 0x06121f);
    this.add.rectangle(cx + 150, lineY, 34, 34, opp?.shirt ?? 0xffffff).setStrokeStyle(2, 0x06121f);
    this.add
      .text(cx, lineY, `${player?.name ?? '—'}   ${data.playerScore} – ${data.opponentScore}   ${opp?.name ?? '—'}`, {
        fontFamily: 'monospace',
        fontSize: '22px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    if (won) this.confetti();

    makeButton(this, cx, 268, 'REMATCH', () =>
      this.scene.start(Scenes.Match, {
        playerTeamId: data.playerTeamId,
        opponentTeamId: data.opponentTeamId,
      })
    );
    makeButton(this, cx, 326, 'CHANGE TEAM', () => this.scene.start(Scenes.TeamSelect), {
      color: 0x2bd17e,
      width: 200,
      height: 44,
      fontSize: 16,
    });
    makeButton(this, cx, 380, 'MAIN MENU', () => this.scene.start(Scenes.Start), {
      color: 0x6c7bb0,
      width: 200,
      height: 44,
      fontSize: 16,
    });
  }

  private confetti() {
    const colors = [0xffdf1b, 0x2bd17e, 0xff5b5b, 0x76b6e6, 0xffffff];
    for (let i = 0; i < 60; i++) {
      const x = Phaser.Math.Between(0, GAME_WIDTH);
      const c = this.add.rectangle(x, -10, 5, 9, colors[i % colors.length]);
      this.tweens.add({
        targets: c,
        y: GAME_HEIGHT + 20,
        x: x + Phaser.Math.Between(-40, 40),
        angle: Phaser.Math.Between(-180, 180),
        duration: Phaser.Math.Between(1800, 3600),
        delay: Phaser.Math.Between(0, 1500),
        repeat: -1,
        ease: 'Quad.in',
      });
    }
  }
}
