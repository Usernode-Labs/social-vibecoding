'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const view = require('../src/services/visual-evidence-view');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const ARTIFACT = 'd'.repeat(32);

function session(overrides = {}) {
  return {
    id: 42,
    source: 'native',
    reviewed_head_sha: HEAD,
    visual_evidence_state: 'verified',
    visual_evidence_detail: {
      impact: 'ui',
      rationale: 'The dialog changed.',
      headSha: HEAD,
    },
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    state: 'verified',
    required: true,
    claims: [{
      id: 'dialog', claim: 'The dialog shows suggestions.', persona: 'member',
      viewports: ['desktop'], steps: ['Open dialog'], baseState: 'present', animation: 'none',
    }],
    baseSha: BASE,
    headSha: HEAD,
    failureCode: null,
    failureReason: null,
    repairAvailable: false,
    planHash: 'e'.repeat(64),
    replayCount: 2,
    repairCount: 1,
    relativePointer: true,
    verifiedReason: 'The paired images show the claimed state.',
    artifactSummary: [{
      id: ARTIFACT, storyId: 'dialog', viewport: 'desktop', side: 'head',
      variant: 'focus', media: 'png', contentType: 'image/png', bytes: 120,
    }],
    ...overrides,
  };
}

test('verified evidence exposes only authenticated artifact metadata for the exact head', () => {
  const result = view.serialize(run(), session(), 'demo-app', HEAD);
  assert.equal(result.state, 'verified');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].url,
    `/api/apps/demo-app/proposals/42/evidence/${ARTIFACT}`);
  assert.equal(Object.hasOwn(result.artifacts[0], 'data'), false);
  assert.equal(result.claims[0].baseState, 'present');
  assert.equal(result.replayCount, 2);
  assert.equal(result.repairCount, 1);
  assert.equal(result.relativePointer, true);
});

test('a newer head makes the whole set stale and suppresses every artifact', () => {
  const result = view.serialize(run(), session({ reviewed_head_sha: OTHER }), 'demo-app', OTHER);
  assert.equal(result.state, 'stale');
  assert.equal(result.failureCode, 'superseded');
  assert.deepEqual(result.artifacts, []);
  assert.match(result.failureReason, /newer proposal revision/i);
});

test('pending, failed, and malformed artifact rows never leak media URLs', () => {
  for (const state of ['planned', 'failed', 'reviewing']) {
    const result = view.serialize(run({ state }), session({ visual_evidence_state: state }), 'demo-app', HEAD);
    assert.deepEqual(result.artifacts, [], state);
  }
  assert.deepEqual(view.cleanArtifacts([{ ...run().artifactSummary[0], id: '../secret' }], {
    slug: 'demo-app', sessionId: 42, verified: true,
  }), []);
});

test('snapshot serialization is truthful before a durable run exists', () => {
  const result = view.fromSnapshot(session({
    visual_evidence_state: 'planned',
    visual_evidence_detail: {
      required: true, impact: 'ui', rationale: 'Visible change', headSha: HEAD,
      claims: [{
        id: 'new-screen', claim: 'A new route is available.', persona: 'member',
        viewports: ['mobile'], steps: ['Open the route'], baseState: 'not_present', animation: 'none',
      }],
    },
  }), HEAD);
  assert.equal(result.state, 'planned');
  assert.equal(result.claims[0].baseState, 'not_present');
  assert.deepEqual(result.artifacts, []);
});
