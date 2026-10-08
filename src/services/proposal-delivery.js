'use strict';

const applicationRuntime = require('./application-runtime');
const appDeployStatus = require('./app-deploy-status');
const github = require('./github');
const mirror = require('./repo-mirror');
const log = require('./logger');

const SOURCE_REVISION_LABEL = 'social.usernode.io/source-revision';
const fullSha = value => /^[a-f0-9]{40}$/i.test(String(value || ''))
  ? String(value).toLowerCase() : null;

function failureSha(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return fullSha(value?.sha);
}

function createDelivery({ runtime = applicationRuntime, progress = appDeployStatus,
  git = mirror, parseRepo = github.parseGithubUrl } = {}) {
  async function annotateChild(config, pool, app, rows) {
    let runningSha = null;
    try {
      const observed = await runtime.inspect(config, runtime.productionRef(config, app));
      if (observed?.status === 'running' && observed.rolloutReady !== false) {
        runningSha = fullSha(observed.labels?.[SOURCE_REVISION_LABEL]);
      }
    } catch (err) {
      log.warn('proposal-delivery', 'Production runtime observation failed', {
        app: app.slug, err: err.message,
      });
    }

    const failedSha = failureSha(app.last_failure);
    const deploying = (await progress.read(app.slug))?.deploying === true;
    const repo = typeof parseRepo === 'function' ? parseRepo(app.repo_url) : null;
    let dir = null;
    let headSha = null;
    if (repo && (runningSha || failedSha || deploying)) {
      try {
        dir = await git.ensureMirror(repo.owner, repo.repo);
        headSha = fullSha(await git.defaultBranchSha(dir));
      } catch (err) {
        log.warn('proposal-delivery', 'Could not prove merged commit ancestry', {
          app: app.slug, err: err.message,
        });
      }
    }

    async function includes(mergeSha, revision) {
      if (!mergeSha || !revision) return false;
      if (mergeSha === revision) return true;
      if (!dir) return false;
      try { return await git.isAncestor(dir, mergeSha, revision); }
      catch { return false; }
    }

    async function stateOf(row) {
      const mergeSha = fullSha(row.merge_commit_sha);
      if (!mergeSha) return 'unknown';
      if (await includes(mergeSha, runningSha)) return 'deployed';
      // A retry in progress supersedes the previous failed attempt, but it
      // cannot claim delivery until the running revision is observed.
      if (deploying && await includes(mergeSha, headSha)) return 'pending';
      if (await includes(mergeSha, failedSha)) return 'failed';
      if (runningSha && await includes(runningSha, mergeSha)) return 'pending';
      return 'unknown';
    }

    for (const row of rows) {
      if ((row.row_type || 'pr') === 'pr' && row.status === 'merged') {
        row.deployment_state = await stateOf(row);
        row.deployment_kind = 'child';
      }
    }

    // The summary describes the latest merge even on an older keyset page.
    const { rows: latestRows } = await pool.query(`
      SELECT id, merge_commit_sha FROM chat_sessions
      WHERE app_id = $1 AND status = 'merged'
      ORDER BY COALESCE(merged_at, created_at) DESC, id DESC LIMIT 1`, [app.id]);
    const latest = latestRows[0];
    const state = latest ? await stateOf(latest) : 'unknown';
    return {
      kind: 'child', state, runningSha,
      liveSessionId: null, livePrNumber: null, pendingCount: null,
    };
  }
  return { annotateChild };
}

module.exports = { ...createDelivery(), createDelivery, SOURCE_REVISION_LABEL };
