'use strict';

/**
 * Fleet maintenance campaigns: the I/O behind the campaign machine
 * (src/workflow/campaign/), which is the engine behind
 * issues.kind='maintenance_campaign' (#853's generalization).
 *
 * A campaign is a platform-level governance proposal on the self-hosted
 * app. Once its vote passes (or an admin force-applies it), the governance
 * machine inserts a maintenance_campaigns row and starts the campaign
 * machine, which fixes the apps it reaches, works on them one at a time and
 * puts each change up for a vote through the proposal machine's promote.
 * What lives here is what its work does to one app:
 *
 *   - runAppChange: a bounded LLM tool loop (read_file / search_file /
 *     edit_file / write_file / skip_app / finish) against the app's repo via
 *     the GitHub API. Deliberately NOT a worker session: workers are
 *     repo-scoped by design (one session-scoped credential per repo), whereas
 *     the platform process already holds the PAT and the LLM client: no
 *     container boot, no clone. The first successful app's summary is carried
 *     forward (the machine keeps it) so later apps stay consistent;
 *   - pushChange: the change as one commit on the campaign's branch for the
 *     app;
 *   - openChangePr: its pull request, found before it is created;
 *   - campaignStatus: the dashboard's read.
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const log = require('./logger');
const github = require('./github');
const llm = require('./llm');

const PLATFORM_USERNAME = 'usernode-platform';
// A failure retrying cannot mend (the change is too big or the model went
// astray): the campaign's work fails the app at once.
const permanent = (message) => Object.assign(new Error(message), { permanent: true });
// Tool-call round-trips per app. Maintenance changes are small by
// definition (read a file or two, stage an edit or two, finish) — but a
// repo with several >100 KB files can legitimately need a handful of
// paged reads and searches before the first edit, so leave headroom.
// A loop that needs more than this is lost, not thorough.
const MAX_TOOL_ITERATIONS = 20;
// Truncation guard for read_file RESULTS only — edits still apply
// against the full content held in memory, so an old_string deep in a
// huge file keeps matching even when the model saw a truncated view.
//
// The window alone proved insufficient for campaign #1 (JWT switchover,
// 2026-07-31): the three apps whose server.js exceeded 100 KB
// (puzzlechain 350 KB, block-game 345 KB, number-guessing 125 KB) all
// exhausted the tool budget. Their JWT code sat in the visible first
// 100 KB, but the instructions said "find EVERY place" — and with no way
// to inspect the rest of the file, the model kept re-reading the same
// truncated view trying to confirm completeness and never called finish.
// Every sub-100 KB app succeeded. Hence `offset` on read_file (page
// through the remainder) and search_file (answer "every place?" in one
// bounded call).
const MAX_READ_RESULT_CHARS = 100 * 1024;
// search_file caps: enough to enumerate every JWT/auth touchpoint in the
// worst real repo without ever flooding the context.
const MAX_SEARCH_MATCHES = 50;
const MAX_SEARCH_LINE_CHARS = 300;

function parseRepo(url) {
  const [, owner, repo] = (url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo: repo.replace(/\.git$/, '') } : null;
}

/**
 * The dedicated proposer for campaign PRs. Every proposal list JOINs
 * users on chat_sessions.user_id, so campaign proposals need a real row —
 * and attributing them to a person would misname 30+ proposal cards.
 * Random discarded password so the account can never log in (same
 * posture as the staging fixture users in db/migrate.js).
 */
async function ensurePlatformUser(pool) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE username = $1', [PLATFORM_USERNAME]
  );
  if (rows.length) return rows[0].id;
  const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  const { rows: ins } = await pool.query(
    `INSERT INTO users (username, password, is_admin, can_create_apps)
     VALUES ($1, $2, FALSE, FALSE)
     ON CONFLICT (username) DO NOTHING
     RETURNING id`,
    [PLATFORM_USERNAME, hash]
  );
  if (ins.length) return ins[0].id;
  const { rows: again } = await pool.query(
    'SELECT id FROM users WHERE username = $1', [PLATFORM_USERNAME]
  );
  if (!again.length) throw new Error('Could not create the usernode-platform user');
  return again[0].id;
}

// ─── The per-app AI tool loop ────────────────────────────────────────

const CAMPAIGN_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the app repository (main branch, plus any edits you have already staged). Returns the file content, or "File not found." Start with server.js for backend changes and public/index.html for frontend ones. Large files are returned in windows: if the result says it was truncated, call read_file again with `offset` to continue, or use search_file to locate what you need.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path, e.g. "server.js"' },
        offset: { type: 'integer', description: 'Character offset to start reading from (default 0). Use the value suggested by a truncated read to page through a large file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_file',
    description: 'Find every occurrence of a literal string in one file (main branch, plus any edits you have already staged). Returns matching lines with line numbers. Use this to confirm you have found ALL relevant code in a file too large to read in one window (e.g. search server.js for "JWT_SECRET" or "jwt.verify").',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path, e.g. "server.js"' },
        query: { type: 'string', description: 'Literal text to search for (case-sensitive, not a regex)' },
      },
      required: ['path', 'query'],
    },
  },
  {
    name: 'edit_file',
    description: 'Stage a surgical edit: replace old_string with new_string in a file. old_string must match the current file content EXACTLY (including whitespace) and appear exactly once. Preferred over write_file for every change to an existing file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description: 'Stage a full file write. Only for creating a NEW file or when the instructions genuinely require rewriting one; use edit_file for changes to existing files.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'skip_app',
    description: 'Declare that this app does not need the campaign change (e.g. the code the instructions target is absent). Ends work on this app without opening a PR.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
  {
    name: 'finish',
    description: 'All edits for this app are staged — end work on this app. The summary should describe exactly what was changed and where; it is shown to reviewers and reused as guidance for the next app in the campaign.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
];

function campaignSystemPrompt(campaign, exemplarSummary) {
  let prompt = `You are executing a platform maintenance campaign across many apps on the Homeroom platform. Each app is a small Node.js/Express server with an HTML/JS frontend, in its own git repository. You work on ONE app at a time.

Campaign: ${campaign.title}

Operator instructions:
${campaign.instructions}

Rules:
- Make the minimal change the instructions describe. Do not refactor, reformat, or fix anything unrelated.
- Keep the app's existing code style.
- Never guess file contents — read a file before editing it.
- Every response must call at least one tool. End with finish (edits staged) or skip_app (change not applicable).`;
  if (exemplarSummary) {
    prompt += `\n\nFor consistency: a previous app in this campaign was handled like this —\n${exemplarSummary}`;
  }
  return prompt;
}

/**
 * Run the bounded tool loop for one app. Resolves to
 *   { files: Map<path, content>, summary }  — edits staged, or
 *   { skipped: true, reason }               — app doesn't need the change.
 * Throws on LLM/GitHub errors (retried by the caller's work), and with
 * `permanent: true` on truncation, budget exhaustion or a model that went
 * astray (the app fails with the message).
 *
 * `onUsage(usage, servedModel)` is invoked per LLM call so the caller
 * can attribute spend. `stopped()`, asked before each call, ends the run
 * (an error with code 'campaign_stopped') when the caller's work lost its
 * claim: the campaign was stopped, or its process is shutting down.
 */
async function runAppChange({ campaign, app, exemplarSummary, onUsage, stopped = null }) {
  const repo = parseRepo(app.repo_url);
  if (!repo) throw permanent(`Unparseable repo_url: ${app.repo_url}`);

  const staged = new Map();   // path -> full staged content
  const original = new Map(); // path -> content on main (read cache; null = 404)

  const readCurrent = async (path) => {
    if (staged.has(path)) return staged.get(path);
    if (original.has(path)) return original.get(path);
    const content = await github.getFileContent(repo.owner, repo.repo, path, 'main');
    original.set(path, content);
    return content;
  };

  const resolveTool = async (tc) => {
    const input = tc.input || {};
    if (tc.name === 'read_file') {
      const content = await readCurrent(String(input.path || ''));
      if (content == null) return 'File not found.';
      const offset = Math.max(0, Number(input.offset) || 0);
      if (offset >= content.length && offset > 0) {
        return `[offset ${offset} is past the end of the file (${content.length} chars) — nothing more to read]`;
      }
      const window = content.slice(offset, offset + MAX_READ_RESULT_CHARS);
      const end = offset + window.length;
      if (end < content.length) {
        return `${window}\n…[showing chars ${offset}–${end} of ${content.length} — call read_file with offset=${end} for the next window, or search_file to locate text. edit_file matches against the full file.]`;
      }
      return offset > 0 ? `[chars ${offset}–${end} of ${content.length}]\n${window}` : window;
    }
    if (tc.name === 'search_file') {
      const query = String(input.query ?? '');
      if (!query) return 'Error: query is required.';
      const content = await readCurrent(String(input.path || ''));
      if (content == null) return 'File not found.';
      const matches = [];
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(query)) continue;
        matches.push(`line ${i + 1}: ${lines[i].slice(0, MAX_SEARCH_LINE_CHARS)}`);
        if (matches.length >= MAX_SEARCH_MATCHES) {
          matches.push(`…[stopped at ${MAX_SEARCH_MATCHES} matches — narrow the query]`);
          break;
        }
      }
      if (!matches.length) return 'No matches.';
      return `${matches.length >= MAX_SEARCH_MATCHES ? matches.length - 1 : matches.length} match(es):\n${matches.join('\n')}`;
    }
    if (tc.name === 'edit_file') {
      const path = String(input.path || '');
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      if (!oldStr) return 'Error: old_string is empty.';
      const current = await readCurrent(path);
      if (current == null) return `Error: ${path} does not exist — use write_file to create a new file.`;
      const first = current.indexOf(oldStr);
      if (first === -1) return 'Error: old_string not found in the current file content. Re-read the file and retry with an exact match.';
      if (current.indexOf(oldStr, first + 1) !== -1) return 'Error: old_string appears more than once — include more surrounding context to make it unique.';
      staged.set(path, current.slice(0, first) + newStr + current.slice(first + oldStr.length));
      return `Edit staged for ${path}.`;
    }
    if (tc.name === 'write_file') {
      const path = String(input.path || '');
      if (!path) return 'Error: path is required.';
      staged.set(path, String(input.content ?? ''));
      return `Write staged for ${path}.`;
    }
    return 'ok';
  };

  // Compact one-line-per-tool-call trace. Logged per turn and embedded
  // in the budget-exhaustion error so a failed run on the dashboard is
  // self-diagnosing instead of a black box (the puzzlechain retry on
  // 2026-07-31 failed identically pre- and post-#862 and we had no way
  // to tell what the model spent its 12 turns on).
  const trace = [];
  const describeToolCall = (tc) => {
    const input = tc.input || {};
    if (tc.name === 'read_file') {
      return `read_file(${input.path}${input.offset ? `@${input.offset}` : ''})`;
    }
    if (tc.name === 'search_file') return `search_file(${input.path} ${JSON.stringify(String(input.query ?? '').slice(0, 40))})`;
    if (tc.name === 'edit_file' || tc.name === 'write_file') return `${tc.name}(${input.path})`;
    return tc.name;
  };

  const messages = [{
    role: 'user',
    content: `App: "${app.name}" (slug ${app.slug}). Repository: ${app.repo_url}. Apply the campaign instructions to this app now.`,
  }];
  const systemPrompt = campaignSystemPrompt(campaign, exemplarSummary);
  let nudged = false;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    if (stopped && stopped()) {
      throw Object.assign(new Error('The change was stopped'), { code: 'campaign_stopped' });
    }
    const res = await llm.streamChat({
      messages,
      systemPrompt,
      tools: CAMPAIGN_TOOLS,
      telemetryContext: {
        appId: app.id,
        backend: 'helper',
        component: 'fleet_maintenance',
      },
    });
    if (onUsage && res.usage) {
      try { onUsage(res.usage, res.servedModel); } catch { /* accounting never fails the run */ }
    }

    if (!res.toolUses.length) {
      if (res.stopReason === 'max_tokens') {
        throw permanent('LLM response truncated (max_tokens) — the change may be too large for a maintenance campaign');
      }
      // The model answered in prose. One nudge back toward the tools;
      // a second prose-only turn is a hard failure, not a loop.
      trace.push('prose');
      if (!nudged) {
        nudged = true;
        messages.push({ role: 'assistant', content: res.rawContent });
        messages.push({ role: 'user', content: 'Use the tools to make the change, or call skip_app / finish. Do not answer in prose.' });
        continue;
      }
      throw permanent('LLM ended without calling finish or skip_app');
    }

    // Resolve every tool call (Anthropic requires a tool_result per
    // tool_use even alongside a terminal tool), then honor terminals.
    const turnTools = res.toolUses.map(describeToolCall);
    trace.push(...turnTools);
    log.info('fleet-maintenance', 'Campaign tool turn', {
      campaignId: campaign.id, slug: app.slug, iter: iter + 1, tools: turnTools,
    });
    let terminal = null;
    const results = [];
    for (const tc of res.toolUses) {
      if (tc.name === 'skip_app') {
        // skip_app wins over finish if the model somehow emits both:
        // "doesn't need the change" is the more conservative claim.
        terminal = { skipped: true, reason: String(tc.input?.reason || 'not applicable') };
        results.push({ tool_use_id: tc.id, content: 'ok' });
      } else if (tc.name === 'finish') {
        if (!terminal) terminal = { finished: true, summary: String(tc.input?.summary || '') };
        results.push({ tool_use_id: tc.id, content: 'ok' });
      } else {
        results.push({ tool_use_id: tc.id, content: await resolveTool(tc) });
      }
    }

    if (terminal) {
      if (terminal.skipped) return { skipped: true, reason: terminal.reason };
      if (!staged.size) throw permanent('LLM called finish without staging any edits');
      return { files: staged, summary: terminal.summary };
    }

    messages.push({ role: 'assistant', content: res.rawContent });
    messages.push({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.content })),
    });
  }

  throw permanent(
    `Tool-call budget exhausted (${MAX_TOOL_ITERATIONS} iterations) without finish/skip_app. `
    + `Tool trace: ${trace.join(' → ') || '(none)'}`
  );
}

// ─── The change on GitHub ────────────────────────────────────────────

/**
 * The app's change as one commit on the campaign's own branch for it
 * (`maint/c<campaign>/<slug>`, no timestamp, so a retry finds it): the branch
 * is created at main's head, or moved back there when an earlier attempt left
 * it, then the staged files are pushed. Resolves to the commit's sha.
 */
async function pushChange({ repo, branch, files, message }) {
  const main = await github.getBranchSha(repo.owner, repo.repo, 'main');
  if (!main) throw new Error(`${repo.owner}/${repo.repo} has no main branch`);
  try {
    await github.createBranch(repo.owner, repo.repo, branch);
  } catch (err) {
    if (err.status !== 422) throw err;
    await github.forceBranchToSha(repo.owner, repo.repo, branch, main);
  }
  const commit = await github.pushFiles(
    repo.owner, repo.repo,
    Array.from(files.entries()).map(([path, content]) => ({ path, content })),
    { branch, message }
  );
  return String(commit.sha).toLowerCase();
}

/**
 * The change's pull request: the open one GitHub already has for the
 * branch (an attempt that opened it and was lost before it said so), else a
 * new one with the campaign's title and the AI's summary.
 */
async function openChangePr({ repo, branch, campaign, summary }) {
  const shape = (pr) => ({ number: pr.number, url: pr.html_url, title: pr.title || prTitleOf(campaign) });
  const existing = await github.findOpenPrByBranch(repo.owner, repo.repo, branch);
  if (existing) return shape(existing);
  try {
    return shape(await github.createPR(repo.owner, repo.repo, { branch, title: prTitleOf(campaign), body: prBodyOf(campaign, summary) }));
  } catch (err) {
    if (err.code !== 'pr_exists') throw err;
    const found = await github.findOpenPrByBranch(repo.owner, repo.repo, branch);
    if (!found) throw err;
    return shape(found);
  }
}

const prTitleOf = (campaign) => String(campaign.title).slice(0, 250);
const prBodyOf = (campaign, summary) =>
  `Platform maintenance campaign #${campaign.id}: **${campaign.title}**\n\n` +
  `${summary || 'See campaign instructions.'}\n\n` +
  'This PR was opened automatically by the Homeroom platform after the campaign\'s ' +
  'governance vote passed. It merges like any proposal: through this app\'s own ' +
  'merge vote, or when a platform admin drains the campaign\'s green checks.';
// ─── Status (dashboard backing) ──────────────────────────────────────

// A proposed app's proposal, once it is decided.
const PROPOSAL_OUTCOMES = new Map([['merged', 'merged'], ['archived', 'closed']]);

async function campaignStatus(pool, campaignId) {
  const { rows: campRows } = await pool.query(
    'SELECT * FROM maintenance_campaigns WHERE id = $1', [campaignId]
  );
  if (!campRows.length) return null;
  const campaign = campRows[0];
  // What came of a proposed app is its proposal's: merged (by its vote or a
  // drain) or closed (voted down, gone quiet, withdrawn) reads off the
  // joined session, never the campaign's own row.
  const { rows: apps } = await pool.query(
    `SELECT mca.app_id, mca.state, mca.error, mca.updated_at, mca.session_id,
            a.slug, a.name,
            cs.pr_number, cs.pr_url, cs.pr_title, cs.check_state, cs.staging_url,
            cs.status AS session_status
       FROM maintenance_campaign_apps mca
       JOIN apps a ON a.id = mca.app_id
       LEFT JOIN chat_sessions cs ON cs.id = mca.session_id
      WHERE mca.campaign_id = $1
      ORDER BY mca.id`,
    [campaignId]
  );
  const rows = apps.map((r) => ({
    appId: r.app_id,
    slug: r.slug,
    name: r.name,
    state: r.state === 'pr_open' && PROPOSAL_OUTCOMES.has(r.session_status) ? PROPOSAL_OUTCOMES.get(r.session_status) : r.state,
    error: r.error,
    sessionId: r.session_id,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    checkState: r.check_state,
    stagingUrl: r.staging_url,
    updatedAt: r.updated_at,
  }));
  const counts = new Map();
  for (const r of rows) counts.set(r.state, (counts.get(r.state) || 0) + 1);
  return {
    id: campaign.id,
    issueId: campaign.issue_id,
    title: campaign.title,
    instructions: campaign.instructions,
    status: campaign.status,
    createdAt: campaign.created_at,
    completedAt: campaign.completed_at,
    counts: Object.fromEntries(counts),
    apps: rows,
  };
}

module.exports = {
  PLATFORM_USERNAME,
  MAX_TOOL_ITERATIONS,
  ensurePlatformUser,
  campaignStatus,
  // The campaign machine's change work (src/workflow/campaign/services.ts).
  runAppChange,
  pushChange,
  openChangePr,
  campaignSystemPrompt,
  CAMPAIGN_TOOLS,
  parseRepo,
};
