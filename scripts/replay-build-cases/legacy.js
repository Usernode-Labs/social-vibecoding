'use strict';

// The build-turn text as it stood before the shared build contract, kept
// VERBATIM so a replay can put the old prompt and the new one to the same
// model on the same task. Historical fixture text, not live prompt code:
// nothing outside scripts/replay-build-cases reads it.
//
// Source: src/routes/sessions.js at c75246b301420145ae6071e19eb847c79f17bff1.
// The dispatched-turn block is unchanged from the platform's first commit
// (cafa5b17, 2026-04-25).

const LEGACY_DISPATCHED_TURN_INSTRUCTIONS = `- IMPLEMENT the requested changes fully. Do not just explore — write code.
- Spend minimal time reading files. Focus on writing and editing.
- Create or modify all necessary files to complete the request.
- If building something new, implement the full feature — don't stop partway.
- After all changes are made, stage everything with "git add -A" and commit
  with a clear message describing what was built.
- Do NOT ask questions or request clarification. Just build it.`;

const LEGACY_OPENROUTER_ISSUE_NOTE =
  'The `usernode-report-platform-issue` helper is NOT available on this backend; do not call it.';

module.exports = {
  LEGACY_DISPATCHED_TURN_INSTRUCTIONS,
  LEGACY_OPENROUTER_ISSUE_NOTE,
};
