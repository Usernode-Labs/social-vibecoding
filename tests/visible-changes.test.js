'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shots = require('../src/services/visible-changes');
const { intent, motionIntent } = require('./fixtures/shots');

test('semantic intent accepts a bounded visible-change story and fills safe defaults', () => {
  const parsed = shots.parseIntent(intent());
  assert.equal(parsed.version, 1);
  assert.equal(parsed.stories[0].intent.animation, 'steps');
  assert.equal(parsed.stories[0].intent.baseState, 'present');
  assert.deepEqual(parsed.stories[0].viewports[0], { name: 'desktop', width: 1280, height: 800 });
});

test('semantic intent can require the isolated full-admin shots persona', () => {
  const candidate = intent();
  candidate.stories[0].persona = 'full_admin';
  assert.equal(shots.parseIntent(candidate).stories[0].persona, 'full_admin');
});

test('a change may be declared for a guest, a visitor who is not signed in', () => {
  const candidate = intent();
  candidate.stories[0].persona = 'guest';
  assert.equal(shots.parseIntent(candidate).stories[0].persona, 'guest');
  candidate.stories[0].persona = 'anonymous';
  assert.equal(shots.safeParseIntent(candidate).ok, false);
});

test('every surface that declares or reports a change names the same personas', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const listed = `[${shots.PERSONAS.map((persona) => `'${persona}'`).join(', ')}]`;
  assert.deepEqual(shots.PERSONAS, ['member', 'read_only_admin', 'full_admin', 'guest']);
  for (const file of ['worker/visible-changes-mcp.js', 'src/cli/main.js', 'src/services/mcp-tools.js']) {
    assert.ok(read(file).includes(`persona: z.enum(${listed})`), `${file} lists ${listed}`);
  }
  assert.ok(read('src/services/shots-view.js').includes(`${listed}.includes(claim?.persona)`));
});

// No persona is a child app's creator or one of its admins: an app is told
// who is signed in, never their role in it (shots-identities.js). Every
// surface an author declares a change through says so.
test('every surface that declares a change says no persona holds a role in an app built on Homeroom', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // The work order is an array of quoted lines: join them back into prose.
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    .replace(/',\s*'\s*/g, ' ').replace(/\\'/g, "'").replace(/\s+/g, ' ');
  for (const file of ['worker/visible-changes-mcp.js', 'src/cli/main.js', 'src/services/mcp-tools.js',
    'src/services/external-agent-tasks.js']) {
    assert.match(read(file), /On an app built on Homeroom (?:no persona is|none of them is) the app.s creator or one of its admins/,
      `${file} says no persona is the app's creator or admin`);
    assert.match(read(file), /a screen it keeps for particular accounts cannot be shot/, file);
  }
});

test('new UI may explicitly label base absence without treating missing media as proof', () => {
  const candidate = intent();
  candidate.stories[0].intent.baseState = 'not_present';
  assert.equal(shots.parseIntent(candidate).stories[0].intent.baseState, 'not_present');
  candidate.stories[0].intent.baseState = 'missing_image_means_absent';
  assert.equal(shots.safeParseIntent(candidate).ok, false);
});

test('no-impact intent carries a rationale but no manufactured story', () => {
  const parsed = shots.parseIntent({
    version: 1, impact: 'none', rationale: 'Only server-side retry accounting changed.', stories: [],
  });
  assert.equal(parsed.impact, 'none');
  assert.deepEqual(parsed.stories, []);
  assert.throws(() => shots.parseIntent(intent({ impact: 'none' })), /No stories are allowed/);
});

test('visible impact requires a story and stories/viewports are capped', () => {
  assert.throws(() => shots.parseIntent(intent({ stories: [] })), /At least one shots story/);
  assert.throws(() => shots.parseIntent(intent({ stories: Array.from({ length: 4 }, (_, i) => ({
    ...intent().stories[0], id: `story-${i}`,
  })) })), /at most 3/i);
  assert.throws(() => shots.parseIntent(intent({ stories: [{
    ...intent().stories[0],
    viewports: [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'mobile', width: 390, height: 844 },
      { name: 'tablet', width: 768, height: 1024 },
    ],
  }] })), /at most 2/i);
});

test('story ids and viewport names are unique slugs', () => {
  const duplicateStory = intent();
  duplicateStory.stories.push(structuredClone(duplicateStory.stories[0]));
  assert.throws(() => shots.parseIntent(duplicateStory), /Story ids must be unique/);

  const duplicateViewport = intent();
  duplicateViewport.stories[0].viewports.push({ name: 'desktop', width: 390, height: 844 });
  assert.throws(() => shots.parseIntent(duplicateViewport), /Viewport names must be unique/);

  const badSlug = intent();
  badSlug.stories[0].id = 'Invite Suggestions';
  const result = shots.safeParseIntent(badSlug);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors[0], {
    path: ['stories', '0', 'id'],
    message: 'Use a lowercase slug with letters, digits, hyphens or underscores',
  });
});

test('viewports stay within the phone-to-desktop bounds a browser can render', () => {
  for (const viewport of [
    { name: 'narrow', width: 319, height: 800 },
    { name: 'wide', width: 1921, height: 800 },
    { name: 'short', width: 1280, height: 479 },
    { name: 'tall', width: 1280, height: 1441 },
    { name: 'fractional', width: 1280.5, height: 800 },
    { name: 'desktop', width: 1280, height: 800, deviceScaleFactor: 2 },
  ]) {
    const candidate = intent();
    candidate.stories[0].viewports = [viewport];
    assert.equal(shots.safeParseIntent(candidate).ok, false, JSON.stringify(viewport));
  }
  const edges = intent();
  edges.stories[0].viewports = [
    { name: 'smallest', width: 320, height: 480 },
    { name: 'largest', width: 1920, height: 1440 },
  ];
  assert.equal(shots.safeParseIntent(edges).ok, true);
});

test('a motion change requires a motion declaration', () => {
  const candidate = intent();
  candidate.stories[0].intent.animation = 'motion';
  assert.throws(() => shots.parseIntent(candidate), /requires impact "motion"/);
  assert.equal(shots.parseIntent(motionIntent()).stories[1].intent.animation, 'motion');
});

test('paths are relative and cannot smuggle an origin or credential', () => {
  for (const value of [
    'https://evil.example/x', '//evil.example/x', 'settings', '/\\evil', '/%2f%2fevil',
    '/settings?token=secret', '/settings?password=demo',
    `/open/${encodeURIComponent('eyJabcdefgh.abcdefgh.abcdefgh')}`,
    '/invite/person@company.com',
  ]) {
    const candidate = intent();
    candidate.stories[0].intent.startPath = value;
    assert.equal(shots.safeParseIntent(candidate).ok, false, value);
  }
  assert.equal(shots.validRelativePath('/settings?tab=profile#name'), true);
});

test('credentials and real email addresses are recognised, fixture addresses are not', () => {
  for (const value of [
    'Bearer abcdefghijklmnop', 'ghp_abcdefghijklmnop', 'person@company.com',
    'eyJabcdefgh.abcdefgh.abcdefgh', '-----BEGIN RSA PRIVATE KEY-----',
  ]) {
    assert.equal(shots.credentialLike(value), true, value);
    const candidate = intent();
    candidate.stories[0].intent.startPath = `/open/${encodeURIComponent(value)}`;
    assert.equal(shots.safeParseIntent(candidate).ok, false, value);
  }
  assert.equal(shots.credentialLike('reviewer@example.test'), false);
  const fixture = intent();
  fixture.stories[0].intent.startPath = '/invite/reviewer@example.test';
  assert.equal(shots.safeParseIntent(fixture).ok, true);
});

test('shot-list hints are optional, bounded guidance for the shots agent', () => {
  assert.equal(Object.hasOwn(shots.parseIntent(intent()).stories[0].intent, 'hints'), false);

  const candidate = intent();
  candidate.stories[0].intent.hints = {
    setup: 'Create a list from the + button first',
    expectText: ['Suggestions'],
    focusTarget: { by: 'role', role: 'dialog', name: 'Invite member' },
  };
  assert.deepEqual(shots.parseIntent(candidate).stories[0].intent.hints, {
    setup: 'Create a list from the + button first',
    expectText: ['Suggestions'],
    // Locators fill the same exact-match default everywhere they appear.
    focusTarget: { by: 'role', role: 'dialog', name: 'Invite member', exact: true },
  });

  for (const hints of [
    { expectText: [] },
    { expectText: Array.from({ length: 6 }, (_, i) => `Text ${i}`) },
    { expectText: ['x'.repeat(121)] },
    { setup: 'x'.repeat(501) },
    { setup: 'Two\nlines' },
    { script: 'document.body.click()' },
  ]) {
    const bad = intent();
    bad.stories[0].intent.hints = hints;
    assert.equal(shots.safeParseIntent(bad).ok, false, JSON.stringify(hints));
  }
});

test('a hinted focus target is a bounded locator, never xpath or the page root', () => {
  for (const focusTarget of [
    { by: 'xpath', value: '//dialog' },
    { by: 'css', value: 'body' },
    { by: 'css', value: ' * ' },
    { by: 'testId', value: 'x'.repeat(shots.MAX_LOCATOR_VALUE + 1) },
    { by: 'role', role: 'x'.repeat(65) },
  ]) {
    const candidate = intent();
    candidate.stories[0].intent.hints = { focusTarget };
    assert.equal(shots.safeParseIntent(candidate).ok, false, JSON.stringify(focusTarget));
  }

  const xpath = intent();
  xpath.stories[0].intent.hints = { focusTarget: { by: 'xpath', value: '//dialog' } };
  assert.deepEqual(shots.safeParseIntent(xpath).errors[0], {
    path: ['stories', '0', 'intent', 'hints', 'focusTarget'],
    message: `Expected a locator with "by" set to one of: ${shots.LOCATOR_KINDS.join(', ')}`,
  });
});

test('validation diagnostics do not copy unrecognized submitted field names', () => {
  const candidate = intent();
  candidate.stories[0].intent.hints = { 'private-token': 'secret-value' };
  const result = shots.safeParseIntent(candidate);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Unexpected field/);
  assert.doesNotMatch(JSON.stringify(result.errors), /private-token|secret-value/);
});

test('controlled failure paths are exact same-origin API GET paths', () => {
  for (const path of ['/outside', '/api/list#fragment', '/api/*',
    'https://example.test/api/list', '/api/list?token=secret']) {
    const candidate = intent();
    candidate.stories[0].intent.controlledFailurePath = path;
    assert.equal(shots.safeParseIntent(candidate).ok, false, path);
  }
  const candidate = intent();
  candidate.stories[0].intent.controlledFailurePath = '/api/list?item=one';
  assert.equal(shots.safeParseIntent(candidate).ok, false);
  candidate.stories[0].intent.steps.unshift(shots.CONTROLLED_FAILURE_LABEL);
  assert.equal(shots.safeParseIntent(candidate).ok, true);
});

test('a controlled failure must lead its steps with the reviewer-visible label', () => {
  const candidate = intent();
  candidate.stories[0].intent.controlledFailurePath = '/api/lists/demo';
  const result = shots.safeParseIntent(candidate);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors[0].path, ['stories', '0', 'intent', 'steps', '0']);
  assert.match(result.errors[0].message, /Controlled test: deliberately block the declared API GET on both revisions\./);

  // The label anywhere but first does not count.
  candidate.stories[0].intent.steps.push(shots.CONTROLLED_FAILURE_LABEL);
  assert.equal(shots.safeParseIntent(candidate).ok, false);
  candidate.stories[0].intent.steps = [shots.CONTROLLED_FAILURE_LABEL, 'Open Members'];
  assert.equal(shots.parseIntent(candidate).stories[0].intent.controlledFailurePath, '/api/lists/demo');
});

test('needsClip asks for clips only for a motion change', () => {
  const parsed = shots.parseIntent(motionIntent());
  assert.equal(shots.needsClip(parsed.stories[0]), false);
  assert.equal(shots.needsClip(parsed.stories[1]), true);
  for (const animation of ['none', 'steps']) {
    assert.equal(shots.needsClip({ intent: { animation } }), false, animation);
  }
  assert.equal(shots.needsClip(undefined), false);
  assert.equal(shots.needsClip({}), false);
});

test('clips are recorded at the motion screens\' own size', () => {
  const raw = motionIntent();
  const phone = { name: 'phone', width: 390, height: 844 };
  const desktop = { name: 'desktop', width: 1280, height: 800 };
  const withScreens = (screens) => shots.parseIntent({
    ...raw, stories: raw.stories.map((story, index) => (index === 1 ? { ...story, viewports: screens } : story)),
  });
  // A phone clip at a desktop size would be a phone in the corner of grey.
  assert.equal(shots.clipSize(withScreens([phone])), '390x844');
  assert.equal(shots.clipSize(withScreens([desktop])), '1280x800');
  assert.equal(shots.clipSize(withScreens([phone, desktop])), '1280x844', 'the largest of several');
  // Only motion changes count; without one, nothing is recorded.
  const still = shots.parseIntent({ ...raw, stories: [raw.stories[0]] });
  assert.equal(shots.clipSize(still), null);
  assert.equal(shots.clipSize(null), null);
});

test('the replay plan contract is gone from the declaration module', () => {
  for (const name of ['parseReplayPlan', 'safeParseReplayPlan', 'planHash', 'semanticIntentFromPlan',
    'replayPlanFromIntent', 'parseAuthorPlanSubmission', 'containsRelativePointer']) {
    assert.equal(Object.hasOwn(shots, name), false, name);
  }
});
