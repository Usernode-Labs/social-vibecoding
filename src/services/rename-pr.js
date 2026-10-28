'use strict';

/**
 * Manifest-editing PR creation — PRs that change a single dapp.json
 * field and drop straight into the vote panel as a `promoted`
 * chat_sessions row with full promote-path parity (promoted_at,
 * pr_promoted analytics event, pr_proposed voter-nudge notifications,
 * group-chat vote message).
 *
 * The flavors share the createManifestPR core so they can never drift:
 *   - rename PRs (top-level `name`) — used by the interactive route
 *     (POST /api/apps/:slug/rename in routes/apps.js);
 *   - visibility PRs (top-level `visibility` block, issue #124) — used
 *     by POST /api/apps/:slug/visibility-pr in routes/apps.js. The
 *     change applies when the merged PR's production rebuild runs
 *     appManifest.reconcileAppVisibility;
 *   - governance PRs (top-level `governance` block, issue #646) — used
 *     by POST /api/apps/:slug/governance-pr; applied by
 *     reconcileAppGovernance (or seedSelfApp for the self-app);
 *   - admins PRs (top-level `admins` array, issue #788) — used by
 *     POST /api/apps/:slug/admins-pr; applied by reconcileAppAdmins;
 *   - secret-declaration PRs (one `secrets` / `platform_env` entry) —
 *     used by POST /api/apps/:slug/secret-declaration-pr.
 *
 * Every flavor but rename carries explicitApproval: true with its reason
 * (services/explicit-approval.js), so the resulting proposal never merges
 * on a timer, needs a Yes from a member other than its author whenever
 * the community has more than one, and can't be force-merged by an app
 * admin (services/governance.js, services/app-admins.js).
 */

const log = require('./logger');
const github = require('./github');
const appManifest = require('./app-manifest');
const events = require('./events');
const topicAttrs = require('./topic-attributes');
const explicitApprovalReasons = require('./explicit-approval');
const repoRef = require('./repo-ref');
const durableSteps = require('./durable-steps');

function renamePrTitle(newName) {
  return `Rename to "${newName}"`;
}

/**
 * Shared core: open a PR that edits dapp.json via `opts.mutate` and drop
 * it into the vote panel as a `promoted` session. The caller owns
 * user-facing validation and dedupe; this helper assumes it's been
 * cleared to proceed.
 *
 * `actor` is `{ id, username }` — the user attributed as the proposer.
 * `id` may be null (e.g. a deleted issue author).
 *
 * `opts`:
 *   - mutate(manifestObj)  — applies the field change in place;
 *   - branchPrefix         — 'rename' | 'visibility';
 *   - commitMessage, prTitle, prBody;
 *   - chatText(prData, majority, activeUsers) — group-chat vote message;
 *   - eventMetadata        — extra pr_promoted metadata (prNumber is
 *                            added automatically);
 *   - explicitApproval     — true when the mutation touches a
 *                            protected block (#788: admins, governance,
 *                            visibility, platform_env, secrets), which
 *                            switches off the time-based merge paths for
 *                            the resulting proposal and adds the member
 *                            floor. Defaults to false.
 *   - explicitApprovalReason — which block, one of
 *                            services/explicit-approval.js REASONS. Stored
 *                            in explicit_approval_reason; required with
 *                            explicitApproval.
 *
 * Throws on GitHub / DB failure so callers can map it to an HTTP error
 * or skip-and-continue. On success returns
 * `{ sessionId, prNumber, prUrl, branch }`.
 *
 * Runs on a conductor, as the platform-operation machine's
 * `manifest.propose` (services/manifest-proposal-operation.js), which hands
 * its `steps`: each write is kept as a step, so a retry or a restart
 * carries on from the last one instead of opening a second branch or PR.
 * Without steps (tests) every step simply runs.
 */
async function createManifestPR(config, pool, app, actor, opts) {
  const steps = opts.steps || durableSteps.none();
  const { owner, repo } = repoRef.ownerRepo(app.repo_url) || {};
  if (!owner || !repo) throw new Error('Could not parse the app repository URL');

  // Branch naming pattern: <prefix>/<slug>-<timestamp>. The timestamp
  // suffix avoids collisions if a prior attempt left a stale branch on the
  // remote. Kept, so a retry of this request reuses its own branch.
  const branch = await steps.once('branch-name', () => `${opts.branchPrefix}/${app.slug}-${Date.now()}`);
  // Build the updated dapp.json. Preserve existing fields when the file
  // is present + parseable; create a minimal manifest when it's missing
  // (legacy apps predating the manifest). A malformed file is already
  // treated as empty by the deploy reader, so falling back to a fresh
  // object there is safe. Built again on a retry (a pure change of what main
  // holds), never kept: the platform's own manifest is hundreds of KB.
  let manifestObj = { secrets: [] };
  const existing = await github.getFileContent(owner, repo, appManifest.MANIFEST_FILENAME, 'main');
  if (existing != null) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifestObj = parsed;
    } catch {
      log.warn('rename-pr', 'Existing dapp.json unparseable; writing fresh manifest', { slug: app.slug });
    }
  }
  opts.mutate(manifestObj);
  const updatedContent = `${JSON.stringify(manifestObj, null, 2)}\n`;
  // Each write tolerates its own earlier, unconfirmed try: the branch
  // already there (its name is this request's own), the file already
  // holding the change, the PR already open from the branch.
  await steps.once('branch', async () => {
    try {
      await github.createBranch(owner, repo, branch);
    } catch (err) {
      if (!steps.active || !(await github.getBranchSha(owner, repo, branch).catch(() => null))) throw err;
    }
    return true;
  });
  await steps.once('pushed', async () => {
    const onBranch = steps.active
      ? await github.getFileContent(owner, repo, appManifest.MANIFEST_FILENAME, branch).catch(() => null) : null;
    if (onBranch === updatedContent) return true;
    await github.pushFiles(
      owner, repo,
      [{ path: appManifest.MANIFEST_FILENAME, content: updatedContent }],
      { branch, message: opts.commitMessage }
    );
    return true;
  });

  const prTitle = opts.prTitle;
  // safeMention is applied inside github.createPR; the actor.username
  // and names flow into the body verbatim here.
  const prData = await steps.once('pr', async () => {
    const open = steps.active ? await github.findOpenPrByBranch(owner, repo, branch).catch(() => null) : null;
    const pr = open || await github.createPR(owner, repo, { branch, title: prTitle, body: opts.prBody });
    return { number: pr.number, html_url: pr.html_url };
  });

  // Drop the rename PR straight into the vote panel as a promoted
  // session, mirroring the normal promote path (POST
  // /api/sessions/:id/promote in routes/votes.js): set promoted_at
  // (anchors the stale-PR sweeper), emit pr_promoted, fan out
  // pr_proposed notifications.
  // #5379: a manifest PR is a settings proposal, not agent work — no agent
  // chat backs it, so stamp `source = 'settings'` to keep it out of the
  // agent-session lists (Messages › Agents, the bell's Agents tab, the
  // Improve panel). It still goes to the vote and the project's board like
  // every other proposal; the session-caps counting treats it as NULL does.
  // (JS comment, not `--` in the SQL: scripts/check-sql.js flattens queries
  // to one line and a line comment would eat the statement.)
  // A session an earlier, unconfirmed try inserted for this very PR is that
  // try's: found by its branch and number rather than inserted again.
  const sessionId = await steps.once('session', async () => {
    const { rows: [found] } = await pool.query(
      `SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 AND pr_number = $3 AND source = 'settings'`,
      [app.id, branch, prData.number]
    );
    if (found) return found.id;
    const { rows: sessRows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status, promoted_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'promoted', NOW(), 'settings')
       RETURNING id`,
      [app.id, actor.id || null, branch, prData.number, prData.html_url, prTitle]
    );
    return sessRows[0].id;
  });
  // (Born in review: its insert enrolled it in the proposal machine,
  // schema.sql wf_enrol_proposal.)
  // Legacy rename-issue migration can only attribute very old rows to the
  // fallback label "Homeroom" (no user id). Interactive proposal issuers have
  // a real identity and receive the normal proposal-level assignment.
  if (actor.id) {
    await topicAttrs.selfAssignProposal(pool, app.id, sessionId, actor);
  }

  // #788: stamp the explicit-approval flag directly. We KNOW what this
  // PR mutates (opts.explicitApproval and its reason are set by the
  // caller that built the mutation), so there's no need to round-trip
  // GitHub to diff a file we just wrote — and stamping at creation is
  // what makes the highest-risk paths (a platform-opened admins,
  // visibility, governance or secret PR) correct even if GitHub is
  // unreachable at merge time.
  await pool.query(
    `UPDATE chat_sessions
        SET requires_explicit_approval = $2, explicit_approval_reason = $3
      WHERE id = $1`,
    [
      sessionId,
      !!opts.explicitApproval,
      opts.explicitApproval && explicitApprovalReasons.isReason(opts.explicitApprovalReason)
        ? opts.explicitApprovalReason : null,
    ]
  ).catch((err) => log.warn('rename-pr', 'Explicit-approval stamp failed', {
    sessionId, err: err.message,
  }));

  // Announced once: a retry after this point does not post the vote twice.
  if (steps.has('announced')) {
    return { sessionId, prNumber: prData.number, prUrl: prData.html_url, branch };
  }
  const { sendSystemMessage, pushVoteUpdate, pushNotificationToUser } = require('./ws');
  const notifications = require('./notifications');
  const { getActiveUserStats } = require('./active-users');
  const { active: activeUsers, majority } = await getActiveUserStats(pool, app.id);

  await sendSystemMessage(pool, app.id,
    opts.chatText(prData, majority, activeUsers),
    'vote',
    { vote: { sessionId, prNumber: prData.number } },
    { type: 'session', ref: sessionId }
  ).catch((err) => log.warn('rename-pr', 'Manifest-PR chat msg failed', { err: err.message }));

  pushVoteUpdate({ sessionId, appSlug: app.slug, merged: false });

  // pr_promoted is the funnel stage the PR-promotion analytics read;
  // emit it so manifest PRs count like every other promoted PR.
  events.record(pool, {
    type: events.EVENT_TYPES.PR_PROMOTED,
    userId: actor.id || null,
    appId: app.id,
    sessionId,
    metadata: { prNumber: prData.number, ...(opts.eventMetadata || {}) },
  });

  // Vote-request fan-out — same as the normal promote path. Non-fatal:
  // the rename PR is already open, so a notification hiccup must not
  // poison the result.
  try {
    const notifRows = await notifications.createPrProposedNotifications(pool, {
      appId: app.id,
      sessionId,
      proposerId: actor.id || null,
    });
    for (const row of notifRows) {
      pushNotificationToUser(row.user_id, {
        type: 'notification_new',
        notification: notifications.serialize({
          ...row,
          app_slug: app.slug,
          app_name: app.name,
          pr_title: prTitle,
          pr_number: prData.number,
          source_username: actor.username,
        }),
      });
    }
    if (notifRows.length) {
      log.info('rename-pr', 'Manifest-PR pr_proposed notifications sent', {
        sessionId, count: notifRows.length,
      });
    }
  } catch (err) {
    log.warn('rename-pr', 'Manifest-PR pr_proposed notify failed', { sessionId, err: err.message });
  }

  await steps.set('announced', true);
  log.info('rename-pr', 'Manifest PR opened', {
    slug: app.slug, prNumber: prData.number, title: prTitle, by: actor.username,
  });

  return { sessionId, prNumber: prData.number, prUrl: prData.html_url, branch };
}

/**
 * Open a rename PR for `app` targeting `newName` — a manifest PR that
 * sets dapp.json's top-level `name`. Caller owns validation (length,
 * name-differs, GitHub-enabled) and dedupe.
 */
async function createRenamePR(config, pool, app, newName, actor, { steps } = {}) {
  return createManifestPR(config, pool, app, actor, {
    steps,
    mutate: (m) => { m.name = newName; },
    branchPrefix: 'rename',
    commitMessage: `Rename to "${newName}"`,
    prTitle: renamePrTitle(newName),
    prBody:
      `${actor.username} (via Homeroom) proposed renaming "${app.name}" to "${newName}".\n\n` +
      `This PR updates the \`name\` field in \`dapp.json\`. It still needs a regular ` +
      `merge vote to land. Vote in the app's group chat panel. The new name applies ` +
      `automatically once the PR merges and the app redeploys.`,
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed renaming to "${newName}". Opened PR #${prData.number}, which needs ${majority}/${activeUsers} votes to land.`,
    eventMetadata: { rename: true },
  });
}

function visibilityPrTitle(collab, view) {
  return `Make this app ${appManifest.describeVisibility(collab, view)}`;
}

/**
 * Open a visibility-change PR for `app` (issue #124) — a manifest PR
 * that sets dapp.json's top-level `visibility` block to
 * `{ build: collab, view }`. Caller owns validation (combo invariant,
 * differs-from-current, creator/admin gate, GitHub-enabled) and dedupe
 * (findVisibilityPr below). The change applies when the merged PR's
 * production rebuild runs reconcileAppVisibility.
 */
async function createVisibilityPR(config, pool, app, { collab, view }, actor, { steps } = {}) {
  const desc = appManifest.describeVisibility(collab, view);
  return createManifestPR(config, pool, app, actor, {
    steps,
    mutate: (m) => { m.visibility = { build: collab, view }; },
    branchPrefix: 'visibility',
    commitMessage: visibilityPrTitle(collab, view),
    prTitle: visibilityPrTitle(collab, view),
    prBody:
      `${actor.username} (via Homeroom) proposed changing "${app.name}" to be ${desc}.\n\n` +
      `This PR updates the \`visibility\` block in \`dapp.json\` (\`build\` = who can ` +
      `build the app, \`view\` = who can see & use it). It still needs a regular merge ` +
      `vote to land. Vote in the app's group chat panel. The new visibility applies ` +
      `automatically once the PR merges and the app redeploys.`,
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed making this app ${desc}. Opened PR #${prData.number}, which needs ${majority}/${activeUsers} votes to land.`,
    eventMetadata: { visibility: true },
    // Who can see the app is the community's to decide: no timer, and a
    // Yes from another member.
    explicitApproval: true,
    explicitApprovalReason: 'visibility',
  });
}

function governancePrTitle(policy, approvalsRequired) {
  return `Change proposal approvals: ${appManifest.describeGovernance(policy, approvalsRequired)}`;
}

/**
 * Open a governance-change PR for `app` (issue #646) — a manifest PR
 * that sets dapp.json's top-level `governance` block to
 * `{ approvers: policy, approvals: 'default' | { atLeast: N } }`.
 * Caller owns validation (value set, differs-from-current,
 * creator/admin gate, GitHub-enabled) and dedupe (findGovernancePr
 * below). The change applies when the merged PR's production rebuild
 * runs reconcileAppGovernance — or, for the self-hosted platform app,
 * on the post-deploy boot's seedSelfApp reconcile.
 */
async function createGovernancePR(config, pool, app, { policy, approvalsRequired }, actor, { steps } = {}) {
  const desc = appManifest.describeGovernance(policy, approvalsRequired);
  return createManifestPR(config, pool, app, actor, {
    steps,
    mutate: (m) => {
      m.governance = {
        approvers: policy,
        approvals: approvalsRequired != null ? { atLeast: approvalsRequired } : 'default',
      };
    },
    branchPrefix: 'governance',
    commitMessage: governancePrTitle(policy, approvalsRequired),
    prTitle: governancePrTitle(policy, approvalsRequired),
    prBody:
      `${actor.username} (via Homeroom) proposed changing "${app.name}"'s proposal-approval ` +
      `settings to ${desc}.\n\n` +
      `This PR updates the \`governance\` block in \`dapp.json\` (\`approvers\` = who can ` +
      `approve proposals, \`approvals\` = how many approvals are needed). It still needs a ` +
      `regular merge vote to land. Vote in the app's group chat panel. The new settings ` +
      `apply automatically once the PR merges and the app redeploys.`,
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed changing proposal approvals to ${desc}. Opened PR #${prData.number}, which needs ${majority}/${activeUsers} votes to land.`,
    eventMetadata: { governance: true },
    // How changes are approved decides every later vote: no timer, and a
    // Yes from another member.
    explicitApproval: true,
    explicitApprovalReason: 'governance',
  });
}

function adminsPrTitle(usernames) {
  return `Change app admins: ${appManifest.describeAdmins(usernames)}`;
}

/**
 * Open an app-admins change PR for `app` (issue #788) — a manifest PR
 * that sets dapp.json's top-level `admins` array to `usernames`
 * (display-cased, deduped; an empty array is how the roster is
 * cleared). Caller owns validation (entry shape, cap, normalized
 * differs-from-current, creator/app-admin gate, NOT self-hosted,
 * GitHub-enabled) and dedupe (findAdminsPr below). The change applies
 * when the merged PR's production rebuild runs reconcileAppAdmins.
 *
 * Passes explicitApproval: true — the resulting proposal grants
 * app-level power, so the time-based merge paths are off, it needs a Yes
 * from another member, and only a platform admin can force-merge it
 * (services/governance.js applyNoTimerMerge + services/app-admins.js
 * canForceMerge).
 */
async function createAdminsPR(config, pool, app, { usernames }, actor, { steps } = {}) {
  const desc = appManifest.describeAdmins(usernames);
  return createManifestPR(config, pool, app, actor, {
    steps,
    mutate: (m) => { m.admins = usernames; },
    branchPrefix: 'admins',
    commitMessage: adminsPrTitle(usernames),
    prTitle: adminsPrTitle(usernames),
    prBody:
      `${actor.username} (via Homeroom) proposed changing "${app.name}"'s app admins ` +
      `to ${desc}.\n\n` +
      `This PR updates the \`admins\` array in \`dapp.json\`: the platform users who can ` +
      `administer this app (creator-level settings plus force-merging its proposals). ` +
      `Because it grants app-level power, the time-based merge paths are switched off for ` +
      `this proposal: it merges only when the app's normal vote threshold is met by Yes ` +
      `votes people actually cast (one of them from a member other than the proposer, ` +
      `when the community has more than one), and only a platform admin (never an app ` +
      `admin) can force-merge it. The new roster applies automatically once the PR ` +
      `merges and the app redeploys.`,
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed changing this app's admins to ${desc}. Opened PR ` +
      `#${prData.number}: it needs real Yes votes (${majority}/${activeUsers}) and won't ` +
      `merge on a timer.`,
    eventMetadata: { admins: true },
    explicitApproval: true,
    explicitApprovalReason: 'admins',
  });
}

function secretDeclarationPrTitle(scope, key) {
  return scope === 'platform'
    ? `Declare platform variable "${key}"`
    : `Declare app secret "${key}"`;
}

/**
 * Open a secret-DECLARATION PR — a manifest PR that appends one entry to
 * dapp.json's `secrets` array (a child app) or `platform_env` array (the
 * self-hosted platform).
 *
 * This is the manifest half of "add a brand-new variable from the App
 * secrets panel". The VALUE half rides on the same proposal via
 * services/pending-secrets.js (held encrypted until the merge) or, for a
 * full admin, was already written directly to the value store. The PR
 * body therefore says whether a value accompanies the proposal — but
 * NEVER the value itself, since a PR body is public repo content.
 *
 * `declaration` is a services/pending-secrets.normalizeDeclaration()
 * result: { description, required, private, default, staging_default,
 * group }. Only the fields meaningful for the scope are written —
 * `staging_default` is app-only (nothing in platform_env is injected into
 * a container, so a staging fallback would be meaningless) and `group` is
 * platform-only (the `secrets` reader has no group).
 *
 * Caller owns validation (key shape, reserved/unwritable keys, collision
 * against the manifest + value store + pending rows, field caps,
 * GitHub-enabled) and dedupe (findSecretDeclarationPr below).
 */
async function createSecretDeclarationPR(config, pool, app, { scope, key, declaration, hasValue }, actor, { steps } = {}) {
  const isPlatform = scope === 'platform';
  const decl = declaration || {};
  const title = secretDeclarationPrTitle(scope, key);

  // Field order matches how the manifest reader documents each block, so
  // a hand-written entry and a platform-written one look the same.
  const entry = isPlatform
    ? { key, group: decl.group || 'General' }
    : { key };
  if (decl.description) entry.description = decl.description;
  if (decl.required) entry.required = true;
  if (decl.private) entry.private = true;
  if (decl.default != null) entry.default = decl.default;
  if (!isPlatform && decl.staging_default != null) entry.staging_default = decl.staging_default;

  const flagBits = [
    decl.required ? '`required: true` (deploys block until it has a value)' : '`required: false`',
    decl.private ? '`private: true` (encrypted at rest, never returned by the API, not propagated into staging)' : '`private: false`',
  ];
  if (decl.default != null) {
    flagBits.push(isPlatform
      ? `\`default: "${decl.default}"\` (documentation of the committed fallback; the platform's deploy stays authoritative)`
      : `\`default: "${decl.default}"\` (used when no value is stored)`);
  }
  if (!isPlatform && decl.staging_default != null) {
    flagBits.push(`\`staging_default: "${decl.staging_default}"\` (what PR previews use)`);
  }

  const valueLine = hasValue
    ? 'A value for it is part of this proposal and is applied when this PR merges. '
      + 'The value itself is deliberately not in this PR: it is stored encrypted by the platform.'
    : 'No value accompanies this proposal: it declares the variable only.';

  return createManifestPR(config, pool, app, actor, {
    steps,
    mutate: (m) => {
      const field = isPlatform ? 'platform_env' : 'secrets';
      if (!Array.isArray(m[field])) m[field] = [];
      // Replace rather than duplicate if the key somehow already exists
      // on main (the route's collision check reads the manifest SNAPSHOT,
      // which lags a dev-session edit that merged but hasn't deployed).
      const at = m[field].findIndex((e) => e && e.key === key);
      if (at >= 0) m[field][at] = entry;
      else m[field].push(entry);
    },
    branchPrefix: 'secret-declare',
    commitMessage: title,
    prTitle: title,
    prBody:
      `${actor.username} (via Homeroom) proposed declaring ${isPlatform ? 'a new platform variable' : 'a new app secret'} `
      + `\`${key}\`${decl.description ? `: ${decl.description}` : ''}.\n\n`
      + `This PR appends one entry to the \`${isPlatform ? 'platform_env' : 'secrets'}\` array in \`dapp.json\`:\n`
      + `${flagBits.map((b) => `- ${b}`).join('\n')}\n\n`
      + `${valueLine}\n\n`
      + `It still needs a regular merge vote to land. Vote in the app's group chat panel. `
      + (isPlatform
        ? 'Once merged, the declaration is picked up on the platform\'s next deploy, which is also when the value reaches the platform process.'
        : 'Once merged, the value is stored and the app redeploys with the new variable in its environment.'),
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed adding the ${isPlatform ? 'platform variable' : 'app secret'} ${key}`
      + `${hasValue ? ' (value included)' : ''}. Opened PR #${prData.number}, which needs ${majority}/${activeUsers} votes to land.`,
    eventMetadata: { secretDeclaration: true, scope, key },
    // A declaration can carry a value (held encrypted until the merge) and
    // decides what the app or the platform is handed: no timer, and a Yes
    // from another member, like every other change to those blocks.
    explicitApproval: true,
    explicitApprovalReason: isPlatform ? 'platform_env' : 'secrets',
  });
}

// Returns the open declaration PR session for one key, if any — the
// dedupe check for POST /api/apps/:slug/secret-declaration-pr. Scoped to
// the key (unlike visibility/governance/admins, which allow one proposal
// of their kind per app): two people declaring two different variables at
// once is perfectly reasonable.
async function findSecretDeclarationPr(pool, appId, scope, key) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'secret-declare/%'
        AND pr_title = $2
      ORDER BY id DESC
      LIMIT 1`,
    [appId, secretDeclarationPrTitle(scope, key)]
  );
  return rows[0] || null;
}

// Returns the open admins-change PR session for an app, if any — the
// dedupe check for POST /api/apps/:slug/admins-pr (one admins proposal
// in flight per app, like visibility/governance), and the
// `openProposal` pointer GET /api/apps/:slug/admins returns so the
// Members panel can show the "already up for vote" state.
async function findAdminsPr(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'admins/%'
      ORDER BY id DESC
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

// Returns the open governance-change PR session for an app, if any —
// the dedupe check for POST /api/apps/:slug/governance-pr (one
// governance proposal in flight per app, like visibility).
async function findGovernancePr(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'governance/%'
      ORDER BY id DESC
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

// Returns the open visibility-change PR session for an app, if any —
// the dedupe check for POST /api/apps/:slug/visibility-pr (only one
// visibility proposal is allowed in flight per app, unlike renames
// which dedupe per target name).
async function findVisibilityPr(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'visibility/%'
      ORDER BY id DESC
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

module.exports = {
  // The shared core, for the manifest-editing flavours that live in their
  // own module (#4417: services/topics-pr.js).
  createManifestPR,
  createRenamePR,
  createVisibilityPR,
  createGovernancePR,
  createAdminsPR,
  createSecretDeclarationPR,
  findSecretDeclarationPr,
  secretDeclarationPrTitle,
  findVisibilityPr,
  findGovernancePr,
  findAdminsPr,
};
