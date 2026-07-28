'use strict';

/**
 * Pre-merge check: does this proposal ADD a platform environment variable
 * that has no value set?
 *
 * The problem it solves: a proposal that starts reading
 * `process.env.SOMETHING_NEW` merges, deploys, and the platform comes up
 * without it. Before this, the only way to avoid that was for whoever
 * merged to remember to add a GitHub repo variable by hand, out of band
 * from the proposal. Now the variable is declared in dapp.json's
 * `platform_env` block in the same commit, and this check blocks the
 * merge until someone sets a value in the admin console.
 *
 * DIFF-SCOPED, and that is the load-bearing design decision. The check
 * looks only at the variables THIS branch adds relative to its merge
 * base — not at every required-and-unset variable in the platform. A
 * whole-state check would mean one unset variable blocks every merge on
 * the platform, including the proposal that would fix it. Three-dot
 * (merge-base) semantics for the same reason services/app-admins.js uses
 * them: main moving underneath a branch is not something the branch did.
 *
 * FAILS OPEN on anything indeterminate — no GitHub, unparseable repo, no
 * merge base, transport error. The state before this feature existed was
 * "no gate at all", so a GitHub hiccup should degrade to that rather
 * than freezing every self-app merge. A determinate answer of "this adds
 * a required variable with no value" is the only thing that blocks.
 *
 * Only the self-hosted platform app is in scope. A child dapp's env
 * comes from `app_secrets` and is gated by its own deploy-time
 * missing-required check; a child manifest carrying a `platform_env`
 * block is meaningless and is skipped here explicitly rather than
 * accidentally evaluated.
 */

const log = require('./logger');

// Parse a manifest source blob into its platform_env entries. Anything
// unparseable resolves to [] — the same leniency the deploy reader has,
// which makes "no block on either side" a non-change rather than an
// error.
function platformEnvFromManifestSource(raw) {
  if (raw == null) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  // eslint-disable-next-line global-require
  const appManifest = require('./app-manifest');
  return appManifest.readPlatformEnv(parsed) || [];
}

// Same ref-selection rule as app-admins.headRefForSession: an imported
// PR is identified by its head sha, a native proposal by its branch.
function headRefForSession(session) {
  return session?.source === 'imported'
    ? (session.imported_pr_head_sha || session.branch_name || null)
    : (session?.branch_name || null);
}

const SKIP = (reason) => ({
  state: 'skipped',
  detail: { missing: [], added: [], removed: [], reason },
});

/**
 * Evaluate the check for one proposal.
 *
 * Returns { state, detail } where state is:
 *   'passing' — determinate, and nothing this branch adds is unset
 *   'failing' — determinate, and it adds a required variable with no value
 *   'skipped' — not applicable, or could not be determined (fails open)
 *   'error'   — a DB failure while looking up stored values
 *
 * detail is always { missing:[{key,required,description}], added:[key],
 * removed:[key], reason } so the UI and the block message have one shape
 * to read regardless of outcome.
 */
async function resolvePlatformEnvCheck({ pool, app, session }) {
  if (!app || !app.self_hosted) {
    return SKIP('Only the platform\'s own proposals declare platform variables.');
  }

  const headRef = headRefForSession(session);
  if (!headRef) return SKIP('No branch to compare.');

  // eslint-disable-next-line global-require
  const github = require('./github');
  // eslint-disable-next-line global-require
  const appManifest = require('./app-manifest');
  if (!github.isEnabled()) return SKIP('GitHub is not configured.');

  const [, owner, repo] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!owner || !repo) return SKIP('Could not parse the repository URL.');

  let compare;
  try {
    compare = await github.compareRefs(owner, repo, `main...${headRef}`);
  } catch (err) {
    log.warn('platform-env-check', 'compareRefs failed (failing open)', {
      sessionId: session?.id, err: err.message,
    });
    return SKIP('Could not reach GitHub to compare the branch.');
  }

  const { mergeBaseSha, files, filesComplete } = compare;
  if (!mergeBaseSha) return SKIP('No merge base with main.');

  // One API call total for the common case. Only trust an exhaustive
  // file list — the compare endpoint caps it, and a capped list that
  // happens not to mention dapp.json proves nothing.
  if (filesComplete && !files.includes(appManifest.MANIFEST_FILENAME)) {
    return {
      state: 'passing',
      detail: { missing: [], added: [], removed: [], reason: 'This proposal does not change dapp.json.' },
    };
  }

  let baseRaw;
  let headRaw;
  try {
    [baseRaw, headRaw] = await Promise.all([
      github.getFileContent(owner, repo, appManifest.MANIFEST_FILENAME, mergeBaseSha),
      github.getFileContent(owner, repo, appManifest.MANIFEST_FILENAME, headRef),
    ]);
  } catch (err) {
    log.warn('platform-env-check', 'Manifest fetch failed (failing open)', {
      sessionId: session?.id, err: err.message,
    });
    return SKIP('Could not read dapp.json from GitHub.');
  }

  const before = platformEnvFromManifestSource(baseRaw);
  const after = platformEnvFromManifestSource(headRaw);
  const beforeKeys = new Set(before.map((e) => e.key));
  const afterKeys = new Set(after.map((e) => e.key));

  const added = after.filter((e) => !beforeKeys.has(e.key));
  const removed = before.filter((e) => !afterKeys.has(e.key)).map((e) => e.key);

  if (!added.length) {
    return {
      state: 'passing',
      detail: {
        missing: [], added: [], removed,
        reason: removed.length
          ? `This proposal removes ${removed.length} platform variable${removed.length === 1 ? '' : 's'} and adds none.`
          : 'This proposal adds no platform variables.',
      },
    };
  }

  // Which of the added variables already have a value? Only the ones a
  // human could actually set matter — an added `unwritable` declaration
  // is documentation of a GitHub secret, not something to block on.
  const candidates = added.filter((e) => e.required && !e.unwritable);
  let stored = new Set();
  if (candidates.length) {
    try {
      const { rows } = await pool.query(
        'SELECT key FROM platform_env_values WHERE app_id = $1 AND key = ANY($2::text[])',
        [app.id, candidates.map((e) => e.key)]
      );
      stored = new Set(rows.map((r) => r.key));
    } catch (err) {
      log.error('platform-env-check', 'Stored-value lookup failed', {
        sessionId: session?.id, err: err.message,
      });
      return {
        state: 'error',
        detail: {
          missing: [], added: added.map((e) => e.key), removed,
          reason: 'Could not read the stored platform variables.',
        },
      };
    }
  }

  const missing = candidates
    .filter((e) => !stored.has(e.key))
    .map((e) => ({ key: e.key, required: true, description: e.description || '' }));

  return {
    state: missing.length ? 'failing' : 'passing',
    detail: {
      missing,
      added: added.map((e) => e.key),
      removed,
      reason: missing.length
        ? `This proposal adds ${missing.length} required platform variable${missing.length === 1 ? '' : 's'} that ${missing.length === 1 ? 'has' : 'have'} no value set.`
        : `This proposal adds ${added.length} platform variable${added.length === 1 ? '' : 's'}, all with values set.`,
    },
  };
}

/**
 * Persist the verdict on the session row. Deliberately its OWN columns
 * rather than folding into `check_state`: that column is owned by the
 * staging-capture pipeline and rewritten wholesale on every storeChecks()
 * run, which would clobber a verdict computed from a completely
 * different input. Best-effort — a stamp failure must not break the
 * caller, which is always some other pipeline's happy path.
 */
async function storePlatformEnvCheck(pool, sessionId, result) {
  try {
    await pool.query(
      `UPDATE chat_sessions
          SET platform_env_state = $2,
              platform_env_detail = $3::jsonb
        WHERE id = $1`,
      [sessionId, result.state, JSON.stringify(result.detail || {})]
    );
  } catch (err) {
    log.warn('platform-env-check', 'Verdict stamp failed', { sessionId, err: err.message });
  }
}

/** Resolve + persist in one call, swallowing everything. */
async function refreshPlatformEnvCheck({ pool, app, session }) {
  try {
    const result = await resolvePlatformEnvCheck({ pool, app, session });
    await storePlatformEnvCheck(pool, session.id, result);
    return result;
  } catch (err) {
    log.warn('platform-env-check', 'Refresh failed', { sessionId: session?.id, err: err.message });
    return null;
  }
}

/**
 * The human-readable merge-block message. Names the variables and says
 * exactly where to go — a gate that only says "blocked" costs more time
 * than it saves.
 */
function describeBlock(detail, label) {
  const missing = (detail && detail.missing) || [];
  const keys = missing.map((m) => m.key).join(', ');
  return `${label} reached the vote threshold but adds ${missing.length} platform environment variable${missing.length === 1 ? '' : 's'} with no value set (${keys}). `
    + 'Open the platform\'s Platform variables panel (the "+" menu on its dev tab): an admin can set the value outright, '
    + 'and anyone else can propose one by vote. A value has to be APPLIED to clear this — a proposal still waiting on votes '
    + 'does not count. Then vote again; the check is re-evaluated at that moment, so no rebuild is needed.';
}

module.exports = {
  resolvePlatformEnvCheck,
  storePlatformEnvCheck,
  refreshPlatformEnvCheck,
  describeBlock,
  headRefForSession,
  platformEnvFromManifestSource,
};
