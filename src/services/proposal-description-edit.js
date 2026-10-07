'use strict';

const summaryFreshness = require('./summary-freshness');
const explainBlocks = require('./explain-blocks');
const proposalUpdate = require('./proposal-update');
const github = require('./github');
const { serializeHandoffSubmission } = require('./handoff-pipeline');

const MAX_DESCRIPTION_LENGTH = 16000;
const OPEN_STATUSES = ['active', 'paused', 'promoted', 'merging'];

function parseEdit(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['description', 'expectedVersion'].includes(key))) {
    throw new Error('Send description and expectedVersion only.');
  }
  if (typeof body.description !== 'string' || !body.description.trim()) {
    throw new Error('Description is required.');
  }
  if (body.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new Error('Read the current description and send its expectedVersion.');
  }
  // #4098: an `explain` fence is stored canonically; one that does not
  // validate stays the plain text the author typed, so they can fix it.
  return { description: explainBlocks.normalize(body.description.trim()), expectedVersion: body.expectedVersion };
}

async function readEditable(pool, sessionId, userId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1 AND cs.user_id = $2 AND cs.is_headless = FALSE
        AND cs.status IN ('active', 'paused', 'promoted', 'merging')`,
    [sessionId, userId]
  );
  return rows[0] || null;
}

function snapshot(session) {
  return {
    proposalId: Number(session.id),
    appSlug: session.app_slug,
    description: session.pr_summary_md || '',
    version: Number(session.pr_summary_input_version || 0),
    stale: session.pr_summary_stale === true,
    maxLength: MAX_DESCRIPTION_LENGTH,
  };
}

const conflict = () => ({
  status: 409,
  body: {
    error: 'description_changed',
    message: 'This change was updated while you were editing. Your draft is kept. Load the latest description before saving again.',
  },
});

// A metadata edit shares the revision writers' queue and advisory lock. The
// version predicate also rejects a summary generation or head invalidation
// that raced the read. Nothing here touches lifecycle, votes or checks.
async function edit({ pool, sessionId, userId, input, gh = github,
  serialize = serializeHandoffSubmission, lock = proposalUpdate.withProposalLock }) {
  return serialize(sessionId, () => lock(pool, sessionId, async () => {
    let session = await readEditable(pool, sessionId, userId);
    if (!session) return { status: 404, body: { error: 'Change not found or no longer editable.' } };
    const version = Number(session.pr_summary_input_version || 0);
    const unchanged = session.pr_summary_md === input.description
      && session.pr_summary_source === 'author' && session.pr_summary_stale === false;
    // A lost response may be retried with the version from before this exact
    // edit. This also retries GitHub synchronization without another write.
    if (version !== input.expectedVersion && !(unchanged && version === input.expectedVersion + 1)) return conflict();
    let changed = false;
    if (!unchanged) {
      const { rows } = await pool.query(
        `UPDATE chat_sessions
            SET pr_summary_previous_md = COALESCE(pr_summary_md, pr_summary_previous_md),
                pr_summary_md = $1,
                pr_summary_source = 'author',
                pr_summary_source_head_sha = CASE WHEN source = 'imported'
                  THEN imported_pr_head_sha
                  ELSE COALESCE(handoff_uploaded_sha, reviewed_head_sha, handoff_head_sha, checks_commit_sha) END,
                pr_summary_source_body_hash = $2,
                pr_summary_input_version = pr_summary_input_version + 1,
                pr_summary_applied_version = pr_summary_input_version + 1,
                pr_summary_stale = FALSE
          WHERE id = $3 AND user_id = $4 AND pr_summary_input_version = $5
            AND is_headless = FALSE
            AND status IN ('active', 'paused', 'promoted', 'merging')
          RETURNING *`,
        [input.description, summaryFreshness.bodyHash(session.pr_body), sessionId, userId, version]
      );
      if (!rows.length) return conflict();
      session = { ...session, ...rows[0] };
      changed = true;
    }
    let prBodyStatus = session.source === 'imported' ? 'imported_pr' : 'no_pull_request';
    if (session.source !== 'imported' && session.pr_number) {
      const repo = gh.parseGithubUrl(session.repo_url);
      const rejected = repo ? await proposalUpdate.syncSummaryIntoBody({
        pool, gh, ...repo, session, summary: input.description,
        previousSummary: session.pr_summary_previous_md,
      }) : 'github_unavailable';
      prBodyStatus = rejected || 'synced';
    }
    return {
      status: 200,
      body: { ...snapshot(session), changed, prBodyStatus, prBody: session.pr_body || null },
      session,
    };
  }));
}

module.exports = { MAX_DESCRIPTION_LENGTH, OPEN_STATUSES, parseEdit, readEditable, snapshot, edit };
