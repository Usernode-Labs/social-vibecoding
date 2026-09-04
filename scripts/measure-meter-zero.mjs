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
    if (!fill) continue;
    const card = track.closest('.home-challenge-card');
    out.push({
      goal: card?.querySelector('.home-panel-goal')?.textContent?.trim() || '(unknown)',
      now: Number(track.getAttribute('aria-valuenow')),
      max: Number(track.getAttribute('aria-valuemax')),
      fillWidth: fill.getBoundingClientRect().width,
      pillRadius: parseFloat(getComputedStyle(track).getPropertyValue('--home-meter-radius')) * 16,
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
  const pill = p.locator(fillSel).locator('xpath=ancestor::*[contains(@class,"home-challenge-meter")][1]');
  // The launcher is a long feed inside its own scroller, so every one of these
  // starts well below the fold. A screenshot of an element that is not in view
  // comes back blank, which reads as "nothing painted" — the exact answer this
  // tool exists to distinguish from a real one.
  await pill.scrollIntoViewIfNeeded();
  // HIDE THE COUNT FIRST. It is drawn in the same ink the fill is tinted
  // from, so its anti-aliased glyphs classify as fill and the tool reported
  // more pixels painted than the fill was laid out at. What is being measured
  // is the fill's visible extent; the label sits over it either way.
  await pill.evaluate((el) => {
    for (const n of el.querySelectorAll(':scope > *:not(.home-panel-bar-fill)')) {
      n.style.visibility = 'hidden';
    }
  });
  const shot = await pill.screenshot();
  await pill.evaluate((el) => {
    for (const n of el.querySelectorAll(':scope > *')) n.style.visibility = '';
  });
  return p.evaluate(async ({ png, colour }) => {
    const bmp = await createImageBitmap(await (await fetch(png)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    // NEAREST OF TWO, not "within a tolerance of one". The fill is a tint
    // over the track, so the two composited colours are close — a fixed
    // tolerance around the fill also swallowed the track, and the tool
    // reported more pixels painted than the fill was even laid out at.
    const want = colour.fill.match(/\d+/g).slice(0, 3).map(Number);
    const other = colour.track.match(/\d+/g).slice(0, 3).map(Number);
    const d2 = (d, x, c) => (d[x * 4] - c[0]) ** 2
      + (d[x * 4 + 1] - c[1]) ** 2 + (d[x * 4 + 2] - c[2]) ** 2;
    const isFill = (d, x) => d2(d, x, want) < d2(d, x, other) && d2(d, x, want) < 900;
    // The WIDEST row, not a chosen one. The capsule's corner eats into its
    // top and bottom rows and the count's digits cross its middle, so no
    // single row is the honest answer; the widest is the run a reader sees as
    // the fill's extent. It also sidesteps the fractional-box problem that a
    // bottom-row sample had — a row past the painted edge simply scores zero.
    let best = 0;
    for (let y = 0; y < bmp.height; y += 1) {
      const row = g.getImageData(0, y, bmp.width, 1).data;
      let seen = 0;
      for (let x = 0; x < bmp.width; x += 1) if (isFill(row, x)) seen += 1;
      if (seen > best) best = seen;
    }
    return best;
  }, { png: `data:image/png;base64,${shot.toString('base64')}`, colour });
}

for (let i = 0; i < results.length; i += 1) {
  const r = results[i];
  const sel = `.home-panel-bar-track >> nth=${i} >> .home-panel-bar-fill`;
  const colour = await p.evaluate((n) => {
    const f = document.querySelectorAll('.home-panel-bar-track')[n].querySelector('.home-panel-bar-fill');
    // The fill is drawn at an opacity over the capsule's track, so its
    // declared background is not the colour on screen. Compose it against the
    // track the same way the compositor does, or nothing matches.
    const cs = getComputedStyle(f);
    const bs = getComputedStyle(f.parentElement);
    const px = (v) => (v.match(/[\d.]+/g) || []).map(Number);
    const [fr, fg, fb] = px(cs.backgroundColor);
    const under = px(bs.backgroundColor);
    const a = Number(cs.opacity) * (px(cs.backgroundColor)[3] ?? 1);
    // The track is itself translucent over the white pill, so its own alpha
    // composes against white first.
    const ta = under[3] ?? 1;
    const overWhite = (c, alpha) => Math.round(alpha * c + (1 - alpha) * 255);
    const trackRGB = under.slice(0, 3).map((c) => overWhite(c, ta));
    const mix = (c, i2) => Math.round(a * c + (1 - a) * trackRGB[i2]);
    return {
      fill: `rgb(${mix(fr, 0)}, ${mix(fg, 1)}, ${mix(fb, 2)})`,
      track: `rgb(${trackRGB.join(', ')})`,
    };
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
console.log(`\nzero-progress meter paints ${worst === Infinity ? 'n/a' : `${worst}px`} at its widest row (floor ${MIN}px)`);
if (failed) process.exit(1);
