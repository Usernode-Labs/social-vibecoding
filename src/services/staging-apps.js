'use strict';

const crypto = require('crypto');
const discoveryCuration = require('./discovery-curation');
const conversations = require('./conversations');

const DEMO_ICON_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAYAAAByDd+UAAAAg0lEQVR42r3NuRGAMAwEQNdFbXRAIVRHAyQwDmB4/MjS3QUbb5qn7VBKymxddl2YM1l4ZZLwmdHDb0YNSxktrGWUsJXBw14GDS0ZLLRmkHAkC4ejWSj0ZO7Qm7nCSDYcRrOhEJGZQ1RmCpFZN0RnzZCRVUNWVgyZ2S9kZ69Qkd2hKstOLPva44BQr+EAAAAASUVORK5CYII=';
function demoAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function catalogFixtures(curation = false) {
  const base = {
    status: 'running',
    self_hosted: false,
    locked: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    created_at: new Date().toISOString(),
    last_deploy_at: new Date().toISOString(),
    main_sha: '0000000000000000000000000000000000000001',
    directory_reviewed_sha: '0000000000000000000000000000000000000001',
    directory_reviewed_at: new Date().toISOString(),
    directory_review_status: 'working',
    url: null,
    version: null,
    deployProgress: null,
    missingSecrets: null,
    active_users: 0,
    is_favorited: false,
    your_apps_hidden: false,
    favorite_order: null,
    featured: false,
    featured_order: null,
    is_collaborator: false,
    open_prs: 0,
    active_sessions: 0,
    merged_prs: 0,
    merged_prs_recent: 0,
    last_merged_at: null,
    open_issues: 0,
    icon_emoji: null,
    icon_url: null,
    can_collaborate: false,
    can_manage: false,
    can_report: false,
    demo: true,
  };
  const apps = [
    { ...base, id: 900001, slug: 'staging-demo-emoji-icon', name: 'Staging demo emoji icon', icon_emoji: '🎮' },
    {
      ...base,
      id: 900002,
      slug: 'staging-demo-image-icon',
      name: 'Staging demo image icon',
      icon_url: DEMO_ICON_PNG,
      featured: true,
      featured_order: 0,
    },
    {
      ...base,
      id: 900003,
      slug: 'staging-demo-featured',
      name: 'Staging demo featured app',
      icon_emoji: '⭐',
      featured: true,
      featured_order: 1,
    },
    {
      ...base,
      id: 900012,
      slug: 'staging-demo-long-name',
      name: 'Staging demo photo album and journal',
      icon_emoji: '📔',
    },
    {
      ...base,
      id: 900013,
      slug: 'staging-demo-your-app',
      name: 'Staging demo your app',
      icon_emoji: '🏠',
      is_favorited: true,
      favorite_order: 99,
    },
    {
      ...base, id: 900004, slug: 'staging-demo-featured-2',
      name: 'Staging demo featured 2', icon_emoji: '🎲',
      featured: true, featured_order: 2,
    },
    {
      ...base, id: 900005, slug: 'staging-demo-featured-3',
      name: 'Staging demo featured 3', icon_emoji: '🧩',
      featured: true, featured_order: 3,
    },
    {
      ...base, id: 900006, slug: 'staging-demo-featured-4',
      name: 'Staging demo featured 4', icon_emoji: '🚀',
      featured: true, featured_order: 4,
    },
    {
      ...base, id: 900007, slug: 'staging-demo-featured-5',
      name: 'Staging demo featured 5', icon_emoji: '🎨',
      featured: true, featured_order: 5,
    },
    {
      ...base, id: 900008, slug: 'staging-demo-popular-1',
      name: 'Staging demo popular 1', icon_emoji: '🔥', active_users: 12,
      merged_prs: 3, merged_prs_recent: 0, last_merged_at: demoAgo(90 * 24),
      created_at: demoAgo(200 * 24), last_deploy_at: demoAgo(60 * 24),
    },
    {
      ...base, id: 900009, slug: 'staging-demo-popular-2',
      name: 'Staging demo popular 2', icon_emoji: '📈', active_users: 9,
      merged_prs: 41, merged_prs_recent: 11, last_merged_at: demoAgo(2),
      created_at: demoAgo(120 * 24), last_deploy_at: demoAgo(2),
    },
    {
      ...base, id: 900010, slug: 'staging-demo-popular-3',
      name: 'Staging demo popular 3', icon_emoji: '🎧', active_users: 7,
      merged_prs: 6, merged_prs_recent: 5, last_merged_at: demoAgo(24),
      created_at: demoAgo(3 * 24), last_deploy_at: demoAgo(24),
    },
    {
      ...base, id: 900011, slug: 'staging-demo-popular-4',
      name: 'Staging demo popular 4', icon_emoji: '🗺️', active_users: 5,
      created_at: demoAgo(400 * 24), last_deploy_at: demoAgo(300 * 24),
    },
  ];
  if (curation) apps.push(
    { ...base, id: 990031, slug: 'directory-sample-working', name: 'Directory sample working',
      icon_emoji: '🧩', featured: true, featured_order: -1 },
    { ...base, id: 990032, slug: 'directory-sample-unreviewed', name: 'Directory sample unreviewed',
      icon_emoji: '🌱', directory_review_status: 'unreviewed', directory_reviewed_at: null },
    { ...base, id: 990033, slug: 'directory-sample-demo', name: 'Directory sample demo',
      icon_emoji: '🎭', directory_review_status: 'demo', active_users: 9999 },
    { ...base, id: 990034, slug: 'directory-sample-broken', name: 'Directory sample needs fixes',
      icon_emoji: '🔧', directory_review_status: 'broken', active_users: 9998 },
    { ...base, id: 990035, slug: 'directory-sample-no-icon', name: 'Directory sample needs an icon' },
  );
  return apps.map((app) => ({ ...app, directory: discoveryCuration.describe(app) }));
}

const CATALOG_SLUGS = new Set(catalogFixtures(true).map(app => app.slug));

function isCatalogSlug(slug) { return CATALOG_SLUGS.has(slug); }

function isSample(app) {
  return process.env.USERNODE_ENV === 'staging' && !!app
    && (CATALOG_SLUGS.has(app.slug) || String(app.slug).startsWith('staging-demo-'))
    && app.created_by === 900001 && !app.self_hosted && !app.repo_url && !app.container_id && !app.runtime_name
    && app.status === 'running';
}

async function seedCatalog(pool, config = {}) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  // Failure must stop the seed instead of publishing tiles with missing rows.
  await conversations.transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(4781, -1)');
    const owner = await db.query(
      "SELECT id FROM users WHERE id = 900001 AND username = 'staging-demo-user' AND password = 'staging-demo-not-a-login'");
    if (!owner.rows.length) throw new Error('Staging catalog fixture owner is missing or conflicts with an existing user');
    const sampleSha = crypto.createHash('sha1').update('homeroom-persisted-staging-catalog-v1').digest('hex');
    const activeUsers = [];
    for (let i = 1; i <= 12; i++) {
      const username = `staging-demo-catalog-${i}`;
      await db.query(
        `INSERT INTO users (username, password, profile_published)
         VALUES ($1, 'staging-demo-not-a-login', TRUE) ON CONFLICT (username) DO NOTHING`, [username]);
      const actor = await db.query(
        "SELECT id FROM users WHERE username = $1 AND password = 'staging-demo-not-a-login'", [username]);
      if (!actor.rows.length) throw new Error('Staging catalog activity account conflicts with an existing user');
      activeUsers.push(actor.rows[0].id);
    }
    for (const fixture of catalogFixtures(true)) {
      // Resolve by slug, not the old response-only ID which can identify a
      // completely different cloned app. Never overwrite that app's owner.
      await db.query(
        `INSERT INTO apps (name, slug, status, created_by, view_visibility, icon_emoji, created_at,
           main_sha, directory_reviewed_sha, directory_reviewed_at, directory_review_status)
         VALUES ($1, $2, 'running', 900001, 'public', $3, $4, $5, $5, NOW(), $6)
         ON CONFLICT (slug) DO NOTHING`,
        [fixture.name, fixture.slug, fixture.icon_emoji, fixture.created_at, sampleSha, fixture.directory_review_status]);
      const found = await db.query('SELECT * FROM apps WHERE slug = $1', [fixture.slug]);
      const app = found.rows[0];
      if (!app || app.created_by !== 900001 || app.self_hosted || app.repo_url || app.container_id || app.runtime_name) {
        throw new Error(`Staging catalog slug conflicts with an existing app: ${fixture.slug}`);
      }
      // Initialize assets and relationships once, preserving later moderation,
      // unfavorites, reactions and other actions when Preview is restarted.
      const initialized = await db.query(
        `INSERT INTO staging_app_fixtures (app_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING app_id`, [app.id]);
      if (!initialized.rows.length) continue;
      if (fixture.icon_url) {
        const bytes = Buffer.from(DEMO_ICON_PNG.split(',')[1], 'base64');
        const iconId = crypto.randomBytes(16).toString('hex');
        const result = await db.query(
          `INSERT INTO app_icons (id, app_id, content_type, data, sha256) VALUES ($1, $2, 'image/png', $3, $4)
           ON CONFLICT (app_id) DO NOTHING RETURNING id`,
          [iconId, app.id, bytes, crypto.createHash('sha256').update(bytes).digest('hex')]);
        if (result.rows[0]) await db.query('UPDATE apps SET icon_image_id = $1 WHERE id = $2', [iconId, app.id]);
      }
      await db.query(
        "INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, 900001, 'member', NOW()) ON CONFLICT DO NOTHING", [app.id]);
      if (fixture.featured) await db.query(
        'INSERT INTO featured_apps (app_id, sort_order, created_by) VALUES ($1, $2, NULL) ON CONFLICT DO NOTHING',
        [app.id, fixture.featured_order]);
      if (fixture.is_favorited || ['staging-demo-emoji-icon', 'staging-demo-image-icon'].includes(fixture.slug)) await db.query(
        `INSERT INTO app_favorites (app_id, user_id, sort_order)
         SELECT $1, id, 99 FROM users WHERE username = ANY($2::text[]) ON CONFLICT DO NOTHING`,
        [app.id, [config.adminUsername, 'usernode-capture', 'usernode-capture-admin'].filter(Boolean)]);
      for (const actorId of activeUsers.slice(0, Math.min(12, fixture.active_users))) {
        await db.query(
          `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, CURRENT_DATE, 120)
           ON CONFLICT DO NOTHING`, [app.id, actorId]);
      }
    }
    // The demo layout names these real apps, but a layout cell alone does
    // not add an app to Your apps. Seed actual favorites, leaving featured
    // and popular apps available in Discover. Track this separately so
    // existing Previews get the missing favorites once, and removing one
    // survives a restart just like removing any other app.
    const homeApps = await db.query(
      `INSERT INTO staging_app_fixtures (app_id, home_favorite_seeded)
       SELECT id, TRUE FROM apps WHERE slug = ANY($1::text[])
         AND created_by = 900001 AND NOT self_hosted AND repo_url IS NULL
         AND container_id IS NULL AND runtime_name IS NULL AND status = 'running'
       ON CONFLICT (app_id) DO UPDATE SET home_favorite_seeded = TRUE
         WHERE NOT staging_app_fixtures.home_favorite_seeded
       RETURNING app_id`,
      [['staging-demo-long-name', 'staging-demo-pixel-racer',
        'staging-demo-puzzle-chain', 'staging-demo-word-garden']]);
    for (const { app_id: appId } of homeApps.rows) {
      await db.query(
        `INSERT INTO app_favorites (app_id, user_id, sort_order)
         SELECT $1, id, 99 FROM users WHERE username = ANY($2::text[]) ON CONFLICT DO NOTHING`,
        [appId, [config.adminUsername, 'usernode-capture', 'usernode-capture-admin'].filter(Boolean)]);
    }
  });
}

module.exports = { catalogFixtures, seedCatalog, isSample, isCatalogSlug };
