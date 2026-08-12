// #717: the Mayor is an orchestrator, not a coding agent. It needs the
// compact cross-cutting platform rules, but replaying the complete developer
// handbook on every normal-chat and autonomous Mayor call wastes tens of
// thousands of input tokens. The dispatched scout/build prompt still carries
// the full document; this test pins only the Mayor boundary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mayor-token-budget-test-secret';

const prompts = require('../src/services/prompts');
const { getMayorSystemPrompt } = require('../src/routes/sessions');

test('Mayor prompt uses the authoritative compact excerpt, not the full handbook', () => {
  const compact = prompts.getWorkOrderEssentials();
  const full = prompts.getAppConventions();
  const prompt = getMayorSystemPrompt('Budget Test App', false, '', false, null);

  assert.ok(compact.length > 1000, 'compact conventions excerpt should be substantive');
  assert.ok(full.length > compact.length * 10, 'fixture should still distinguish full vs compact');
  assert.ok(prompt.includes(compact), 'Mayor receives the compact authoritative excerpt');
  assert.ok(!prompt.includes(full), 'Mayor must not receive the full developer handbook');
});

test('empty Mayor prompt stays below the 32 KB regression ceiling', () => {
  const prompt = getMayorSystemPrompt('Budget Test App', false, '', false, null);
  const bytes = Buffer.byteLength(prompt, 'utf8');

  assert.ok(bytes < 32 * 1024, `Mayor prompt is ${bytes} bytes; expected < 32768`);
});

test('dispatched coding-agent prompt still reads the full conventions source', () => {
  const sessionsSource = fs.readFileSync(require.resolve('../src/routes/sessions'), 'utf8');

  assert.match(
    sessionsSource,
    /const claudePrompt = `[\s\S]*?\$\{getAppConventions\(\)\}/,
    'the build/scout prompt must keep the complete platform conventions'
  );
});
