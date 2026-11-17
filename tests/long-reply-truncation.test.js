// #2641: "Long GLM responses seem to be getting truncated". The cut that
// report found was a prompt bound in the session Mayor's turn, which is gone
// with that turn. What stays is the part of the fix that kept the agent's own
// answer whole on its way out of the runtime: the OpenRouter (Codex) runtime
// emits each agent message with BOTH a short `text` (the activity line that
// scrolls past while the turn runs) and the complete `fullText`, and the
// worker's turn result reads the full one. Homeroom bot reads that result
// (`lastResultText`) as the agent's reply and its spec, so a preview-length
// cut there would be the same truncation again.
//
// Source assertions, because the two fields are set in a stream parser and a
// worker loop that need a container to run.
//
// Run with: node --test tests/long-reply-truncation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('the 300-character progress preview and the full text stay two fields', () => {
  // The preview is meant to be short. It is not the answer, and worker.js
  // stores the full version as the turn result.
  const agent = fs.readFileSync(path.join(root, 'src', 'agents', 'codex-openrouter.js'), 'utf8');
  assert.match(agent, /text: String\(txt\)\.slice\(0, 300\),\s*\n\s*fullText: String\(txt\),/,
    'the preview and the full text must stay two separate fields');
  const worker = fs.readFileSync(path.join(root, 'src', 'services', 'worker.js'), 'utf8');
  assert.match(worker, /ev\.kind === 'agent_message' && ev\.fullText != null/);
  assert.match(worker, /state\.lastResultText = ev\.fullText;/,
    'the turn result reads the full text, never the preview');
});
