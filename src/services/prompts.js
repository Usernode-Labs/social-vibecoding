'use strict';

// Loads and caches the platform conventions doc injected into every
// Mayor + Claude Code system prompt. One source of truth — edit
// `app-conventions.md` and both prompts update on next restart.

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const CONVENTIONS_PATH = path.join(__dirname, '..', 'prompts', 'app-conventions.md');
const MAYOR_POLICY_PATH = path.join(__dirname, '..', 'prompts', 'mayor-policy.md');

let cached = null;

function getAppConventions() {
  if (cached !== null) return cached;
  try {
    cached = fs.readFileSync(CONVENTIONS_PATH, 'utf-8');
  } catch (err) {
    log.error('prompts', 'Failed to read app-conventions.md', { err: err.message });
    cached = '';
  }
  return cached;
}

// Token-optimization (#): the Mayor is a router/PM, not a coder, so it no
// longer receives the full app-conventions.md (~66 KB) — only the coding
// agent needs conventions. `mayor-policy.md` is the compact, STABLE routing
// policy: the same text every turn, which lets it serve as the cached
// prompt-prefix (see llm.streamChat cache_control). It must stay under the
// MAYOR_POLICY_MAX_CHARS cap so the stable prefix never balloons — the doc
// carries only routing rules, never per-session state (spec, PR, proposals,
// attachments live in the dynamic suffix appended by getMayorSystemPrompt).
const MAYOR_POLICY_MAX_CHARS = 12000;
const COMPLETION_MARKER = '[CODING AGENT COMPLETED]';
let cachedMayorPolicy = null;

function loadMayorPolicyTemplate() {
  if (cachedMayorPolicy !== null) return cachedMayorPolicy;
  try {
    cachedMayorPolicy = fs.readFileSync(MAYOR_POLICY_PATH, 'utf-8');
  } catch (err) {
    log.error('prompts', 'Failed to read mayor-policy.md', { err: err.message });
    cachedMayorPolicy = '';
  }
  return cachedMayorPolicy;
}

// Returns the compact, stable Mayor policy with the app name interpolated.
// This is the cache-prefix half of the Mayor system prompt — keep it free
// of per-turn state. Throws if the interpolated result exceeds the cap so a
// future doc edit that reintroduces bloat fails loudly (a guard test also
// enforces the same bound).
function getMayorPolicy(appName) {
  const tpl = loadMayorPolicyTemplate();
  const out = tpl
    .replace(/\{\{APP_NAME\}\}/g, String(appName || 'this app'))
    .replace(/\{\{COMPLETION_MARKER\}\}/g, COMPLETION_MARKER)
    .trimEnd();
  if (out.length > MAYOR_POLICY_MAX_CHARS) {
    throw new Error(`Mayor policy prompt is ${out.length} chars — exceeds the ${MAYOR_POLICY_MAX_CHARS}-char cap`);
  }
  return out;
}

// SELF-HOSTING.md sub-step 2i: appended to the Mayor system prompt
// only when the chat session's app is self_hosted=TRUE. The list
// is the source of truth (originally derived from the design-phase
// "sensitive globs" plus two added by the security assessment:
// `docker-compose.yml` for the sidecar-volume hazard and
// `.github/workflows/deploy.yml` for the JWT_SECRET rotation hazard).
//
// "Refuse without explicit allow_risky" means: surface the risk first,
// require user confirmation in the same message, and don't silently
// include such edits in a broader change. The list is exhaustive on
// purpose — Mayor errs on the side of asking.
const SELF_HOSTED_REFUSE_LIST = `

==== PLATFORM SELF-EDIT GUARDRAILS (self-hosted only) ====

You are editing the Usernode platform itself. Refuse to propose edits to
any of the following without an explicit \`allow_risky: true\`
confirmation from the user in the same message:

- The bootstrap path in \`server.js\` (anything that runs before the
  Express app starts listening).
- \`src/middleware/auth.js\` and any code that reads or writes
  \`JWT_SECRET\` or anything in \`src/services/secrets.js\`.
- \`src/db/migrate.js\` for anything beyond append-only DDL
  (\`CREATE TABLE IF NOT EXISTS\`, \`ADD COLUMN IF NOT EXISTS\`,
  forward-only data backfills). Drops, renames, type changes, and
  not-null tightenings are all risky.
- Files configuring or mounting \`/var/run/docker.sock\` (any
  service that talks to the host's Docker daemon).
- \`docker-compose.yml\` — sidecar volumes, container privileges,
  network exposure.
- \`.github/workflows/deploy.yml\` — anything that rotates secrets,
  changes the deploy target, or alters the rollback path.

If the user asks you to touch any of these, surface the risk first and
require explicit confirmation. Do not silently include such edits in a
broader change.

==== END PLATFORM SELF-EDIT GUARDRAILS ====`;

function getSelfHostedRefuseList() {
  return SELF_HOSTED_REFUSE_LIST;
}

// Word-boundary-ish truncation for the advisor context blocks. A local
// copy (not routes/sessions.js's buildSpecPreview) so prompts.js stays
// free of a circular require back into the routes layer.
function clip(content, max) {
  const text = typeof content === 'string' ? content : '';
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const bound = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  if (bound > max * 0.8) cut = cut.slice(0, bound);
  return `${cut}…`;
}

// #297: system prompt for the per-proposal "Ask AI" advisor — the Mayor
// in advisor mode, scoped to ONE proposal and hard-locked to read-only
// Q&A. Modeled on getMayorSystemPrompt (same repo/app awareness + the
// authoritative conventions block + a verbatim spec block), but with
// every dispatch/tool/worker affordance stripped: this advisor cannot
// act, only discuss. The read-only boundary is enforced structurally too
// — the discuss route never passes `tools` to llm.streamChat, so there
// is literally nothing for the model to call; the prose below is
// belt-and-suspenders so the advisor presents itself correctly and
// redirects action requests to the "Propose a change" flow.
//
// `proposal` shape:
//   { kind: 'pr'|'gov', title, author, status, prNumber, prUrl,
//     govKind, govPayload }   (gov fields only when kind === 'gov')
function buildProposalDiscussSystemPrompt({
  appName,
  repoUrl,
  proposal = {},
  specMd,
  prBody,
  diff,
  voteTally,
  linkedIssues,
}) {
  const conventionsBlock = `

==== PLATFORM CONVENTIONS (authoritative) ====

${getAppConventions()}

==== END PLATFORM CONVENTIONS ====`;

  const issues = Array.isArray(linkedIssues)
    ? linkedIssues.filter((n) => Number.isInteger(n))
    : [];

  const tallyLine = voteTally && (voteTally.yes != null || voteTally.no != null)
    ? `Current vote tally: ${voteTally.yes || 0} yes / ${voteTally.no || 0} no.`
    : 'Current vote tally: not available.';

  // Governance proposals carry a REDACTED payload only — for a
  // secret_change that means the env-var KEY and action, never the
  // ciphertext value (consistent with routes/issues.js stripping
  // valueEnc before it ever leaves the server).
  let govBlock = '';
  if (proposal.kind === 'gov') {
    const p = proposal.govPayload || {};
    const lines = [`Governance proposal kind: ${proposal.govKind || 'unknown'}.`];
    if (proposal.govKind === 'secret_change') {
      lines.push(`Environment variable key: ${p.key || '(unknown)'}.`);
      lines.push(`Action: ${p.action === 'delete' ? 'delete this variable' : 'set/update this variable'}.`);
      lines.push('You do NOT have the secret value and must never ask for it or guess it — only the key name is known here.');
    } else if (proposal.govKind === 'rename') {
      if (p.newName || p.name) lines.push(`Proposed new display name: "${p.newName || p.name}".`);
    }
    govBlock = `

==== GOVERNANCE PROPOSAL DETAILS ====

${lines.join('\n')}

==== END GOVERNANCE PROPOSAL DETAILS ====`;
  }

  const proposalBlock = `

==== THE PROPOSAL YOU ARE DISCUSSING ====

${proposal.kind === 'gov' ? 'This is a GOVERNANCE proposal' : 'This is a CODE-CHANGE proposal (a pull request)'} for the app "${appName}".
Title: ${proposal.title || '(untitled)'}
Proposed by: ${proposal.author || 'unknown'}
Status: ${proposal.status || 'unknown'}${proposal.prNumber ? `
Pull request: #${proposal.prNumber}${proposal.prUrl ? ` (${proposal.prUrl})` : ''}` : ''}
${tallyLine}${issues.length ? `
Linked issues: ${issues.map((n) => `#${n}`).join(', ')}` : ''}

==== END PROPOSAL ====`;

  const specBlock = `

==== THE AUTHOR'S SPEC DOC ====

${(specMd || '').trim() ? clip(specMd.trim(), 4000) : '(no spec doc was written for this proposal)'}

==== END SPEC DOC ====`;

  const prBodyBlock = (prBody || '').trim()
    ? `

==== PULL REQUEST DESCRIPTION ====

${clip(prBody.trim(), 2000)}

==== END PULL REQUEST DESCRIPTION ====`
    : '';

  const diffBlock = (diff || '').trim()
    ? `

==== CODE CHANGES (unified diff, may be truncated) ====

${diff}

==== END CODE CHANGES ====`
    : `

==== CODE CHANGES ====

(The diff could not be loaded — discuss the proposal from its title, spec, and description. Say so if asked about specific code.)

==== END CODE CHANGES ====`;

  return `You are the Mayor in ADVISOR MODE — a friendly, knowledgeable guide for the app "${appName}" on Usernode Social Vibecoding${repoUrl ? `, which is backed by a real GitHub repository (${repoUrl})` : ', which is backed by a real GitHub repository'}.

YOUR ROLE:
A user is looking at ONE specific proposed change to this app and wants to understand it before they vote. Your job is to discuss THIS proposal with them in plain English — explain what it does, what it might break, whether it matches the linked issues, trade-offs, risks, and whether it's a good idea. You know this app, its conventions, the author's spec, the PR description, and the actual code changes (all included below), so answer concretely and refer to them. Have a real back-and-forth: answer follow-ups using everything discussed so far. Keep replies focused and readable — a few sentences to a few short paragraphs, longer only when the user asks you to go deep.

HARD READ-ONLY BOUNDARY — you can ONLY talk:
You are a discussion-only advisor. You CANNOT and MUST NOT claim to take any action. Specifically you cannot:
- edit code, write files, or open/modify/close any pull request,
- run the coding agent, start a build, dispatch a scout, or start any worker or job,
- cast, change, or count votes, or merge anything,
- change the app's name, secrets, settings, or visibility.
You have NO tools — there is nothing you can do but reply in text. Never imply otherwise, never say "I'll change/build/fix that," and never fabricate that an action happened. If the user wants to actually make a change, tell them to use the normal "Propose a change" flow in their own dev chat (where the Mayor can dispatch the coding agent) — you can help them think through WHAT to propose, but you cannot start it from here.

OTHER RULES:
- This conversation is PRIVATE to this user and is NOT visible in the group discussion thread. Don't tell them to "post this in chat" as if you were posting for them.
- Be honest about uncertainty. If the diff is truncated or missing, say what you can and can't determine rather than guessing about specific code.
- Don't reveal or speculate about secret VALUES; for a secret_change proposal you only know the variable's key name and the action.${conventionsBlock}${proposalBlock}${govBlock}${specBlock}${prBodyBlock}${diffBlock}`;
}

module.exports = {
  getAppConventions,
  getMayorPolicy,
  MAYOR_POLICY_MAX_CHARS,
  getSelfHostedRefuseList,
  buildProposalDiscussSystemPrompt,
};
