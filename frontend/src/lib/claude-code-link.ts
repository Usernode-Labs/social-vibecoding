// #5987: "Open in Claude Code", a link that opens a new Claude Code session on
// the web with its prompt already typed: build this one request through the
// Homeroom connector. The person reads it and presses send.
//
// claude.ai/code takes `prompt`, `repositories` and `environment` as URL
// parameters. Only the first two are ever set here, and only from values
// Homeroom controls: the app's slug and the request's number, both checked
// against their own shapes, and the person's own fork when Homeroom can see
// it is ready. The request's title and body are NEVER put in the link: they
// are other people's writing, and in the prompt they would read as the
// person's own instructions to their agent. The work order prepare_work
// returns brings them in, fenced as untrusted text. There is no argument
// that could carry them, which is the point.
//
// `environment` is left out, so the person's default applies.
//
// `startedFrom` in the prompt is how a task started from this link is
// counted: prepare_work records it on the work order (external_agent_tasks
// .started_from), beside the tasks started any other way (#4856's baseline).

export const CLAUDE_CODE_WEB_URL = 'https://claude.ai/code';

/** What prepare_work records for a task this link started. */
export const CLAUDE_CODE_LINK_SOURCE = 'claude_code_link';

/** An app slug as the platform mints them (agent-sessions.js parseHint). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A GitHub owner or repository name. */
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;

export interface ClaudeCodeRepository {
  owner: string;
  repo: string;
}

/**
 * The prompt the session opens with. English whatever the interface's
 * language: it is addressed to the coding agent, as the work orders are.
 */
export function claudeCodePrompt(slug: string, number: number): string | null {
  if (typeof slug !== 'string' || !SLUG.test(slug)) return null;
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return `Use the Homeroom connector to build request #${number} on the Homeroom app \`${slug}\`. `
    + `Call prepare_work with slug \`${slug}\`, requestNumber ${number} and startedFrom \`${CLAUDE_CODE_LINK_SOURCE}\`, `
    + 'follow the work order it returns, then call submit_work.';
}

/**
 * The link, or null when the slug or number is not one Homeroom would mint.
 * `repository` preselects that repository in the session's picker; leave it
 * out and the person picks one there.
 */
export function claudeCodeLink({ slug, number, repository = null }: {
  slug: string;
  number: number;
  repository?: ClaudeCodeRepository | null;
}): string | null {
  const prompt = claudeCodePrompt(slug, number);
  if (!prompt) return null;
  let url = `${CLAUDE_CODE_WEB_URL}?prompt=${encodeURIComponent(prompt)}`;
  if (repository && REPO_PART.test(repository.owner || '') && REPO_PART.test(repository.repo || '')) {
    url += `&repositories=${encodeURIComponent(`${repository.owner}/${repository.repo}`)}`;
  }
  return url;
}

/**
 * The repository to preselect, from the hand-off status (GET
 * /api/apps/:slug/dev-flow/status): the person's own fork, once it is ready.
 * That is where the work order pushes, and the one repository Homeroom knows
 * they can open. Anything else (no fork yet, an app on Homeroom's git host)
 * leaves the choice to them.
 */
export function forkRepository(status: { fork?: { state?: string; owner?: string; repo?: string } | null } | null | undefined): ClaudeCodeRepository | null {
  const fork = status && status.fork;
  if (!fork || fork.state !== 'ready' || !fork.owner || !fork.repo) return null;
  return { owner: fork.owner, repo: fork.repo };
}
