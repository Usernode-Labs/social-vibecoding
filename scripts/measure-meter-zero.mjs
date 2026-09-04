// Does a challenge at ZERO still show its meter?
//
// The meter runs flush with the bottom edge of a rounded pill, so the first
// `--home-pill-radius` of the fill is inside the corner and clipped away. The
// arithmetic behind `--home-meter-floor` says what should remain; this
// measures what a browser actually paints, which is the only answer that
// counts — a floor that is right on paper and invisible on a phone is the bug
// the floor exists to prevent.
//
// It samples the pill's bottom row pixel by pixel and reports how wide a run
// of the fill's colour survives the corner. Usage:
//
//   node scripts/measure-meter-zero.mjs <page.html> [minVisiblePx]
//
// `page.html` is any rendered home screen carrying a challenge at 0 —
// tests/... does not run this; it is a hand tool for the geometry, and the
// RELATIONSHIP it verifies is pinned as a unit test instead.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(`${execSync('npm root -g').toString().trim()}/playwright`);

const [page, minRaw] = process.argv.slice(2);
const MIN = Number(minRaw) || 8;
if (!page) {
  console.error('usage: node scripts/measure-meter-zero.mjs <page.html> [minVisiblePx]');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 1 });
await p.goto(page.startsWith('http') ? page : `file://${page}`);
await p.waitForTimeout(400);

const results = await p.evaluate(() => {
  const out = [];
  for (const track of document.querySelectorAll('.home-panel-bar-track')) {
    const fill = track.querySelector('.home-panel-bar-fill');
    const pill = track.closest('.home-challenge-pill');
    if (!fill || !pill) continue;
    const card = track.closest('.home-challenge-card');
    out.push({
      goal: card?.querySelector('.home-panel-goal')?.textContent?.trim() || '(unknown)',
      now: Number(track.getAttribute('aria-valuenow')),
      max: Number(track.getAttribute('aria-valuemax')),
      fillWidth: fill.getBoundingClientRect().width,
      pillRadius: parseFloat(getComputedStyle(pill).borderBottomLeftRadius),
      rect: (() => { const r = fill.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
    });
  }
  return out;
});

let worst = Infinity;
let failed = false;

// Read the PAINTED pixels, not the hit-test tree. `elementFromPoint` answers
// from a hit region that does not model an ancestor's rounded clip, so it
// reported a fill as fully visible in exactly the case this tool exists to
// check. A screenshot of the pill is the ground truth: the corner either
// covered those pixels or it did not.
async function visibleRun(fillSel, colour) {
  const pill = p.locator(fillSel).locator('xpath=ancestor::*[contains(@class,"home-challenge-pill")][1]');
  // The launcher is a long feed inside its own scroller, so every one of these
  // starts well below the fold. A screenshot of an element that is not in view
  // comes back blank, which reads as "nothing painted" — the exact answer this
  // tool exists to distinguish from a real one.
  await pill.scrollIntoViewIfNeeded();
  const shot = await pill.screenshot();
  return p.evaluate(async ({ png, colour }) => {
    const bmp = await createImageBitmap(await (await fetch(png)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const want = colour.match(/\d+/g).slice(0, 3).map(Number);
    const isFill = (d, x) => Math.abs(d[x * 4] - want[0]) < 24
      && Math.abs(d[x * 4 + 1] - want[1]) < 24
      && Math.abs(d[x * 4 + 2] - want[2]) < 24;
    // Scan UP from the bottom for the lowest row that actually carries the
    // fill, rather than taking `height - 1` outright. An element's box is
    // fractional (35.25px here), so the bitmap is a whole pixel taller than
    // the painted pill and its last row is the card behind it — which reads
    // as "nothing painted" and is not what this is asking.
    for (let y = bmp.height - 1; y >= 0; y -= 1) {
      const row = g.getImageData(0, y, bmp.width, 1).data;
      let seen = 0;
      for (let x = 0; x < bmp.width; x += 1) if (isFill(row, x)) seen += 1;
      if (seen) return seen;
    }
    return 0;
  }, { png: `data:image/png;base64,${shot.toString('base64')}`, colour });
}

for (let i = 0; i < results.length; i += 1) {
  const r = results[i];
  const sel = `.home-panel-bar-track >> nth=${i} >> .home-panel-bar-fill`;
  const colour = await p.evaluate((n) => {
    const f = document.querySelectorAll('.home-panel-bar-track')[n].querySelector('.home-panel-bar-fill');
    return getComputedStyle(f).backgroundColor;
  }, i);
  const visible = await visibleRun(sel, colour);
  const pct = r.max ? Math.round((100 * r.now) / r.max) : 0;
  const ok = visible >= MIN;
  if (!ok) failed = true;
  if (r.now === 0) worst = Math.min(worst, visible);
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${String(pct).padStart(3)}%  ${String(visible).padStart(3)}px painted `
    + `of ${r.fillWidth.toFixed(1)}px laid out (radius ${r.pillRadius}px)  ${r.goal}`
  );
}
await browser.close();

if (!results.length) { console.error('no challenge meters found on that page'); process.exit(1); }
console.log(`\nzero-progress meter paints ${worst === Infinity ? 'n/a' : `${worst}px`} on the pill's last row (floor ${MIN}px)`);
if (failed) process.exit(1);
