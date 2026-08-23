'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalSkills = path.join(root, '.agents', 'skills');
const claudeSkills = path.join(root, '.claude', 'skills');
const openCodePlugin = path.join(root, '.opencode', 'plugins', 'promotion-approval.js');
const skillNames = [
  'mobile-push-testing',
  'react-shell-migration',
  'usernode-api',
  'usernode-proposal',
];

function readSkill(name) {
  return fs.readFileSync(path.join(canonicalSkills, name, 'SKILL.md'), 'utf8');
}

test('Claude, Codex, and OpenCode discover one canonical set of shared skills', () => {
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.equal(claude, '@AGENTS.md\n');
  assert.equal(fs.readlinkSync(claudeSkills), '../.agents/skills');
  assert.equal(fs.realpathSync(claudeSkills), fs.realpathSync(canonicalSkills));
  assert.equal(fs.existsSync(path.join(root, '.opencode', 'skills')), false);
  assert.equal(
    fs.readlinkSync(openCodePlugin),
    '../../.agents/hooks/opencode-promotion-approval.js'
  );

  for (const name of skillNames) {
    const skill = readSkill(name);
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, `${name} has YAML frontmatter`);
    const keys = frontmatter[1]
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf(':')))
      .sort();
    assert.deepEqual(keys, ['description', 'name'], `${name} uses portable frontmatter`);
    assert.match(frontmatter[1], new RegExp(`^name: ${name}$`, 'm'));

    const openai = fs.readFileSync(
      path.join(canonicalSkills, name, 'agents', 'openai.yaml'),
      'utf8'
    );
    assert.match(openai, new RegExp(`\\$${name}\\b`));
  }
});

test('AGENTS keeps always-on rules and routes conditional work to skills', () => {
  const guidance = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  for (const name of skillNames) assert.ok(guidance.includes(`\`${name}\``));
  assert.match(guidance, /\.agents\/skills/);
  assert.match(guidance, /\.claude\/skills/);
  assert.match(guidance, /OpenCode discovers `\.agents\/skills\/` directly/);
  assert.match(guidance, /public\/index\.html.*GENERATED/);
  // Renamed when the widget-language reskin folded the admin console into the
  // shell's palette: the boundary between them is a RENDERING one now
  // (components vs class recipes), not two design systems.
  assert.match(guidance, /One language, two renderers/);
  assert.doesNotMatch(guidance, /open `\/hooks`/);
  assert.doesNotMatch(guidance, /social-vibecoding codex setup/);
});

// #1246 — the base-commit check has to be ALWAYS-ON, not skill-scoped.
//
// The check itself is not new: step 2 of the usernode-proposal skill has
// always said to verify HEAD against the proposal base. But a skill body
// loads only when a task selects that skill, and a session dispatched onto a
// branch somebody else cut never selects it — it just starts editing whatever
// it was handed. That is how a change got written against a fork's `main`
// sitting ~190 merged pull requests behind the commit the request described.
//
// So this pins the rule in BOTH places. Deleting either one restores the gap:
// drop it from AGENTS.md and a dispatched session stops being told, drop it
// from the skill and the local-CLI lifecycle loses the step at the point it
// actually pins the commit.
test('the base-commit check is always-on, not only in the proposal skill', () => {
  const guidance = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(guidance, /Know your base commit before you write code/);
  assert.match(guidance, /git rev-parse HEAD/);
  // The three clauses that make it actionable rather than a warning: the
  // fork's default branch is the stale thing, the base has a source, and
  // reconciling it yourself is not the agent's call.
  assert.match(guidance, /fork's default branch/);
  assert.match(guidance, /prepare_work/);
  assert.match(guidance, /do not merge `upstream\/main` yourself/);

  const proposal = readSkill('usernode-proposal');
  assert.match(
    proposal,
    /Verify `git rev-parse HEAD` equals the proposal base SHA/,
    'the skill keeps its own check — AGENTS.md hoists it, it does not replace it'
  );
});

test('shared Usernode skills retain API safety and scope the hook UI to Codex CLI', () => {
  const api = readSkill('usernode-api');
  assert.match(api, /social-vibecoding codex setup/);
  assert.match(api, /social-vibecoding claude setup/);
  assert.match(api, /social-vibecoding opencode setup/);
  assert.match(api, /Use `production` unless the user explicitly requests/);
  assert.match(api, /browser approval/i);
  assert.match(api, /still-valid legacy credential lacks the API grant/);
  assert.match(api, /social-vibecoding logout --profile/);
  assert.match(api, /host_execution_required/);
  assert.match(api, /untrusted data/);

  const proposal = readSkill('usernode-proposal');
  const cli = proposal.indexOf('**Codex CLI only:**');
  const hookInstruction = proposal.indexOf('open `/hooks`');
  const desktop = proposal.indexOf('**ChatGPT desktop:**');
  assert.ok(cli >= 0 && hookInstruction > cli && desktop > hookInstruction);
  assert.match(proposal, /desktop app has no `\/hooks` command/);
  assert.match(proposal, /must not trigger a `\/hooks` warning/);
  assert.match(proposal, /\*\*Claude Code:\*\*/);
  assert.match(proposal, /\*\*OpenCode:\*\*/);
  assert.match(proposal, /OpenCode has no Codex `\/hooks` trust procedure/);
  assert.match(proposal, /proposal_promote/);
});

test('machine-local agent setup artifacts are ignored', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.codex\/config\.toml$/m);
  assert.match(ignore, /^\.codex\/config\.toml\.lock\.\*$/m);
  assert.match(ignore, /^\.claude\/social-vibecoding-mcp\.local\.json$/m);
  assert.match(ignore, /^\.claude\/social-vibecoding-mcp\.local\.json\.lock$/m);
  assert.match(ignore, /^\.claude\/social-vibecoding-mcp\.local\.json\.lock\.\*$/m);
  assert.match(ignore, /^\.opencode\/opencode\.jsonc$/m);
  assert.match(ignore, /^\.opencode\/opencode\.jsonc\.lock$/m);
  assert.match(ignore, /^\.opencode\/opencode\.jsonc\.lock\.\*$/m);
});

test('authorization and token-management copy covers all configured coding agents', () => {
  const authorize = fs.readFileSync(path.join(root, 'public/cli-authorize.html'), 'utf8');
  const authorizeJs = fs.readFileSync(path.join(root, 'public/js/cli-authorize.js'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const source of [authorize, authorizeJs, settings]) {
    assert.match(source, /Codex/);
    assert.match(source, /Claude Code/);
    assert.match(source, /OpenCode/);
  }
  assert.match(settings, /CLI &amp; coding-agent access/);
});
