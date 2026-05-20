const log = require('./logger');
const github = require('./github');
const llm = require('./llm');
const docker = require('./docker');
const stagingService = require('./staging');
const limits = require('./limits');
const { getPool } = require('../db/pool');

const CONFLICT_RESOLVER_MODEL = 'claude-sonnet-4-20250514';

async function checkAndResolveConflicts(config, mergedSession) {
  const pool = getPool(config);

  // Find other promoted sessions for the same app that might now conflict
  const { rows: conflictCandidates } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.repo_url, a.name as app_name
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.id != $2`,
    [mergedSession.app_id, mergedSession.id]
  );

  if (!conflictCandidates.length) return;

  for (const session of conflictCandidates) {
    await resolveIfConflicted(config, pool, session, mergedSession);
  }
}

async function resolveIfConflicted(config, pool, session, mergedSession) {
  if (!github.isEnabled() || !session.repo_url) return;

  const [, owner, repo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!owner || !repo) return;

  try {
    const octokit = await github.getInstallationOctokit(owner);
    const { data: pr } = await octokit.rest.pulls.get({
      owner, repo, pull_number: session.pr_number,
    });

    if (pr.mergeable === true || pr.mergeable === null) {
      return; // No conflict or GitHub hasn't computed yet
    }

    log.info('conflict', 'Conflict detected, attempting resolution', {
      sessionId: session.id, pr: session.pr_number,
    });

    // Get the conflicting diff
    const { data: diff } = await octokit.rest.pulls.get({
      owner, repo, pull_number: session.pr_number,
      mediaType: { format: 'diff' },
    });

    // Get main branch files for context
    const { data: mainTree } = await octokit.rest.git.getTree({
      owner, repo, tree_sha: 'main', recursive: 'true',
    });

    const mainFiles = [];
    for (const file of mainTree.tree.filter((f) => f.type === 'blob' && f.size < 50000).slice(0, 15)) {
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path: file.path, ref: 'main' });
        if (data.encoding === 'base64') {
          mainFiles.push(`--- ${file.path} ---\n${Buffer.from(data.content, 'base64').toString('utf8')}`);
        }
      } catch {}
    }

    // Get branch files
    const { data: branchTree } = await octokit.rest.git.getTree({
      owner, repo, tree_sha: session.branch_name, recursive: 'true',
    });

    const branchFiles = [];
    for (const file of branchTree.tree.filter((f) => f.type === 'blob' && f.size < 50000).slice(0, 15)) {
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path: file.path, ref: session.branch_name });
        if (data.encoding === 'base64') {
          branchFiles.push(`--- ${file.path} ---\n${Buffer.from(data.content, 'base64').toString('utf8')}`);
        }
      } catch {}
    }

    // Ask Claude to resolve
    const systemPrompt = `You are resolving a git merge conflict. The PR branch needs to be updated to merge cleanly with main.

Current main branch files:
${mainFiles.join('\n\n')}

Current PR branch files:
${branchFiles.join('\n\n')}

The PR diff:
${typeof diff === 'string' ? diff.substring(0, 10000) : ''}

Output the resolved files that need to change on the PR branch to merge cleanly with main. Use the format:
\`\`\`filepath:path/to/file.js
// complete resolved file contents
\`\`\`

Only fix the conflict — do NOT change behavior or add features. Keep the intent of both the main branch changes and the PR branch changes.`;

    if (!llm.isEnabled()) {
      log.warn('conflict', 'LLM not available for conflict resolution');
      return;
    }

    // Charge the conflict-resolver Sonnet call to the user who just
    // merged the PR that caused the conflict. The merging user is the
    // one who triggered this work, so it's their daily cap that gates
    // it. If they're already over their cap, skip the auto-resolution
    // and tell the affected session's group chat — the conflicting PR
    // owner can then either merge main themselves or wait for the cap
    // to reset.
    const budgetCheck = await limits.checkBudget(pool, mergedSession.user_id);
    if (budgetCheck.error) {
      log.info('conflict', 'Skipped — merging user over daily cap', {
        sessionId: session.id, mergedBy: mergedSession.user_id, reason: budgetCheck.error,
      });
      try {
        const { sendSystemMessage } = require('./ws');
        await sendSystemMessage(pool, session.app_id,
          `Auto-conflict-resolution skipped on PR #${session.pr_number}: the merging user has hit their daily LLM limit. Resolve manually or rebase against main.`,
          'conflict'
        );
      } catch (err) {
        log.warn('conflict', 'Failed to post skip notice to group chat', { err: err.message });
      }
      return;
    }

    const result = await llm.streamChat({
      messages: [{ role: 'user', content: 'Please resolve the merge conflicts in this PR.' }],
      systemPrompt,
      model: CONFLICT_RESOLVER_MODEL,
    });

    // Debit the merging user for the resolver's token spend. We do this
    // even when extraction fails below — the API call still happened
    // and the platform paid for it.
    if (result?.usage) {
      const costCents = llm.estimateCostCents(result.usage, CONFLICT_RESOLVER_MODEL);
      await pool.query(
        `INSERT INTO llm_usage (user_id, date, total_cost_cents) VALUES ($1, CURRENT_DATE, $2)
         ON CONFLICT (user_id, date) DO UPDATE SET total_cost_cents = llm_usage.total_cost_cents + EXCLUDED.total_cost_cents`,
        [mergedSession.user_id, costCents]
      );
    }

    // Extract file changes from the response
    const fileRegex = /```filepath:([\w/.]+)\n([\s\S]*?)```/g;
    const files = [];
    let match;
    while ((match = fileRegex.exec(result.text)) !== null) {
      files.push({ path: match[1], content: match[2] });
    }

    if (files.length === 0) {
      log.warn('conflict', 'No files extracted from conflict resolution response');
      return;
    }

    // Push resolved files to the PR branch
    await github.pushFiles(owner, repo, files, {
      branch: session.branch_name,
      message: 'Auto-resolve merge conflicts',
    });

    // Rebuild staging
    const { rows: appRows } = await pool.query('SELECT * FROM apps WHERE id = $1', [session.app_id]);
    if (appRows[0]) {
      const latestRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${session.branch_name}` });
      const commitHash = latestRef.data.object.sha;

      const stagingResult = await stagingService.buildAndDeployStaging(config, session, appRows[0], commitHash);

      await pool.query(
        `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
        [stagingResult.containerId, stagingResult.stagingUrl, session.id]
      );
    }

    log.info('conflict', 'Conflict resolved and staging rebuilt', { sessionId: session.id });
  } catch (err) {
    log.error('conflict', 'Conflict resolution failed', { sessionId: session.id, err: err.message });
  }
}

module.exports = { checkAndResolveConflicts };
