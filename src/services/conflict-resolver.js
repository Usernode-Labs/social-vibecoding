const log = require('./logger');
const github = require('./github');
const llm = require('./llm');
const docker = require('./docker');
const stagingService = require('./staging');
const { getPool } = require('../db/pool');

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
    await resolveIfConflicted(config, pool, session);
  }
}

async function resolveIfConflicted(config, pool, session) {
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

    const result = await llm.streamChat({
      messages: [{ role: 'user', content: 'Please resolve the merge conflicts in this PR.' }],
      systemPrompt,
      model: 'claude-sonnet-4-20250514',
    });

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
