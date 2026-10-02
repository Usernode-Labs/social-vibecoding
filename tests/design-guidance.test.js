'use strict';

// #2817: every coding agent builds with the same written design guidance,
// and every scout settles the design in the spec. Claude and OpenRouter stay
// in parity; the one difference is how the agent checks its work, because
// OpenRouter models get text input only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const prompts = require('../src/services/prompts');
const { buildCodingAgentConventionsContext } = require('../src/routes/sessions');

const SESSIONS = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');

test('the design guidance covers taste, UI/UX and coherence', () => {
  const guidance = prompts.getDesignGuidance();
  assert.match(guidance, /^==== UI DESIGN/);
  assert.match(guidance, /==== END UI DESIGN ====$/);
  assert.match(guidance, /native UI kit/, 'the app\'s own kit comes before anything invented');
  assert.match(guidance, /one primary action/i);
  assert.match(guidance, /same word for the same concept/, 'cross-element coherence is checked');
  assert.match(guidance, /empty state[\s\S]*loading state[\s\S]*error state/);
  assert.doesNotMatch(guidance, /\{\{/, 'no template token survives');
  assert.doesNotMatch(guidance, /—/, 'no em dashes: the agent copies the voice it is given');
  assert.ok(guidance.length < 6000, 'short enough to ride with every build');
});

test('only the self-check differs, by whether the model reads images', () => {
  const images = prompts.getDesignGuidance({ readsImages: true });
  const text = prompts.getDesignGuidance({ readsImages: false });
  assert.match(images, /browser_take_screenshot/);
  assert.doesNotMatch(images, /browser_snapshot/);
  assert.match(text, /you read text, not images/);
  assert.match(text, /browser_snapshot/);
  const rules = (doc) => doc.slice(0, doc.indexOf('Checking your work:'));
  assert.equal(rules(images), rules(text), 'every rule before the self-check is shared');
});

test('#3737: the self-check walks both looks, and every build follows the app\'s recorded look', () => {
  for (const readsImages of [true, false]) {
    const guidance = prompts.getDesignGuidance({ readsImages });
    const check = guidance.slice(guidance.indexOf('Checking your work:'));
    assert.match(check, /in the light and the dark look \(add `\?un-theme=light`, then `\?un-theme=dark`, to the URL; just the one look when the app's `CLAUDE\.md` declares a single fixed look\)/);
    assert.match(check, /text and controls readable in each look/);
    assert.match(check, /including its empty and error states/);
    assert.match(guidance, /Both looks: every new app has a light and a dark look that follow the viewer's Homeroom theme\./);
    assert.match(guidance, /Only an app whose `CLAUDE\.md` declares one fixed look, or an older app built with one look, keeps a single look\./,
      'no drive-by conversion of an app built with one look');
    assert.match(guidance, /If the app's `CLAUDE\.md` has a `Design:` note \(under "App-specific conventions"\), that is this app's look: its accent, neutrals, type, spacing and signature element\. Follow it/);
  }
});

test('hosted Claude carries the guidance once as system context; local and Codex inline', () => {
  const designGuidance = 'SENTINEL design rule';
  const hosted = buildCodingAgentConventionsContext({ conventions: 'rules', designGuidance });
  assert.match(hosted.systemPrompt, /==== END PLATFORM CONVENTIONS ====\n\nSENTINEL design rule$/);
  assert.doesNotMatch(hosted.promptBlock, /SENTINEL design rule/);
  assert.match(hosted.promptBlock, /The UI design guidance is supplied\nwith them\./);

  for (const options of [{ runLocally: true }, { isCodexSession: true }]) {
    const inline = buildCodingAgentConventionsContext({ ...options, conventions: 'rules', designGuidance });
    assert.equal(inline.systemPrompt, null);
    assert.match(inline.promptBlock, /==== END PLATFORM CONVENTIONS ====\n\nSENTINEL design rule$/);
  }

  const bare = buildCodingAgentConventionsContext({ conventions: 'rules' });
  assert.doesNotMatch(bare.promptBlock, /design guidance/, 'no guidance, no pointer to it');
});

test('every build and scout gets the design text, whatever the backend', () => {
  assert.match(SESSIONS, /const designGuidance = getDesignGuidance\(\{ readsImages: !isCodexSession \}\);/);
  assert.match(SESSIONS, /runLocally, isCodexSession, harness, designGuidance,/,
    'every transport the build renders carries it');
  assert.match(SESSIONS, /const scoutDesignBrief = `\\n- \$\{SPEC_DESIGN_BRIEF\}`;/);
  assert.match(SESSIONS, /so seeding is planned rather than improvised at build time\.\$\{scoutDesignBrief\}/);
  assert.match(prompts.SPEC_DESIGN_BRIEF, /"### Design" subsection/);
  assert.match(prompts.SPEC_DESIGN_BRIEF, /before any "### Questions"/,
    'questions stay last in the user-facing half');
  assert.match(prompts.SPEC_DESIGN_BRIEF, /Omit it for changes nobody sees/);
});

test('an OpenRouter scout is told it reads through the shell and changes nothing', () => {
  // #3296: only when Codex runs it; a model the platform runs in Claude Code
  // gets Claude's tools and the Claude wording below.
  assert.match(SESSIONS, /const scoutPlanModeLine = isCodexSession && agentIdentity\.harness !== 'claude'\s*\n\s*\? 'You are running in PLAN MODE: read and search the repository with read-only shell commands/);
  assert.match(SESSIONS, /: 'You are running in PLAN MODE: you can read files \(Read, Glob, Grep\) but you cannot edit, commit, or push anything\. Do not attempt to\.';/,
    'the Claude scout keeps its exact wording');
});
