'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Claude imports the shared API-agent router and its routed guidance', () => {
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.equal(claude, '@AGENTS.md\n');

  const instructions = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /Begin UI or Usernode API work/);
  assert.match(instructions, /tool\/ui-workflow\.mjs/);
  const route = JSON.parse(require('node:child_process').execFileSync(process.execPath, [
    path.join(root, 'tool/ui-workflow.mjs'),
    '--task', 'Use the Usernode API to inspect platform state',
    '--files', '',
    '--json',
  ], { cwd: root, encoding: 'utf8' }));
  assert.deepEqual(route.classifications, ['usernode-api']);
  assert.deepEqual(route.context, [
    'agent-skills/ui-development/references/usernode-api.md',
  ]);
  const guidance = route.context.map((relativePath) => (
    fs.readFileSync(path.join(root, relativePath), 'utf8')
  )).join('\n');
  assert.match(guidance, /social-vibecoding codex setup/);
  assert.match(guidance, /social-vibecoding claude setup/);
  assert.match(guidance, /`production` unless the user explicitly/);
  assert.match(guidance, /Browser approval/);
  assert.match(guidance, /still-valid legacy credential lacks the API/);
  assert.match(guidance, /social-vibecoding logout --profile/);
  assert.match(guidance, /promotion-hook readiness/);
  assert.match(guidance, /open `\/hooks`/);
  assert.match(guidance, /Codex-only/);
});

test('machine-local agent setup artifacts are ignored', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.codex\/config\.toml$/m);
  assert.match(ignore, /^\.codex\/config\.toml\.lock\.\*$/m);
  assert.match(ignore, /^\.claude\/social-vibecoding-mcp\.local\.json$/m);
  assert.match(ignore, /^\.claude\/social-vibecoding-mcp\.local\.json\.lock$/m);
  assert.match(ignore, /^\.claude\/social-vibecoding-mcp\.local\.json\.lock\.\*$/m);
});

test('authorization and token-management copy covers both coding agents', () => {
  const authorize = fs.readFileSync(path.join(root, 'public/cli-authorize.html'), 'utf8');
  const authorizeJs = fs.readFileSync(path.join(root, 'public/js/cli-authorize.js'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const source of [authorize, authorizeJs, settings]) {
    assert.match(source, /Codex/);
    assert.match(source, /Claude Code/);
  }
  assert.match(settings, /CLI &amp; coding-agent access/);
});
