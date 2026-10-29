// test:changed: always (every Postgres suite, for fixed-time waits; scripts/test-changed.js)
// tests/postgres-fixed-waits.test.js — a Postgres suite that sleeps "long
// enough" fails on a busy machine and passes on the race it meant to catch
// (#5912, #5872). The eight suites in #6018 now wait for the event with
// tests/lib/wait-for.js; this guard holds them at zero and stops any other
// Postgres suite from growing a new one. A wait that must stay a fixed time
// says so in a `// fixed wait: <reason>` comment on the line or directly
// above it. Reads files only, so it is cheap enough to run on every change.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
const BASELINE = path.join(__dirname, 'baselines', 'postgres-fixed-waits.json');
const REMEDY = 'wait for the event with tests/lib/wait-for.js, or add // fixed wait: <reason>';

const CALL = /(?<![\w.])(sleep|wait)\(\s*\d[\d_]*\s*\)/;
const TIMER = /\bsetTimeout\(.*,\s*\d[\d_]*\s*\)/;
const EXEMPT = /\/\/ fixed wait: \S/;

function isFixedWait(line) {
  return CALL.test(line) || TIMER.test(line);
}

// Every fixed wait in a suite's text, as `file:line`, less the ones carrying
// an exemption comment on the line itself or the line directly above it.
function fixedWaits(file, text) {
  const lines = text.split('\n');
  const found = [];
  lines.forEach((line, index) => {
    if (!isFixedWait(line)) return;
    if (EXEMPT.test(line) || (index > 0 && EXEMPT.test(lines[index - 1]))) return;
    found.push(`${path.basename(file)}:${index + 1}`);
  });
  return found;
}

const suites = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('-postgres.test.js')).sort();

test('the fixed-wait match tells a fixed wait from a named one', () => {
  assert.ok(isFixedWait('  await sleep(100);'));
  assert.ok(isFixedWait('  await wait(75);'));
  assert.ok(isFixedWait('    await new Promise((r) => setTimeout(r, 200));'));
  assert.ok(isFixedWait("      setTimeout(() => abort.abort(reason), 50);"));
  assert.ok(!isFixedWait('  await pg_sleep(100);'));
  assert.ok(!isFixedWait('  await setTimeout(r, ms);'));
  assert.ok(!isFixedWait('  await waitFor(() => ready, { timeoutMs: 5000 });'));
  assert.ok(!isFixedWait('  await sleep(ms);'));
  const kept = '  // fixed wait: the claim count is measured over this window\n  await sleep(300);';
  assert.deepEqual(fixedWaits('/tests/x-postgres.test.js', kept), []);
  assert.deepEqual(fixedWaits('/tests/x-postgres.test.js', '  await sleep(300);'), ['x-postgres.test.js:1']);
});

test('the Postgres suites hold at their recorded count of fixed waits', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const problems = [];

  for (const file of Object.keys(baseline)) {
    if (!fs.existsSync(path.join(TESTS_DIR, path.basename(file)))) {
      problems.push(`${file} is in the baseline but no longer exists: drop its entry`);
    }
  }

  for (const suite of suites) {
    const allowed = baseline[`tests/${suite}`] || 0;
    const found = fixedWaits(suite, fs.readFileSync(path.join(TESTS_DIR, suite), 'utf8'));
    if (found.length > allowed) {
      problems.push(`${suite} has ${found.length} fixed waits, allowed ${allowed}: ${found.join(', ')}. ${REMEDY}`);
    } else if (found.length < allowed) {
      problems.push(`${suite} has ${found.length} fixed waits, baseline says ${allowed}: lower the baseline to ${found.length} (tests/baselines/postgres-fixed-waits.json)`);
    }
  }

  assert.deepEqual(problems, []);
});
