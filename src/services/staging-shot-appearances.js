'use strict';

// A stable, explicitly labelled staging proposal for comparing photo modes.
// Private shot artifacts are absent from staging clones; keep this sample
// in the ordinary seed lifecycle so the real reviewer UI can be exercised.
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const contract = require('./visible-changes');
const shots = require('./shots-files');
const diff = require('./shots-diff');

const SESSION_ID = 990414;
const RUN_ID = crypto.createHash('sha256').update('staging-shot-appearances-v1').digest('hex').slice(0, 32);
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

// A sample card with a longer action on the after side. Both appearances
// show the same geometry, using light/dark surfaces and a blue action.
function sampleImage(width, height, colorScheme, side) {
  const image = new PNG({ width, height });
  const colors = colorScheme === 'dark'
    ? { ground: [20, 20, 23], card: [44, 44, 46], ink: [235, 235, 240] }
    : { ground: [245, 245, 247], card: [255, 255, 255], ink: [40, 40, 45] };
  const rect = (x, y, w, h, color) => {
    for (let yy = y; yy < Math.min(height, y + h); yy++) {
      for (let xx = x; xx < Math.min(width, x + w); xx++) {
        const i = (yy * width + xx) * 4;
        image.data.set([...color, 255], i);
      }
    }
  };
  rect(0, 0, width, height, colors.ground);
  rect(24, 32, width - 48, 240, colors.card);
  rect(48, 56, Math.min(220, width - 96), 16, colors.ink);
  rect(48, 100, width - 96, 8, colors.ink);
  rect(48, 126, width - 132, 8, colors.ink);
  rect(48, 194, side === 'base' ? 92 : 160, 36, [10, 110, 224]);
  return PNG.sync.write(image);
}

async function fixture(slug) {
  const intent = contract.parseIntent({
    version: 1, impact: 'ui', rationale: 'Staging sample photos for testing appearance selection.',
    stories: [{
      id: 'sample-card', claim: 'A longer action on a sample card.', persona: 'member',
      viewports: [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844 }],
      intent: { startPath: `/#app/${slug}/dev/proposals/${SESSION_ID}`, steps: ['Open the sample card.'],
        checkpoint: 'The sample card is visible.', focus: 'Sample card', animation: 'none' },
    }],
  });
  const saved = new Map();
  for (const viewport of intent.stories[0].viewports) {
    for (const colorScheme of ['light', 'dark']) for (const side of ['base', 'head']) {
      const target = shots.shotTarget(intent, { change: 'sample-card', screen: viewport.name, side, colorScheme });
      const data = sampleImage(viewport.width, viewport.height, colorScheme, side);
      saved.set(shots.slotKey(target), shots.stored(target, data, shots.inspectImage(data)));
    }
  }
  const summary = shots.summarize(intent, saved, new Map(), { photoModes: ['light', 'dark'] });
  summary.verdict.screens = await diff.screensFor(intent.stories, summary.files);
  return { intent, summary };
}

async function seed(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const { rows } = await pool.query(
    `SELECT a.id AS app_id, u.id AS user_id FROM apps a CROSS JOIN users u
      WHERE a.slug = $1 AND u.username = 'usernode-capture'`, [config.selfAppSlug]
  );
  if (!rows[0]) return;
  const { intent, summary } = await fixture(config.selfAppSlug);
  // Pending checks prevent this sample from ever being an eligible merge.
  await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md,
        status, promoted_at, reviewed_head_sha, check_state, shots_state, shots_run_id, shots_detail)
     VALUES ($1, $2, $3, 'staging-fixture/photo-appearances', $1,
             '[Staging demo] Compare photo appearances',
             'Sample before/after photos in light and dark mode.',
             'promoted', NOW(), $4, 'pending', 'verified', $5, $6::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [SESSION_ID, rows[0].app_id, rows[0].user_id, HEAD, RUN_ID,
      JSON.stringify({ impact: 'ui', required: true, headSha: HEAD })]
  );
  const session = await pool.query(
    "SELECT id FROM chat_sessions WHERE id = $1 AND branch_name = 'staging-fixture/photo-appearances'", [SESSION_ID]
  );
  if (!session.rowCount) return;
  await pool.query(
    `INSERT INTO shot_runs
       (id, session_id, base_sha, head_sha, intent, plan_hash, hard_verdict, state, completed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, 'verified', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [RUN_ID, SESSION_ID, BASE, HEAD, JSON.stringify(intent), summary.manifestHash, JSON.stringify(summary.verdict)]
  );
  for (const file of summary.files) {
    const id = crypto.createHash('sha256').update(`${RUN_ID}:${shots.slotKey(file)}`).digest('hex').slice(0, 32);
    await pool.query(
      `INSERT INTO shot_artifacts
         (id, run_id, story_id, viewport, side, variant, media, content_type, data,
          width, height, bytes, sha256, color_scheme)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO NOTHING`,
      [id, RUN_ID, file.storyId, file.viewport, file.side, file.variant, file.media,
        file.contentType, file.data, file.width, file.height, file.bytes, file.sha256, file.colorScheme]
    );
  }
}

module.exports = { seed, fixture, SESSION_ID, RUN_ID, BASE, HEAD };
