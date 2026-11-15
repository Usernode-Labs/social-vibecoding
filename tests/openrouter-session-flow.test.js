// Coherence guards for the OpenRouter provider's name where a person reads it.
// Settings' key card is named "OpenRouter", never "Codex", and a turn that a
// restart caught and recovered says which agent ran it rather than a
// hard-coded "Claude Code" (services/turn-recovery.js, moved out of server.js
// unchanged).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const settings = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'),
  'utf8',
);
// With what a turn's recovery runs, moved out of server.js unchanged
// (services/turn-recovery.js).
const server = fs.readFileSync(
  path.join(__dirname, '..', 'server.js'),
  'utf8',
) + fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'turn-recovery.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test('settings and restart recovery use OpenRouter as the user-facing provider name', () => {
  const settingsCopy = between(
    settings,
    '_normalizeOpenRouterCopy() {',
    '_setOrStatus(text, kind)',
  );
  assert.match(settingsCopy, /heading\.textContent = 'OpenRouter'/);
  // The description is a catalog message; the copy people read is its English.
  assert.match(settingsCopy, /intro\.textContent = tr\('settings:openrouter\.intro'\);/);
  const { message } = require('./lib/platform-i18n');
  const intro = message('settings:openrouter.intro');
  assert.match(intro, /included OpenRouter key/);
  assert.match(intro, /your own OpenRouter key/);
  assert.doesNotMatch(settingsCopy, /Codex/);
  assert.doesNotMatch(intro, /Codex/);

  const recoveryIdentity = between(
    server,
    'function recoveredAgentIdentity',
    'async function adoptOrphanWorker',
  );
  assert.match(recoveryIdentity, /isOpenRouter \? 'OpenRouter' : 'Claude Code'/);
  const recoveredFinalize = between(
    server,
    'async function finalizeRecoveredTurn({',
    'async function resumeDetachedTurn(',
  );
  assert.match(recoveredFinalize, /recoveryAgent\.name/);
  assert.doesNotMatch(recoveredFinalize, /'Claude Code (?:finished|made no changes|did not complete)'/);
});
