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

// ---------------------------------------------------------------------------
// Head-scoped `unwritable` derivation.
//
// THE BUG THIS FIXES. readPlatformEnv() derives `unwritable` from the reserved
// lists of the module that is CURRENTLY RUNNING — the deployed platform. But
// this check evaluates a BRANCH's dapp.json. A proposal that declares a new
// deploy-owned variable does two things in one commit: adds the platform_env
// entry, and names the key in PLATFORM_ENV_UNWRITABLE so it renders read-only.
// The running platform hasn't got that second half yet, so it scored the new
// entry as writable-and-required-and-unset and blocked the very merge that
// would have made it unwritable. Self-blocking, with no way out except a
// force-merge — exactly what happened to the JWT key-separation PR, which
// declared DATA_ENCRYPTION_KEY / IFRAME_JWT_{PRIVATE,PUBLIC}_KEY /
// WORKER_JWT_SECRET / EDGE_JWT_SECRET and was told all five "have no value
// set" despite being unsettable by construction.
//
// The fix is to make the reserved lists head-scoped, the same way the manifest
// diff already is: read them out of the branch's own app-manifest.js and union
// them with the running platform's.
//
// WHY THIS DOESN'T WEAKEN THE GATE. Becoming unwritable is not something a
// manifest can ask for — it requires editing the reserved list in
// src/services/app-manifest.js, a reviewed code change to a file the self-edit
// refuse-list already covers. And once a key IS unwritable, the DAO, the route
// and the vote path all refuse to store it, so "block the merge until someone
// sets a value" is demanding something structurally impossible: the value can
// only ever come from the deploy. A genuinely console-settable required
// variable — one named in neither list — still blocks exactly as before.
//
// Union, never replace: a branch cannot shrink the running platform's reserved
// set to make a credential writable.
// ---------------------------------------------------------------------------

const MANIFEST_MODULE_PATH = 'src/services/app-manifest.js';

// Env-var-shaped tokens only. Anything else in the literal is not a key we
// would honour, so dropping it is both safe and a parse-sanity signal.
const KEY_TOKEN_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

// Smallest plausible size for a correctly-parsed reserved set. The real lists
// are far larger; a handful of matches means the regex found the wrong thing,
// and we would rather fall back to the running list (i.e. keep blocking) than
// act on a garbage parse.
const MIN_PLAUSIBLE_TOKENS = 4;

/**
 * Pull the string literals out of one `const <id> = new Set([...])` or
 * `const <id> = [...]` declaration in module source, WITHOUT executing it.
 *
 * Deliberately a static text scan: this source comes from a branch that has
 * not been reviewed or merged, so it must never be require()'d, eval'd or
 * vm-run. Comments are stripped before extracting quotes because the real
 * declarations carry prose that contains apostrophes.
 *
 * Returns null when the declaration isn't found or doesn't parse — callers
 * treat null as "no overlay", which preserves today's behaviour.
 */
function stringLiteralsIn(raw, identifier) {
  const decl = new RegExp(`${identifier}\\s*=\\s*(?:new\\s+Set\\s*\\()?\\s*\\[`).exec(raw);
  if (!decl) return null;

  // Walk from the opening bracket to its balanced close so a nested array
  // (there are none today, but be exact rather than lucky) can't truncate us.
  const open = raw.indexOf('[', decl.index);
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < raw.length; i += 1) {
    if (raw[i] === '[') depth += 1;
    else if (raw[i] === ']') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) return null;

  const body = raw.slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/[^\n]*/g, '');        // line comments (and their apostrophes)

  const out = [];
  for (const m of body.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)) {
    const tok = m[1] ?? m[2];
    if (KEY_TOKEN_RE.test(tok)) out.push(tok);
  }
  return out.length ? out : null;
}

/**
 * The branch's own view of "which platform variables are deploy-owned".
 * Returns null when nothing usable could be read, meaning "no overlay".
 */
function unwritableOverlayFromSource(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const unwritable = stringLiteralsIn(raw, 'PLATFORM_ENV_UNWRITABLE');
  const reserved = stringLiteralsIn(raw, 'RESERVED_KEYS');
  const prefixes = stringLiteralsIn(raw, 'RESERVED_KEY_PREFIXES');
  const keys = [...(unwritable || []), ...(reserved || [])];
  // Both key lists missing, or implausibly short — assume the parse failed.
  if (keys.length < MIN_PLAUSIBLE_TOKENS) return null;
  return { keys: new Set(keys), prefixes: prefixes || [] };
}

/** Is `key` deploy-owned according to the running platform OR the branch? */
function isUnwritableWithOverlay(entry, overlay) {
  if (entry.unwritable) return true;               // running platform says so
  if (!overlay) return false;
  if (overlay.keys.has(entry.key)) return true;    // the branch says so
  return overlay.prefixes.some((p) => entry.key.startsWith(p));
}

// Imported PRs and native CLI handoffs are identified by immutable commits;
// ordinary native proposals remain branch-addressed. A local checkout can
// push its managed branch while an older capture is still finishing, so using
// that mutable branch here would stamp the platform-env verdict from different
// code than the staging/check revision.
function headRefForSession(session) {
  if (session?.source === 'imported') {
    return session.imported_pr_head_sha || session.branch_name || null;
  }
  if (session?.source === 'cli_handoff') {
    return session.checks_commit_sha || session.handoff_head_sha || null;
  }
  return session?.branch_name || null;
}

const SKIP = (reason) => ({
  state: 'skipped',
  detail: { missing: [], added: [], removed: [], pendingValues: [], reason },
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
 * removed:[key], pendingValues:[key], reason } so the UI and the block
 * message have one shape to read regardless of outcome. `pendingValues`
 * are keys whose value this proposal itself carries (see
 * services/pending-secrets.js) and are therefore NOT counted as missing.
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
      detail: { missing: [], added: [], removed: [], pendingValues: [], reason: 'This proposal does not change dapp.json.' },
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
        missing: [], added: [], removed, pendingValues: [],
        reason: removed.length
          ? `This proposal removes ${removed.length} platform variable${removed.length === 1 ? '' : 's'} and adds none.`
          : 'This proposal adds no platform variables.',
      },
    };
  }

  // Honour the BRANCH's reserved-key list, not just the running platform's.
  // A proposal that declares a deploy-owned variable adds the platform_env
  // entry and names the key in PLATFORM_ENV_UNWRITABLE in the same commit;
  // scoring it against the deployed list alone made such a proposal block
  // itself (see unwritableOverlayFromSource above). Only fetched when this
  // branch actually touches the module, or when the compare's file list was
  // capped and therefore proves nothing — otherwise the running list already
  // is the branch's list and an extra API call would buy nothing.
  let overlay = null;
  if (!filesComplete || (files || []).includes(MANIFEST_MODULE_PATH)) {
    try {
      overlay = unwritableOverlayFromSource(
        await github.getFileContent(owner, repo, MANIFEST_MODULE_PATH, headRef)
      );
    } catch (err) {
      // Non-fatal and fail-CLOSED: without the overlay we fall back to the
      // running list, which can only over-block, never under-block.
      log.warn('platform-env-check', 'Reserved-list fetch failed; using the deployed list', {
        sessionId: session?.id, err: err.message,
      });
    }
  }

  // Which of the added variables already have a value? Only the ones a
  // human could actually set matter — an added `unwritable` declaration
  // is documentation of a GitHub secret, not something to block on.
  const candidates = added.filter(
    (e) => e.required && !isUnwritableWithOverlay(e, overlay)
  );
  let stored = new Set();
  // A value can also arrive WITH the proposal: the panel's "+ New
  // variable" flow parks it in pending_secret_declarations bound to this
  // very session, and routes/votes.js finalizeMerge() writes it the moment
  // the PR merges (services/pending-secrets.js). Counting those is what
  // stops such a proposal from blocking ITSELF — the declaration is in the
  // branch, the value just isn't in platform_env_values yet. Scoped to
  // THIS session on purpose: another proposal's held value proves nothing
  // about this merge, since it might never land.
  const pendingValues = new Set();
  if (candidates.length) {
    try {
      // eslint-disable-next-line global-require
      const pendingSecrets = require('./pending-secrets');
      const wanted = new Set(candidates.map((e) => e.key));
      for (const p of await pendingSecrets.keysForSession(pool, session.id)) {
        if (p.scope === 'platform' && p.hasValue && wanted.has(p.key)) pendingValues.add(p.key);
      }
    } catch (err) {
      // Non-fatal: worst case the gate blocks a proposal whose value is in
      // flight, and the operator sees the existing "set it and vote again"
      // message. Never fail the check over this lookup.
      log.warn('platform-env-check', 'Pending-declaration lookup failed', {
        sessionId: session?.id, err: err.message,
      });
    }
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
          missing: [], added: added.map((e) => e.key), removed, pendingValues: [],
          reason: 'Could not read the stored platform variables.',
        },
      };
    }
  }

  const missing = candidates
    .filter((e) => !stored.has(e.key) && !pendingValues.has(e.key))
    .map((e) => ({ key: e.key, required: true, description: e.description || '' }));

  const carried = [...pendingValues];
  return {
    state: missing.length ? 'failing' : 'passing',
    detail: {
      missing,
      added: added.map((e) => e.key),
      removed,
      // Keys whose value is carried by THIS proposal and applied on merge.
      // The Checks card names them so a voter knows the value is part of
      // what they're approving.
      pendingValues: carried,
      reason: missing.length
        ? `This proposal adds ${missing.length} required platform variable${missing.length === 1 ? '' : 's'} that ${missing.length === 1 ? 'has' : 'have'} no value set.`
        : carried.length
          ? `This proposal adds ${added.length} platform variable${added.length === 1 ? '' : 's'} and carries ${carried.length === 1 ? 'its value' : 'their values'}, applied when it merges.`
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
async function storePlatformEnvCheck(pool, sessionId, result, expectedCommitSha = null) {
  try {
    const commitGuard = expectedCommitSha
      ? ` AND status IN ('active', 'paused', 'promoted', 'merging')
          AND checks_commit_sha IS NOT DISTINCT FROM $4::text`
      : '';
    const write = await pool.query(
      `UPDATE chat_sessions
          SET platform_env_state = $2,
              platform_env_detail = $3::jsonb
        WHERE id = $1${commitGuard}`,
      [sessionId, result.state, JSON.stringify(result.detail || {}),
        ...(expectedCommitSha ? [expectedCommitSha] : [])]
    );
    return write.rowCount !== 0;
  } catch (err) {
    log.warn('platform-env-check', 'Verdict stamp failed', { sessionId, err: err.message });
    return false;
  }
}

/** Resolve + persist in one call, swallowing everything. */
async function refreshPlatformEnvCheck({ pool, app, session }) {
  try {
    const result = await resolvePlatformEnvCheck({ pool, app, session });
    const expectedCommitSha = session?.source === 'cli_handoff'
      ? (session.checks_commit_sha || session.handoff_head_sha || null)
      : null;
    const stored = await storePlatformEnvCheck(pool, session.id, result, expectedCommitSha);
    if (!stored) return null;
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
  MANIFEST_MODULE_PATH,
  stringLiteralsIn,
  unwritableOverlayFromSource,
  isUnwritableWithOverlay,
};
