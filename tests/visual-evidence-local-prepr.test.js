'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const contract = require('../src/services/visual-evidence-plan');
const verifier = require('../scripts/local-visual-evidence/verify-local-plan');

const BASE = 'ab9fcb8756c1fa265d48599151026d3655fc2393';
const HEAD = 'd80779231ebb6ed1990a69ca6ac8fccc09374a37';

test('pre-PR verification requires exact different commits and both intent and plan', () => {
  const args = ['--base', BASE, '--head', HEAD, '--intent', 'intent.json', '--plan', 'plan.json'];
  const parsed = verifier.parseArgs(args);
  assert.equal(parsed.baseSha, BASE);
  assert.equal(parsed.headSha, HEAD);
  assert.throws(() => verifier.parseArgs(args.slice(0, -2)), /--plan is required/);
  assert.throws(() => verifier.parseArgs(['--base', BASE, '--head', BASE,
    '--intent', 'intent.json', '--plan', 'plan.json']), /different commits/);
  assert.throws(() => verifier.parseArgs(['--base', 'main', ...args.slice(2)]), /40-character/);
});

test('pre-PR verification refuses a plan that changes the declared claim before starting Docker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-prepr-'));
  try {
    const plan = require('../scripts/local-visual-evidence/historical-2548-plan.json');
    const intent = contract.semanticIntentFromPlan(plan);
    intent.stories[0].claim = 'A different visual claim';
    const planFile = path.join(dir, 'plan.json');
    const intentFile = path.join(dir, 'intent.json');
    await fs.writeFile(planFile, JSON.stringify(plan));
    await fs.writeFile(intentFile, JSON.stringify(intent));
    await assert.rejects(verifier.verifyLocalPlan({
      baseSha: BASE, headSha: HEAD, planFile, intentFile,
      envFile: path.join(dir, 'missing.env'), outputRoot: dir,
    }), /changes the declared visual evidence intent/);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['intent.json', 'plan.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
