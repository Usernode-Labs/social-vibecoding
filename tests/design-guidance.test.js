// test:changed: when src/prompts/design-guidance.md (the guidance this suite pins, read through services/prompts.js; scripts/test-changed.js)
'use strict';

// #2817: every coding agent builds with the same written design guidance
// (src/prompts/design-guidance.md, read through services/prompts.js).
// Claude and OpenRouter stay in parity; the one difference is how the agent
// checks its work, which follows whether the model running the turn takes
// images (#3426: an OpenRouter model does when OpenRouter's catalog says so).
// Where Homeroom bot's builds and scouts carry it is
// tests/homeroom-bot-build-design.test.js's subject.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const prompts = require('../src/services/prompts');

test('the design guidance covers taste, UI/UX and coherence', () => {
  const guidance = prompts.getDesignGuidance();
  assert.match(guidance, /^==== UI DESIGN/);
  assert.match(guidance, /==== END UI DESIGN ====$/);
  assert.match(guidance, /native UI kit/, 'the app\'s own kit comes before anything invented');
  assert.match(guidance, /one primary action/i);
  // A filled button only where the view's job is an action: reading or browsing may have none.
  assert.match(guidance, /- One job per view, and one primary \(filled\) button when that job is an action; a screen for reading or browsing may have none\. Everything else is secondary or plain\./);
  assert.match(guidance, /confirm: one primary action where the screen's job is an action \(a screen for reading or browsing may have none\);/);
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
    // #3737 Rec2: a new app's record is its CLAUDE.md's "## Design"
    // section; an app whose first version came before it has a note.
    assert.match(guidance, /If the app's `CLAUDE\.md` has a "## Design" section \(or a `Design:` note under "App-specific conventions"\), that is this app's look: its accent, neutrals, type, spacing and signature element\. Follow it/);
  }
});

test('an OpenRouter turn reads images exactly when its runtime says the catalog lists them', () => {
  // The same flag the worker turns into AGENT_MODEL_SUPPORTS_IMAGES, so the
  // self-check and the runner never disagree about what the model can see.
  assert.equal(prompts.runtimeReadsImages({ agentModelMetadata: { supportsImages: true } }), true);
  for (const ctx of [
    { agentModelMetadata: { supportsImages: false } },
    { agentModelMetadata: { supportsImages: null } },
    { agentModelMetadata: { supportsImages: 'true' } },
    { agentModelMetadata: {} },
    {},
    null,
    undefined,
  ]) {
    assert.equal(prompts.runtimeReadsImages(ctx), false, JSON.stringify(ctx));
  }
  const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'worker.js'), 'utf8');
  assert.match(workerSrc, /safeEnv\.AGENT_MODEL_SUPPORTS_IMAGES = agentModelMetadata\?\.supportsImages === true \? '1' : '';/);
});

test('one accent, and the colours an app\'s "## Design" section gives its subject are not accents (7 Oct 2026)', () => {
  const flat = prompts.getDesignGuidance().replace(/\s+/g, ' ');
  assert.match(flat, /- One accent colour, kept for the primary action and status\. Colours the app's "## Design" section gives its subject \(a map's water and parks, team colours, card suits, traffic-light statuses\) are not accents: use them as that section says\./);
  // Its examples are none of the App bench's starter briefs.
  assert.doesNotMatch(flat, /bread|proofing|RSS|feed reader|ear train|voxel|tier list|ranking/i);
});
