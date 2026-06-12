'use strict';

const log = require('./logger');
const llm = require('./llm');
const limits = require('./limits');
const github = require('./github');

// Coerce an arbitrary array of "issue numbers" into a clean, deduped,
// ascending list of positive integers (#75). Defensive against malformed
// input from the Mayor's tool call or stale DB rows: anything that isn't a
// positive integer (NaN, <= 0, floats, strings, null) is silently dropped.
// Number() (not parseInt) is used so "75abc"/"75.5" don't sneak through.
function sanitizeIssueNumbers(arr) {
  if (!Array.isArray(arr)) return [];
  const set = new Set();
  for (const v of arr) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isInteger(n) && n > 0) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// Build the GitHub closing-keyword block for a PR body: one `Closes #N`
// line per issue, already sanitized + sorted. Empty string when there are
// no linked issues, so the body is byte-identical to the legacy output.
function buildClosingBlock(issues) {
  return sanitizeIssueNumbers(issues).map((n) => `Closes #${n}`).join('\n');
}

// Build the deterministic "How to test" section for a PR body (#127) from
// the session's bot-emitted testing guidance (chat_sessions.testing_md /
// testing_path, parsed by services/testing-notes.js). Like the closing
// block, this is assembled in code and deliberately NOT fed into the LLM
// prompt, so the model can never drop or paraphrase it. Empty string when
// the session carries no guidance, keeping legacy bodies byte-identical.
function buildTestingBlock(testingMd, testingPath) {
  const md = typeof testingMd === 'string' ? testingMd.trim() : '';
  const path = typeof testingPath === 'string' ? testingPath.trim() : '';
  if (!md && !path) return '';
  const parts = ['## How to test'];
  if (md) parts.push(md);
  if (path) parts.push(`Deep link: \`${path}\``);
  return parts.join('\n\n');
}

// HTML-comment markers wrapping the deterministic "Before / after" visuals
// section (#195) so it can be idempotently replaced — both by the suffix
// assembly below (full-body regeneration on a dev turn) and by the targeted
// post-capture body patch in src/services/visuals.js.
const VISUALS_MARKER_START = '<!-- usernode:visuals -->';
const VISUALS_MARKER_END = '<!-- /usernode:visuals -->';

// Build the deterministic "Before / after" section for a PR body (#195)
// from the session's stored capture artifacts. `visuals` is the shape
// returned by visuals.getForSession: { before: {png,webm,gif}, after:
// {...} } of /visuals/:id tokens. Per side we embed the GIF when one was
// stored (GitHub camo proxies + autoplays GIFs inline), falling back to
// the PNG when the GIF was skipped or over-cap. webm is never referenced
// here — GitHub PR bodies can only inline-embed images; the webm exists
// for the in-app <video> surfaces. Empty string when there is nothing
// usable to show (no "after" artifact), keeping legacy bodies identical.
function buildVisualsBlock(visuals, domain) {
  if (!visuals || !domain) return '';
  const embed = (side) => {
    const v = visuals[side];
    if (!v) return null;
    const id = v.gif || v.png;
    return id ? `https://${domain}/visuals/${id}` : null;
  };
  const before = embed('before');
  const after = embed('after');
  if (!after) return '';
  const lines = [VISUALS_MARKER_START, '## Before / after', ''];
  if (before) {
    lines.push(
      '| Before | After |',
      '| --- | --- |',
      `| ![Before](${before}) | ![After](${after}) |`
    );
  } else {
    lines.push(
      '| After |',
      '| --- |',
      `| ![After](${after}) |`,
      '',
      '_No production version to compare — showing the staging preview only._'
    );
  }
  lines.push(VISUALS_MARKER_END);
  return lines.join('\n');
}

// Replace the marker-delimited visuals block inside an existing PR body,
// or append it when no markers are present yet. Used by the post-capture
// targeted patch (visuals.js) — the dev-turn path regenerates the whole
// body instead and includes the block via the suffix assembly.
function upsertVisualsBlock(body, block) {
  const base = typeof body === 'string' ? body : '';
  const start = base.indexOf(VISUALS_MARKER_START);
  const end = base.indexOf(VISUALS_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const head = base.slice(0, start).replace(/\n+$/, '');
    const tail = base.slice(end + VISUALS_MARKER_END.length).replace(/^\n+/, '');
    const parts = [head, block, tail].filter((p) => p && p.trim());
    return parts.join('\n\n');
  }
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

// Extract the issue numbers a PR body declares it closes via GitHub's
// closing keywords (close/closes/closed, fix/fixes/fixed, resolve/resolves/
// resolved), optionally followed by a colon, e.g. "Closes #75", "fixed: #80".
// Returns a sanitized (deduped, sorted, positive-int) list. Used by the
// migrate-time backfill to recover linked_issues for PRs whose bodies carry
// closing keywords but predate the #75 linkage plumbing. Cross-repo
// references ("owner/repo#12") are deliberately ignored — linked_issues only
// models same-repo issues, which is all the pill renders.
function parseClosingKeywords(body) {
  if (typeof body !== 'string' || !body) return [];
  const re = /(?<![A-Za-z0-9_/-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+#(\d+)\b/gi;
  const found = [];
  let m;
  while ((m = re.exec(body)) !== null) found.push(Number(m[1]));
  return sanitizeIssueNumbers(found);
}

// Order-independent equality for two sanitized issue-number lists.
function sameIssueSet(a, b) {
  const x = sanitizeIssueNumbers(a);
  const y = sanitizeIssueNumbers(b);
  return x.length === y.length && x.every((n, i) => n === y[i]);
}

// Generate a PR title + body from the user's latest message and
// Claude Code's own summary of what it built. Shared by:
//  - the normal dev-turn path in routes/sessions.js (SSE-backed)
//  - the orphan-recovery path in server.js (runs after a mid-flight
//    nodemon/server restart adopts an in-progress worker)
//
// Returns `{ title, body, usage?, model? }`. Never throws — falls back
// to the legacy template so PR creation is never blocked on LLM
// availability. `usage` is undefined when the fallback fires (no API
// call was made) so callers can skip debiting in that case.
async function generatePrMetadata({ userMessage, ccSummary, requests, summaries, specs, username, apiKey, closingBlock, testingBlock, visualsBlock }) {
  // `closingBlock` (#75) is the deterministic `Closes #N` text,
  // `testingBlock` (#127) the deterministic "How to test" section, and
  // `visualsBlock` (#195) the "Before / after" media table. All are
  // inserted between the body and the footer (testing first, closing last)
  // and are deliberately NOT fed into the LLM prompt below, so the model
  // can never drop, duplicate, or paraphrase them.
  const suffix = (testingBlock ? `\n\n${testingBlock}` : '')
    + (visualsBlock ? `\n\n${visualsBlock}` : '')
    + (closingBlock ? `\n\n${closingBlock}` : '');
  const fallbackTitle = `${username}'s changes`;
  const fallbackBody = `Dev session by ${username} via Usernode${suffix}`;

  // When the caller passes a user's own key (BYOK, #30) we can hit the
  // Anthropic API even if the server has no admin key configured, so
  // check isEnabled only as a fallback guard.
  if (!apiKey && !llm.isEnabled()) {
    return { title: fallbackTitle, body: fallbackBody };
  }

  try {
    const meta = await llm.generatePrMetadata({
      userRequest: userMessage,
      ccSummary,
      requests,
      summaries,
      specs,
      username,
      apiKey,
    });
    return {
      title: meta.title,
      body: `${meta.body}${suffix}\n\n---\n_Dev session by ${username} via Usernode_`,
      usage: meta.usage,
      model: meta.model,
    };
  } catch (err) {
    log.warn('pr-metadata', 'Generation failed; using fallback', { err: err.message });
    return { title: fallbackTitle, body: fallbackBody };
  }
}

// Pull the full per-turn history for a session so the PR title/body can
// reflect every update on the branch, not just the latest turn (#26):
//  - `requests`:  every user-role message, chronological. The current
//                 turn's message is already persisted (sessions.js inserts
//                 it before the worker runs), so it's included here.
//  - `summaries`: each completed turn's coding-agent summary, persisted as
//                 a system row with metadata.ccOutput. The CURRENT turn's
//                 summary is NOT yet persisted when this runs, so callers
//                 pass it separately and we append it as the final entry.
//  - `specs`:     the session's spec doc(s) — the Mayor-maintained markdown
//                 that captures overall intent. Includes the live draft
//                 (chat_sessions.spec_md) plus any saved snapshots
//                 (chat_session_specs), since a single chat can carry more
//                 than one distinct spec (#27). Deduped, oldest-first.
//                 Used as a THEME signal: it describes intended scope (which
//                 may run ahead of what's actually built), so the prompt
//                 leans on requests/summaries for the concrete changes.
async function gatherSessionContext(pool, sessionId, currentCcSummary) {
  const ctx = {
    requests: [], summaries: [], specs: [], linkedIssues: [], appliedIssues: [],
    testingMd: null, testingPath: null, appliedTesting: null,
    visuals: null, appliedVisuals: null,
  };
  if (pool && sessionId != null) {
    try {
      const { rows } = await pool.query(
        `SELECT role, content, metadata FROM chat_session_messages
           WHERE session_id = $1
             AND (role = 'user' OR (role = 'system' AND metadata->>'ccOutput' IS NOT NULL))
           ORDER BY id ASC`,
        [sessionId]
      );
      for (const row of rows) {
        if (row.role === 'user' && row.content) {
          ctx.requests.push(row.content);
        } else if (row.role === 'system' && row.metadata && row.metadata.ccOutput) {
          ctx.summaries.push(String(row.metadata.ccOutput));
        }
      }
    } catch (err) {
      log.warn('pr-metadata', 'Failed to gather session history; using current turn only', { err: err.message, sessionId });
    }

    // Spec(s): saved snapshots (oldest-first) then the live draft. We dedupe
    // exact duplicates so an unchanged draft that was also "saved" doesn't
    // appear twice. Querying by session.id keeps both call sites (sessions.js
    // and the server.js orphan path) working without passing spec text in.
    try {
      const specTexts = [];
      const { rows: specRows } = await pool.query(
        `SELECT content FROM chat_session_specs WHERE session_id = $1 ORDER BY version ASC`,
        [sessionId]
      );
      for (const r of specRows) {
        const c = (r.content || '').trim();
        if (c) specTexts.push(c);
      }
      const { rows: liveRows } = await pool.query(
        `SELECT spec_md, linked_issues, pr_linked_issues_applied,
                testing_md, testing_path, pr_testing_applied,
                pr_visuals_applied
           FROM chat_sessions WHERE id = $1`,
        [sessionId]
      );
      const live = (liveRows[0] && liveRows[0].spec_md ? String(liveRows[0].spec_md) : '').trim();
      if (live) specTexts.push(live);

      // Issue linkage (#75). Read from the DB by id so BOTH call sites
      // (sessions.js dev-turn and server.js orphan recovery) pick it up
      // regardless of what columns they SELECT'd onto the session object.
      ctx.linkedIssues = sanitizeIssueNumbers(liveRows[0] && liveRows[0].linked_issues);
      ctx.appliedIssues = sanitizeIssueNumbers(liveRows[0] && liveRows[0].pr_linked_issues_applied);

      // Testing guidance (#127) — same read-by-id rationale as above. The
      // dev-turn path persists testing_md/testing_path BEFORE calling
      // applyPrMetadata, so this always sees the current turn's block.
      ctx.testingMd = (liveRows[0] && liveRows[0].testing_md) || null;
      ctx.testingPath = (liveRows[0] && liveRows[0].testing_path) || null;
      ctx.appliedTesting = (liveRows[0] && liveRows[0].pr_testing_applied) || null;

      // Stored capture artifacts (#195) — read directly here (not via
      // services/visuals.js) so this module stays free of a circular
      // require; visuals.js depends on pr-metadata for the block builder.
      ctx.appliedVisuals = (liveRows[0] && liveRows[0].pr_visuals_applied) || null;
      try {
        const { rows: visRows } = await pool.query(
          `SELECT id, kind, media FROM session_visuals WHERE session_id = $1`,
          [sessionId]
        );
        if (visRows.length) {
          const shaped = {};
          for (const v of visRows) {
            if (!shaped[v.kind]) shaped[v.kind] = {};
            shaped[v.kind][v.media] = v.id;
          }
          ctx.visuals = shaped;
        }
      } catch (err) {
        log.warn('pr-metadata', 'Failed to gather session visuals', { err: err.message, sessionId });
      }

      const seen = new Set();
      for (const s of specTexts) {
        if (!seen.has(s)) { seen.add(s); ctx.specs.push(s); }
      }
    } catch (err) {
      log.warn('pr-metadata', 'Failed to gather session specs', { err: err.message, sessionId });
    }
  }
  // Append the in-flight turn's summary (not yet persisted). Skip if it's
  // already the last entry (e.g. orphan-recovery may re-read a row).
  const cur = (currentCcSummary || '').trim();
  if (cur && ctx.summaries[ctx.summaries.length - 1] !== cur) {
    ctx.summaries.push(cur);
  }
  return ctx;
}

// Either open a new PR with the generated title/body, or update the
// existing PR's title/body on GitHub when it changed. Persists to DB
// and fires a broadcast callback so connected clients update in real
// time. Returns the resulting { prNumber, prUrl, prTitle } (or null
// if PR operations aren't possible: no repo, no github app, etc.).
//
// `userId` is the user the platform-side Haiku call is debited to.
// Both call sites already know it (sessions.js: req.user.id; server.js
// orphan recovery: session.user_id). When the fallback template fires
// (no API call) or BYOK is used, no debit happens.
async function applyPrMetadata({
  pool, session, repoOwner, repoName,
  userMessage, ccSummary, username,
  broadcast, apiKey, userId,
}) {
  if (!repoOwner || !repoName) return null;

  // Build cumulative context across all of this PR's turns. Falls back to
  // the single current turn when no history is available.
  const {
    requests, summaries, specs, linkedIssues, appliedIssues,
    testingMd, testingPath, appliedTesting,
    visuals, appliedVisuals,
  } = await gatherSessionContext(pool, session && session.id, ccSummary);

  // Deterministic `Closes #N` block (#75), regenerated from the linked set
  // on every turn so it's always current and never doubled.
  const closingBlock = buildClosingBlock(linkedIssues);

  // Deterministic "How to test" section (#127), regenerated from the
  // session's latest testing guidance on every turn.
  const testingBlock = buildTestingBlock(testingMd, testingPath);

  // Deterministic "Before / after" media section (#195), regenerated from
  // the session's stored capture artifacts. Mostly relevant on the lazy-PR
  // path (headless → promote), where the capture ran long before the PR
  // exists; on the interactive path visuals.js patches the live body
  // directly after each capture instead.
  const visualsBlock = buildVisualsBlock(visuals, require('./caddy').USERNODE_DOMAIN);

  const meta = await generatePrMetadata({
    userMessage, ccSummary, requests, summaries, specs, username, apiKey, closingBlock, testingBlock, visualsBlock,
  });
  const { title: prTitle, body: prBody } = meta;

  // Whether the linked-issue set drifted from what's reflected in the live
  // PR body. Drives the existing-PR update gate below so a newly-linked
  // issue reaches GitHub even when the title is unchanged.
  const issuesChanged = !sameIssueSet(linkedIssues, appliedIssues);

  // Same drift check for the testing section (#127): compare the freshly
  // rendered block against the snapshot last written to the PR body, so new
  // or revised guidance reaches GitHub on a title-unchanged turn.
  const testingChanged = testingBlock !== (appliedTesting || '');

  // And for the visuals section (#195): a capture that landed since the
  // last body write must reach GitHub even on a title-unchanged turn.
  const visualsChanged = visualsBlock !== (appliedVisuals || '');

  // Debit the Haiku call to the session owner — into the BYOK bucket
  // when the user's own key paid for it (#119). The fallback-template
  // path produces no usage, which recordSpend treats as a no-op.
  if (meta.usage && userId != null && pool) {
    const costCents = llm.estimateCostCents(meta.usage, meta.model);
    await limits.recordSpend(pool, userId, costCents, { byok: !!apiKey });
  }

  if (!session.pr_number) {
    // New PR path.
    try {
      const pr = await github.createPR(repoOwner, repoName, {
        branch: session.branch_name,
        title: prTitle,
        body: prBody,
      });
      session.pr_number = pr.number;
      session.pr_url = pr.html_url;
      session.pr_title = prTitle;
      await pool.query(
        `UPDATE chat_sessions SET pr_number = $1, pr_url = $2, pr_title = $3, pr_linked_issues_applied = $4, pr_testing_applied = $5, pr_visuals_applied = $6 WHERE id = $7`,
        [pr.number, pr.html_url, prTitle, linkedIssues, testingBlock || null, visualsBlock || null, session.id]
      );
      if (broadcast) broadcast('pr_created', { prNumber: pr.number, prUrl: pr.html_url, prTitle });
      return { prNumber: pr.number, prUrl: pr.html_url, prTitle };
    } catch (err) {
      log.warn('pr-metadata', 'PR creation failed', { err: err.message, sessionId: session.id });
      return null;
    }
  }

  // Existing PR: hit GitHub if the title changed OR the linked-issue set
  // changed (#75) OR the testing guidance changed (#127) OR the visuals
  // set changed (#195) — these would otherwise be skipped on a
  // title-unchanged turn, leaving the new `Closes #N` line / "How to
  // test" / "Before / after" section off the PR body.
  if (prTitle === session.pr_title && !issuesChanged && !testingChanged && !visualsChanged) {
    return { prNumber: session.pr_number, prUrl: session.pr_url, prTitle: session.pr_title };
  }

  try {
    await github.updatePR(repoOwner, repoName, session.pr_number, {
      title: prTitle,
      body: prBody,
    });
    session.pr_title = prTitle;
    await pool.query(
      `UPDATE chat_sessions SET pr_title = $1, pr_linked_issues_applied = $2, pr_testing_applied = $3, pr_visuals_applied = $4 WHERE id = $5`,
      [prTitle, linkedIssues, testingBlock || null, visualsBlock || null, session.id]
    );
    if (broadcast) broadcast('pr_updated', { prNumber: session.pr_number, prUrl: session.pr_url, prTitle });
    return { prNumber: session.pr_number, prUrl: session.pr_url, prTitle };
  } catch (err) {
    log.warn('pr-metadata', 'PR title update failed', { err: err.message, sessionId: session.id });
    return null;
  }
}

module.exports = {
  generatePrMetadata, applyPrMetadata, sanitizeIssueNumbers,
  buildClosingBlock, buildTestingBlock, parseClosingKeywords,
  buildVisualsBlock, upsertVisualsBlock,
};
