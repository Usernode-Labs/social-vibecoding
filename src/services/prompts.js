'use strict';

// Loads and caches the platform conventions doc injected into every
// Mayor + Claude Code system prompt. One source of truth — edit
// `app-conventions.md` and both prompts update on next restart.

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const CONVENTIONS_PATH = path.join(__dirname, '..', 'prompts', 'app-conventions.md');

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

// SELF-HOSTING-PLAN.md sub-step 2i: appended to the Mayor system prompt
// only when the chat session's app is self_hosted=TRUE. The list combines
// the SELF-HOSTING.md doc's sensitive globs with two added by the
// assessment (`docker-compose.yml` for the sidecar-volume hazard;
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

module.exports = { getAppConventions, getSelfHostedRefuseList };
