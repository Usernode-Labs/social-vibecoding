'use strict';

// #2817: OpenRouter coding agents get a written design brief in every build
// prompt, and an OpenRouter scout settles the design in the spec. Claude
// prompts stay byte-identical, so both insertions are gated on the backend.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const prompts = require('../src/services/prompts');

const SESSIONS = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');

test('the design guidance loads and covers taste, UI/UX and coherence', () => {
  const guidance = prompts.getOpenRouterDesignGuidance();
  assert.match(guidance, /^==== UI DESIGN/);
  assert.match(guidance, /==== END UI DESIGN ====$/);
  assert.match(guidance, /native UI kit/, 'the app\'s own kit comes before anything invented');
  assert.match(guidance, /one primary action/i);
  assert.match(guidance, /same word for the same concept/, 'cross-element coherence is checked');
  assert.match(guidance, /empty state[\s\S]*loading state[\s\S]*error state/);
  // The Codex runner gives OpenRouter models text input only.
  assert.match(guidance, /browser_snapshot/);
  assert.doesNotMatch(guidance, /—/, 'no em dashes: the agent copies the voice it is given');
  assert.ok(guidance.length < 6000, 'short enough to ride in every build prompt');
});

test('the spec design brief asks for a plain-language Design subsection', () => {
  assert.match(prompts.OPENROUTER_SPEC_DESIGN_BRIEF, /"### Design" subsection/);
  assert.match(prompts.OPENROUTER_SPEC_DESIGN_BRIEF, /before any "### Questions"/,
    'questions stay last in the user-facing half');
  assert.match(prompts.OPENROUTER_SPEC_DESIGN_BRIEF, /Omit it for changes nobody sees/);
});

test('only OpenRouter build and scout prompts carry the design text', () => {
  assert.match(SESSIONS,
    /const openRouterDesignGuidance = isCodexSession \? getOpenRouterDesignGuidance\(\) : '';/);
  assert.match(SESSIONS, /run against this repo outside the harness\.\$\{personalFilesNote\}\$\{designGuidanceBlock\}/);
  assert.match(SESSIONS,
    /const scoutDesignBrief = isCodexSession \? `\\n- \$\{OPENROUTER_SPEC_DESIGN_BRIEF\}` : '';/);
  assert.match(SESSIONS, /so seeding is planned rather than improvised at build time\.\$\{scoutDesignBrief\}/);
});

test('an OpenRouter scout is told it reads through the shell and changes nothing', () => {
  assert.match(SESSIONS, /const scoutPlanModeLine = isCodexSession\s*\n\s*\? 'You are running in PLAN MODE: read and search the repository with read-only shell commands/);
  assert.match(SESSIONS, /: 'You are running in PLAN MODE: you can read files \(Read, Glob, Grep\) but you cannot edit, commit, or push anything\. Do not attempt to\.';/,
    'the Claude scout keeps its exact wording');
});
