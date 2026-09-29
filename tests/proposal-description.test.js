// Tests for src/services/proposal-description.js (#2820): the
// "==== DESCRIPTION ====" block an OpenRouter coding agent ends each turn
// with, and the cleaned-up fallback used when a turn gave none. Also pins
// that the OpenRouter build prompt asks for the block, and that the turn
// path peels it off and hands it to the PR metadata.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const subject = require('../src/services/proposal-description');
const testingNotes = require('../src/services/testing-notes');

test('extract removes the block and returns its text', () => {
  const text = [
    'Done. Committed as e1d33fa.',
    '',
    '==== DESCRIPTION ====',
    'Adds a dark-mode switch to the settings page.',
    '',
    'The choice is remembered on this device.',
    '==== END DESCRIPTION ====',
  ].join('\n');
  const out = subject.extract(text);
  assert.equal(out.cleanedText, 'Done. Committed as e1d33fa.');
  assert.equal(
    out.description,
    'Adds a dark-mode switch to the settings page.\n\nThe choice is remembered on this device.',
  );
});

test('extract works on the text left after the testing block is peeled off', () => {
  const text = [
    'Done.',
    '==== DESCRIPTION ====',
    'Adds a sticky header.',
    '==== END DESCRIPTION ====',
    '',
    '==== TESTING ====',
    'path: /',
    '1. Scroll down.',
    '==== END TESTING ====',
  ].join('\n');
  const testing = testingNotes.extract(text);
  assert.equal(testing.testingPath, '/');
  const out = subject.extract(testing.cleanedText);
  assert.equal(out.description, 'Adds a sticky header.');
  assert.equal(out.cleanedText, 'Done.');
});

test('extract: last block wins, a missing END runs to the end, empty is null', () => {
  const twice = '==== DESCRIPTION ====\nold\n==== END DESCRIPTION ====\n\n==== DESCRIPTION ====\nnew\n==== END DESCRIPTION ====';
  assert.equal(subject.extract(twice).description, 'new');
  assert.equal(subject.extract('Hi\n==== DESCRIPTION ====\nOpen ended').description, 'Open ended');
  assert.equal(subject.extract('Hi\n==== DESCRIPTION ====\n\n==== END DESCRIPTION ====').description, null);
  assert.deepEqual(subject.extract('No block here.'), { cleanedText: 'No block here.', description: null });
  assert.deepEqual(subject.extract(null), { cleanedText: '', description: null });
});

test('extract clips an over-long description', () => {
  const long = 'x'.repeat(subject.DESCRIPTION_MAX + 50);
  const out = subject.extract(`==== DESCRIPTION ====\n${long}\n==== END DESCRIPTION ====`);
  assert.equal(out.description.length, subject.DESCRIPTION_MAX);
  assert.ok(out.description.endsWith('…'));
});

test('cleanTurnMessage drops leading filler and commit bookkeeping', () => {
  assert.equal(
    subject.cleanTurnMessage('Done. The header now stays pinned. Committed as e1d33fa on the branch.'),
    'The header now stays pinned.',
  );
  assert.equal(
    subject.cleanTurnMessage('All done!\n\nAdded a search box.\nCommit 3f2a9c1b pushed to feat/x.'),
    'Added a search box.',
  );
  assert.equal(subject.cleanTurnMessage('Done buttons now line up.'), 'Done buttons now line up.');
  assert.equal(subject.cleanTurnMessage('Committed as e1d33fa.'), '');
  assert.equal(subject.cleanTurnMessage(undefined), '');
  const long = subject.cleanTurnMessage('y'.repeat(subject.FALLBACK_MAX + 10));
  assert.equal(long.length, subject.FALLBACK_MAX);
});

test('the OpenRouter build prompt requires a whole-change description block', () => {
  const sessions = require('../src/routes/sessions');
  const guidance = sessions.OPENROUTER_PROPOSAL_DESCRIPTION_GUIDANCE;
  assert.match(guidance, /^==== DESCRIPTION ====$/m);
  assert.match(guidance, /^==== END DESCRIPTION ====$/m);
  assert.match(guidance, /ENTIRE change so far/);
  assert.match(guidance, /REPLACES the previous description/);
  assert.match(guidance, /BEFORE the testing block/);
  // The prompt's own example must parse with the real parser.
  assert.ok(subject.extract(guidance).description);

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');
  assert.match(
    src,
    /\$\{isCodexSession \? `\$\{OPENROUTER_PROPOSAL_DESCRIPTION_GUIDANCE\}\\n` : ''\}\$\{buildGuidance\.testingGuidance\}/,
    'only OpenRouter build prompts carry it, just ahead of the testing block',
  );
});

test('the turn path peels the block off and hands it to the PR metadata', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');
  assert.match(src, /const described = proposalDescription\.extract\(testing\.cleanedText\);/);
  assert.match(src, /const ccText = described\.cleanedText \|\| turnDescription \|\| '';/);
  assert.match(src, /proposalDescription: turnDescription,/);
  assert.match(src, /\.\.\.\(turnDescription \? \{ proposalDescription: turnDescription \} : \{\}\),/);
});
