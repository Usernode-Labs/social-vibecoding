// Unit tests for the shared-transcript sanitiser
// (src/services/transcript-share.js).
//
// This is the whole privacy contract of the read-only transcript surface, so
// the tests are written adversarially: each one names a thing that must NOT
// escape, and the last one is a DENY-BY-DEFAULT regression guard — a
// metadata key nobody has thought of yet must be dropped rather than
// forwarded. Inverting the allowlists into blocklists would pass every
// specific test below and fail that one; that's the point.
//
// Run with: node --test tests/transcript-sanitize.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeTranscriptMessage,
  sanitizeTranscript,
  MAX_TRANSCRIPT_MESSAGES,
  buildForkFollowUpMessage,
  FORK_FOLLOWUP_REPLIES,
} = require('../src/services/transcript-share');

// A row shaped like a real chat_session_messages SELECT.
function row(overrides = {}) {
  return {
    id: 7,
    session_id: 42,
    role: 'assistant',
    content: 'Here is what I changed.',
    model: 'claude-opus-5',
    token_count: 1234,
    cost_cents: 5.4321,
    metadata: {},
    created_at: '2026-07-01T10:00:00Z',
    ...overrides,
  };
}

test('keeps the renderable row fields', () => {
  const out = sanitizeTranscriptMessage(row());
  assert.strictEqual(out.id, 7);
  assert.strictEqual(out.role, 'assistant');
  assert.strictEqual(out.content, 'Here is what I changed.');
  assert.strictEqual(out.model, 'claude-opus-5');
  assert.strictEqual(out.created_at, '2026-07-01T10:00:00Z');
});

test('drops cost and token counts (a reader must not see the owner spend)', () => {
  const out = sanitizeTranscriptMessage(row());
  assert.ok(!('cost_cents' in out), 'cost_cents dropped');
  assert.ok(!('token_count' in out), 'token_count dropped');
  // session_id isn't secret, but it isn't on the allowlist either — proving
  // the row shape is built from ROW_FIELDS rather than by deletion.
  assert.ok(!('session_id' in out), 'unlisted columns dropped');
});

test('drops ccLog — raw agent stderr can carry repo/env contents', () => {
  const out = sanitizeTranscriptMessage(row({
    role: 'system',
    content: 'Claude Code log',
    metadata: { ccLog: 'SECRET_TOKEN=hunter2\n at /home/node/app/server.js' },
  }));
  assert.deepStrictEqual(out.metadata, {});
  assert.ok(!JSON.stringify(out).includes('hunter2'), 'no ccLog content anywhere in the row');
});

test('drops platformIssueDraft — an owner-only action card', () => {
  const out = sanitizeTranscriptMessage(row({
    role: 'system',
    metadata: { platformIssueDraft: { body: 'draft', status: 'pending', msgId: 9 } },
  }));
  assert.ok(!('platformIssueDraft' in out.metadata));
});

test('drops interactive composer affordances (suggestions / quickReplies)', () => {
  const out = sanitizeTranscriptMessage(row({
    metadata: { suggestions: ['yes', 'no'], quickReplies: ['Build it'] },
  }));
  assert.ok(!('suggestions' in out.metadata));
  assert.ok(!('quickReplies' in out.metadata));
});

test('keeps the renderable metadata: progress log, agent summary, spec preview, inheritedFrom', () => {
  const out = sanitizeTranscriptMessage(row({
    role: 'system',
    metadata: {
      progressLog: ['Reading app-view.js', 'Editing the card renderer'],
      ccOutput: 'Split the card into two rows.',
      ccOutcome: 'success',
      durationMs: 240000,
      changesReady: true,
      prNumber: 931,
      prUrl: 'https://github.com/x/y/pull/931',
      specPreview: '# Spec\n\n- do the thing',
      specVersion: 3,
      specLines: 12,
      inheritedFrom: 55,
      agentBackend: 'codex_openrouter',
      agentModel: 'openai/gpt-5.3-codex',
    },
  }));
  assert.deepStrictEqual(out.metadata.progressLog, ['Reading app-view.js', 'Editing the card renderer']);
  assert.strictEqual(out.metadata.ccOutput, 'Split the card into two rows.');
  assert.strictEqual(out.metadata.specVersion, 3);
  assert.strictEqual(out.metadata.specPreview, '# Spec\n\n- do the thing');
  assert.strictEqual(out.metadata.inheritedFrom, 55);
  assert.strictEqual(out.metadata.prNumber, 931);
  assert.strictEqual(out.metadata.changesReady, true);
  assert.strictEqual(out.metadata.agentBackend, 'codex_openrouter');
  assert.strictEqual(out.metadata.agentModel, 'openai/gpt-5.3-codex');
});

test('attachments keep name/kind/size and LOSE the id (no reachable bytes URL)', () => {
  const out = sanitizeTranscriptMessage(row({
    role: 'user',
    metadata: {
      attachments: [
        { id: 'a'.repeat(32), filename: 'mockup.png', kind: 'image', sizeBytes: 4096, data: 'BYTES' },
        { id: 'b'.repeat(32), filename: 'notes.txt', kind: 'text', sizeBytes: 120 },
      ],
    },
  }));
  assert.strictEqual(out.metadata.attachments.length, 2);
  assert.deepStrictEqual(out.metadata.attachments[0], {
    filename: 'mockup.png', kind: 'image', sizeBytes: 4096,
  });
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('a'.repeat(32)), 'attachment id is not reachable');
  assert.ok(!serialized.includes('BYTES'), 'attachment bytes are not reachable');
});

test('a non-object attachment entry is dropped rather than passed through', () => {
  const out = sanitizeTranscriptMessage(row({
    metadata: { attachments: ['../../etc/passwd', null, { filename: 'ok.png', kind: 'image' }] },
  }));
  assert.strictEqual(out.metadata.attachments.length, 1);
  assert.strictEqual(out.metadata.attachments[0].filename, 'ok.png');
});

test('an empty attachments array leaves no key behind', () => {
  const out = sanitizeTranscriptMessage(row({ metadata: { attachments: [] } }));
  assert.ok(!('attachments' in out.metadata));
});

test('DENY BY DEFAULT: an unknown future metadata key is dropped', () => {
  // The regression guard. If someone later adds a metadata field carrying
  // private data and this file still passes, the allowlist has been turned
  // into a blocklist somewhere.
  const out = sanitizeTranscriptMessage(row({
    metadata: {
      ccOutput: 'kept',
      someFutureFieldNobodyReviewed: { apiKey: 'sk-live-danger' },
      billingPath: 'byok',
    },
  }));
  assert.deepStrictEqual(Object.keys(out.metadata), ['ccOutput']);
  assert.ok(!JSON.stringify(out).includes('sk-live-danger'));
});

test('never mutates or aliases the input row', () => {
  // The fork path holds the raw row alongside the sanitised copy, so an
  // aliased metadata object would let the unsanitised version be written.
  const input = row({ metadata: { ccOutput: 'summary', ccLog: 'secret' } });
  const out = sanitizeTranscriptMessage(input);
  assert.strictEqual(input.metadata.ccLog, 'secret', 'input untouched');
  assert.notStrictEqual(out.metadata, input.metadata, 'metadata is a fresh object');
  out.metadata.ccOutput = 'mutated';
  assert.strictEqual(input.metadata.ccOutput, 'summary', 'no shared reference');
});

test('tolerates missing / malformed metadata', () => {
  assert.deepStrictEqual(sanitizeTranscriptMessage(row({ metadata: null })).metadata, {});
  assert.deepStrictEqual(sanitizeTranscriptMessage(row({ metadata: undefined })).metadata, {});
  assert.deepStrictEqual(sanitizeTranscriptMessage(row({ metadata: 'nope' })).metadata, {});
  assert.strictEqual(sanitizeTranscriptMessage(null), null);
  assert.strictEqual(sanitizeTranscriptMessage(undefined), null);
});

test('sanitizeTranscript maps a list and drops unusable rows', () => {
  const out = sanitizeTranscript([row({ id: 1 }), null, row({ id: 2 }), 'garbage']);
  assert.deepStrictEqual(out.map((m) => m.id), [1, 2]);
  assert.deepStrictEqual(sanitizeTranscript(null), []);
  assert.deepStrictEqual(sanitizeTranscript('nope'), []);
});

// ── Fork follow-up copy ─────────────────────────────────────────────────
//
// Lives in this service (not routes/sessions.js) so the staging fixture in
// db/migrate.js seeds the identical text. Both call sites are pinned here.

test('the fork follow-up names the owner, the branch, and the memory caveat', () => {
  const msg = buildForkFollowUpMessage({
    owner_username: 'alice',
    session_title: 'Readable cards',
    spec_md: '# Spec',
  });
  assert.match(msg, /alice's dev chat \("Readable cards"\)/);
  assert.match(msg, /your own branch, forked off theirs/);
  assert.match(msg, /Their session is untouched/);
  // Load-bearing: a fork does NOT inherit the agent's CC volume, so the new
  // owner must be told the model only knows the transcript.
  assert.match(msg, /not the coding agent's own memory of that work/);
  // A spec came across, so it's pointed at.
  assert.match(msg, /Open the spec viewer/);
});

test('the fork follow-up degrades gracefully with no title, owner or spec', () => {
  const msg = buildForkFollowUpMessage({ branch_name: 'dev/them-1' });
  assert.match(msg, /another user's dev chat \("dev\/them-1"\)/);
  assert.doesNotMatch(msg, /Open the spec viewer/, 'no spec → no spec sentence');
  assert.doesNotThrow(() => buildForkFollowUpMessage(null));
  assert.doesNotThrow(() => buildForkFollowUpMessage({}));
});

test('the fork follow-up does NOT reuse the auto-session clone prefix', () => {
  // DevChat._markInheritedMessages falls back to matching that prefix only
  // when no row carries metadata.inheritedFrom; fork rows all carry it, so
  // reusing the string here would just be misleading copy.
  const msg = buildForkFollowUpMessage({ owner_username: 'alice' });
  assert.doesNotMatch(msg, /^This session was cloned from an auto session/);
});

test('the fork pill set stays within the quick-reply invariant', () => {
  assert.ok(Array.isArray(FORK_FOLLOWUP_REPLIES));
  assert.ok(FORK_FOLLOWUP_REPLIES.length >= 1 && FORK_FOLLOWUP_REPLIES.length <= 3);
  for (const r of FORK_FOLLOWUP_REPLIES) {
    assert.strictEqual(typeof r, 'string');
    assert.ok(r.length > 0 && r.length <= 80, `"${r}" is within the 80-char pill limit`);
  }
});

test('the transcript row cap is a sane ceiling', () => {
  // Production's largest shared session is ~110 messages; the cap exists as
  // headroom, so a value at or below that would silently truncate real chats.
  assert.ok(MAX_TRANSCRIPT_MESSAGES >= 200, 'cap leaves headroom over real transcripts');
});
