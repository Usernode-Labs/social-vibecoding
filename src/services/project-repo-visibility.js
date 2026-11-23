'use strict';

const gitHost = require('./git-host');
const source = require('./project-source');
const log = require('./logger');

function configured() {
  return process.env.GIT_HOST_PRIVATE_PROJECTS_WRITE === 'true';
}

function enabled() {
  return configured() && gitHost.hasWriteAccess();
}

function managedApp(app) {
  return !app.self_hosted && source.managedRepo(app.repo_url);
}

function privateAtCreation(app) {
  return enabled() && app.view_visibility === 'private' && source.selected(app.slug);
}

async function withAppLock(pool, id, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [app] } = await client.query(
      `SELECT id, slug, repo_url, status, self_hosted, collab_visibility, view_visibility,
              manifest_snapshot->'visibility' AS requested_visibility, repo_publication_pending
         FROM apps WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const result = app && await work(client, app);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function syncRepo(repo, isPrivate) {
  const { data } = await gitHost.api('GET', `/repos/${encodeURIComponent(gitHost.settings().org)}/${encodeURIComponent(repo)}`);
  if (typeof data?.private !== 'boolean') throw new Error('Forgejo did not report repository visibility');
  if (data.private !== isPrivate) await gitHost.setPrivate(repo, isPrivate);
}

async function record(pool, app, { collab, view }) {
  return withAppLock(pool, app.id, async (client, current) => {
    const repo = managedApp(current);
    if (!repo || current.repo_url !== app.repo_url) return null;
    const desired = current.requested_visibility;
    if (desired && ((desired.view || current.view_visibility) !== view
        || (desired.build || current.collab_visibility) !== collab)) return null;
    if (current.view_visibility === view && current.collab_visibility === collab) return null;

    // Forgejo must stop serving anonymously before the app is marked private.
    if (view === 'private') await syncRepo(repo, true);
    await client.query(
      `UPDATE apps SET collab_visibility = $1, view_visibility = $2,
              repo_publication_pending = $3 WHERE id = $4`,
      [collab, view, view === 'public' && (current.view_visibility === 'private' || current.repo_publication_pending), app.id],
    );
    return current;
  });
}

async function reconcileRepo(pool, id) {
  return withAppLock(pool, id, async (client, app) => {
    const repo = managedApp(app);
    if (!repo) return;
    if (app.view_visibility === 'private') {
      await syncRepo(repo, true);
    } else if (app.repo_publication_pending && app.status !== 'archived' && app.requested_visibility?.view !== 'private') {
      // Publishing is recorded only by a private-to-public visibility change.
      // An existing public app with a manually private repo is left alone.
      await syncRepo(repo, false);
      await client.query('UPDATE apps SET repo_publication_pending = FALSE WHERE id = $1', [id]);
    }
  });
}

async function sweep(pool, { shouldStop = () => false } = {}) {
  if (!enabled() || !process.env.GIT_HOST_PRIVATE_PROJECTS) return { checked: 0, failed: 0 };
  const { rows } = await pool.query(
    `SELECT id, slug, repo_url, status, self_hosted, collab_visibility, view_visibility,
            manifest_snapshot->'visibility' AS requested_visibility, repo_publication_pending
       FROM apps
      WHERE repo_url IS NOT NULL AND NOT self_hosted
        AND (view_visibility = 'private' OR repo_publication_pending
             OR manifest_snapshot->'visibility'->>'view' = 'private')
      ORDER BY id`,
  );
  const queue = rows.filter(managedApp);
  let checked = 0;
  let failed = 0;
  async function next() {
    while (queue.length && !shouldStop()) {
      const app = queue.shift();
      try {
        if (app.status !== 'archived' && app.requested_visibility?.view !== app.view_visibility) {
          await require('./app-manifest').reconcileAppVisibility(pool, app, { visibility: app.requested_visibility });
        }
        await reconcileRepo(pool, app.id);
        checked++;
      } catch (err) {
        failed++;
        log.warn('project-repo-visibility', 'Forgejo visibility reconcile failed', { appId: app.id, slug: app.slug, code: err.code });
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, next));
  return { checked, failed };
}

module.exports = { configured, enabled, managedApp, privateAtCreation, record, reconcileRepo, sweep };
