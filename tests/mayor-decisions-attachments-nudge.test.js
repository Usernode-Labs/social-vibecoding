// Tests for PR #729 steps 8-11:
//  - step 8: rolling session-decisions digest (buildDecisionsBlock,
//    maybeExtractSessionDecisions, renderEvictedRowForDigest,
//    llm.extractSessionDecisions/sanitizeDecisionBullet)
//  - step 9: persistent attachment index + get_attachment data tool
//    (buildAttachmentIndexBlock, GET_ATTACHMENT_TOOL, resolveGetAttachmentToolResult,
//    attachmentsSvc.buildAttachmentIndex)
//  - step 10: one-time dismissible Settings mayor-model nudge
//    (looksLikeMayorCorrection/MAYOR_CORRECTION_RE)
//  - step 11: spec-driven title/PR refresh (session-title.maybeTitleFromSpec,
//    llm.generateSessionTitleFromSpec, generatePrMetadata's spec-framing prompt)
//
// Run with: node --test tests/mayor-decisions-attachments-nudge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mayor-decisions-test-secret';

const sessions = require('../src/routes/sessions');
const llm = require('../src/services/llm');
const attachmentsSvc = require('../src/services/attachments');
const sessionTitles = require('../src/services/session-title');

const {
  buildDecisionsBlock,
  maybeExtractSessionDecisions,
  renderEvictedRowForDigest,
  GET_ATTACHMENT_TOOL,
  resolveGetAttachmentToolResult,
  buildAttachmentIndexBlock,
  DATA_TOOL_NAMES,
  dataToolStatusLine,
  looksLikeMayorCorrection,
  MAYOR_CORRECTION_RE,
} = sessions;

// ── step 8: buildDecisionsBlock ─────────────────────────────────────────

test('buildDecisionsBlock is empty for no digest, renders a heading otherwise', () => {
  assert.equal(buildDecisionsBlock(''), '');
  assert.equal(buildDecisionsBlock(null), '');
  assert.equal(buildDecisionsBlock('   '), '');

  const block = buildDecisionsBlock('- use Postgres, not SQLite\n- never touch auth.js');
  assert.match(block, /## Standing decisions/);
  assert.match(block, /use Postgres, not SQLite/);
  assert.match(block, /never touch auth\.js/);
});

// ── step 8: renderEvictedRowForDigest ───────────────────────────────────

test('renderEvictedRowForDigest labels user/assistant/cc rows distinctly', () => {
  assert.match(renderEvictedRowForDigest({ role: 'user', content: 'do the thing' }), /^USER: do the thing$/);
  assert.match(renderEvictedRowForDigest({ role: 'assistant', content: 'sure, on it' }), /^MAYOR: sure, on it$/);
  assert.match(
    renderEvictedRowForDigest({ role: 'system', metadata: { ccOutput: 'built X', ccOutcome: 'completed' } }),
    /^\[CODING AGENT COMPLETED\]: built X$/
  );
  assert.match(
    renderEvictedRowForDigest({ role: 'system', metadata: { ccOutput: 'nothing changed', ccOutcome: 'no_changes' } }),
    /^\[CODING AGENT RAN — NO CHANGES\]: nothing changed$/
  );
  assert.match(
    renderEvictedRowForDigest({ role: 'system', metadata: { ccOutput: 'boom', ccOutcome: 'error' } }),
    /^\[CODING AGENT FAILED\]: boom$/
  );
});

test('renderEvictedRowForDigest clips content to 2000 chars', () => {
  const long = 'x'.repeat(3000);
  const rendered = renderEvictedRowForDigest({ role: 'user', content: long });
  assert.equal(rendered.length, 'USER: '.length + 2000);
});

// ── step 8: maybeExtractSessionDecisions ────────────────────────────────

function withLlmStub(t, stub) {
  const origEnabled = llm.isEnabled;
  const origExtract = llm.extractSessionDecisions;
  if (stub.isEnabled) llm.isEnabled = stub.isEnabled;
  if (stub.extractSessionDecisions) llm.extractSessionDecisions = stub.extractSessionDecisions;
  t.after(() => {
    llm.isEnabled = origEnabled;
    llm.extractSessionDecisions = origExtract;
  });
}

function decisionsMockPool() {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
}

test('maybeExtractSessionDecisions no-ops when nothing evicted', async (t) => {
  let calls = 0;
  withLlmStub(t, { isEnabled: () => true, extractSessionDecisions: async () => { calls++; return { digest: 'x' }; } });
  const pool = decisionsMockPool();
  const session = { id: 1, decisions_watermark_id: 0, session_decisions_digest: null };
  const historyRaw = [{ id: 1, role: 'user', content: 'hi' }];
  const history = historyRaw; // nothing evicted — same rows kept
  await maybeExtractSessionDecisions(pool, session, historyRaw, history);
  assert.equal(calls, 0);
  assert.equal(pool.queries.length, 0);
});

test('maybeExtractSessionDecisions no-ops when llm is disabled', async (t) => {
  let calls = 0;
  withLlmStub(t, { isEnabled: () => false, extractSessionDecisions: async () => { calls++; return { digest: 'x' }; } });
  const pool = decisionsMockPool();
  const session = { id: 1, decisions_watermark_id: 0, session_decisions_digest: null };
  const historyRaw = [{ id: 1, role: 'user', content: 'hi' }, { id: 2, role: 'assistant', content: 'ok' }];
  const history = [{ id: 2, role: 'assistant', content: 'ok' }]; // row 1 evicted
  await maybeExtractSessionDecisions(pool, session, historyRaw, history);
  assert.equal(calls, 0);
  assert.equal(pool.queries.length, 0);
});

test('maybeExtractSessionDecisions distills evicted rows past the watermark and persists digest+watermark once', async (t) => {
  let receivedTurns = null;
  withLlmStub(t, {
    isEnabled: () => true,
    extractSessionDecisions: async ({ priorDigest, evictedTurns }) => {
      receivedTurns = evictedTurns;
      assert.equal(priorDigest, null);
      return { digest: '- use Postgres', decisions: ['use Postgres'] };
    },
  });
  const pool = decisionsMockPool();
  const session = { id: 7, decisions_watermark_id: 0, session_decisions_digest: null };
  const historyRaw = [
    { id: 1, role: 'user', content: 'use Postgres please' },
    { id: 2, role: 'assistant', content: 'sure' },
    { id: 3, role: 'user', content: 'latest turn' },
  ];
  const history = [{ id: 3, role: 'user', content: 'latest turn' }]; // rows 1,2 evicted
  await maybeExtractSessionDecisions(pool, session, historyRaw, history);

  assert.deepEqual(receivedTurns, ['USER: use Postgres please', 'MAYOR: sure']);
  const upd = pool.queries.find((q) => /UPDATE chat_sessions SET session_decisions_digest/.test(q.sql));
  assert.ok(upd, 'persists digest + watermark');
  assert.deepEqual(upd.params, ['- use Postgres', 2, 7]);
  assert.equal(session.session_decisions_digest, '- use Postgres');
  assert.equal(session.decisions_watermark_id, 2);
});

test('maybeExtractSessionDecisions only distills rows past the watermark (each batch fires once)', async (t) => {
  let receivedTurns = null;
  withLlmStub(t, {
    isEnabled: () => true,
    extractSessionDecisions: async ({ evictedTurns }) => { receivedTurns = evictedTurns; return { digest: 'd' }; },
  });
  const pool = decisionsMockPool();
  const session = { id: 7, decisions_watermark_id: 2, session_decisions_digest: '- prior' };
  const historyRaw = [
    { id: 1, role: 'user', content: 'already distilled' },
    { id: 2, role: 'assistant', content: 'already distilled too' },
    { id: 3, role: 'user', content: 'new evicted turn' },
  ];
  const history = []; // everything evicted this time
  await maybeExtractSessionDecisions(pool, session, historyRaw, history);
  assert.deepEqual(receivedTurns, ['USER: new evicted turn']);
});

// ── step 8: llm.extractSessionDecisions / sanitizeDecisionBullet ────────

test('sanitizeDecisionBullet collapses whitespace and hard-caps at 200 chars', () => {
  assert.equal(llm.sanitizeDecisionBullet('  use   Postgres  '), 'use Postgres');
  assert.equal(llm.sanitizeDecisionBullet(''), '');
  assert.equal(llm.sanitizeDecisionBullet(null), '');
  const long = llm.sanitizeDecisionBullet('x'.repeat(300));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

test('extractSessionDecisions throws when there are no evicted turns to distill', async () => {
  await assert.rejects(() => llm.extractSessionDecisions({ priorDigest: '', evictedTurns: [] }));
  await assert.rejects(() => llm.extractSessionDecisions({ priorDigest: '', evictedTurns: ['   '] }));
});

// ── step 9: buildAttachmentIndex / buildAttachmentIndexBlock ────────────

test('attachmentsSvc.buildAttachmentIndex is empty for no attachments, one line per attachment otherwise', () => {
  assert.equal(attachmentsSvc.buildAttachmentIndex([]), '');
  assert.equal(attachmentsSvc.buildAttachmentIndex(null), '');

  const index = attachmentsSvc.buildAttachmentIndex([
    { id: 'a1', filename: 'notes.txt', kind: 'text', sizeBytes: 512, meta: {} },
    { id: 'a2', filename: 'photo.png', kind: 'image', sizeBytes: 2048, meta: { width: 100, height: 200 } },
    { id: 'a3', filename: 'bundle.zip', kind: 'zip', sizeBytes: 4096, meta: { entryCount: 3 } },
  ]);
  assert.match(index, /- notes\.txt \(id a1, text, 512 B\)/);
  assert.match(index, /- photo\.png \(id a2, image, 2 KB, 100x200\)/);
  assert.match(index, /- bundle\.zip \(id a3, zip, 4 KB, 3 files\)/);
});

test('buildAttachmentIndexBlock is empty for no attachments, renders a heading otherwise', () => {
  assert.equal(buildAttachmentIndexBlock([]), '');
  const block = buildAttachmentIndexBlock([
    { id: 'a1', filename: 'notes.txt', kind: 'text', sizeBytes: 10, meta: {} },
  ]);
  assert.match(block, /## Session attachments/);
  assert.match(block, /get_attachment/);
  assert.match(block, /notes\.txt/);
});

// ── step 9: GET_ATTACHMENT_TOOL / resolveGetAttachmentToolResult ────────

test('get_attachment is a registered data tool requiring a string id', () => {
  assert.equal(DATA_TOOL_NAMES.has('get_attachment'), true);
  assert.equal(GET_ATTACHMENT_TOOL.name, 'get_attachment');
  assert.deepEqual(GET_ATTACHMENT_TOOL.input_schema.required, ['id']);
  assert.equal(GET_ATTACHMENT_TOOL.input_schema.properties.id.type, 'string');
});

test('dataToolStatusLine: get_attachment gets its own line', () => {
  assert.equal(dataToolStatusLine([{ name: 'get_attachment', input: { id: 'x' } }]), 'Looking up an attachment...');
});

function withAttachmentsStub(t, loadByIds) {
  const orig = attachmentsSvc.loadByIds;
  attachmentsSvc.loadByIds = loadByIds;
  t.after(() => { attachmentsSvc.loadByIds = orig; });
}

function attachmentMockPool(existsRow) {
  return {
    async query(sql) {
      if (/FROM chat_session_attachments WHERE id/.test(sql)) {
        return { rows: existsRow ? [{ id: existsRow }] : [] };
      }
      return { rows: [] };
    },
  };
}

test('resolveGetAttachmentToolResult rejects a malformed id without touching the DB', async () => {
  const pool = attachmentMockPool(null);
  const result = await resolveGetAttachmentToolResult(pool, 1, 'not-a-valid-id');
  assert.deepEqual(JSON.parse(result), { error: 'invalid attachment id' });
});

test('resolveGetAttachmentToolResult 404s an id that does not belong to this session', async () => {
  const id = 'a'.repeat(32);
  const pool = attachmentMockPool(null); // ownership check returns no rows
  const result = await resolveGetAttachmentToolResult(pool, 1, id);
  assert.deepEqual(JSON.parse(result), { error: 'attachment not found in this session' });
});

test('resolveGetAttachmentToolResult re-inlines a text attachment', async (t) => {
  const id = 'b'.repeat(32);
  withAttachmentsStub(t, async () => [{
    id, kind: 'text', filename: 'notes.txt', data: Buffer.from('hello world'),
  }]);
  const pool = attachmentMockPool(id);
  const result = await resolveGetAttachmentToolResult(pool, 1, id);
  assert.deepEqual(JSON.parse(result), { kind: 'text', filename: 'notes.txt', content: 'hello world' });
});

test('resolveGetAttachmentToolResult describes (not re-inlines) an image attachment', async (t) => {
  const id = 'c'.repeat(32);
  withAttachmentsStub(t, async () => [{
    id, kind: 'image', filename: 'photo.png', contentType: 'image/png', meta: { width: 10, height: 20 },
  }]);
  const pool = attachmentMockPool(id);
  const result = await resolveGetAttachmentToolResult(pool, 1, id);
  const parsed = JSON.parse(result);
  assert.equal(parsed.kind, 'image');
  assert.equal(parsed.filename, 'photo.png');
  assert.match(parsed.note, /cannot be re-displayed/);
  assert.match(parsed.note, new RegExp(id));
});

test('resolveGetAttachmentToolResult describes (not re-inlines) a zip/binary attachment', async (t) => {
  const id = 'd'.repeat(32);
  withAttachmentsStub(t, async () => [{ id, kind: 'zip', filename: 'bundle.zip' }]);
  const pool = attachmentMockPool(id);
  const result = await resolveGetAttachmentToolResult(pool, 1, id);
  const parsed = JSON.parse(result);
  assert.equal(parsed.kind, 'zip');
  assert.match(parsed.note, /cannot be inlined/);
});

// ── step 10: looksLikeMayorCorrection / MAYOR_CORRECTION_RE ─────────────

test('looksLikeMayorCorrection matches common correction phrasings at the start of the message', () => {
  assert.equal(looksLikeMayorCorrection('No, that is not what I wanted'), true);
  assert.equal(looksLikeMayorCorrection('nope, try again'), true);
  assert.equal(looksLikeMayorCorrection("that's not right"), true);
  assert.equal(looksLikeMayorCorrection("that's wrong"), true);
  assert.equal(looksLikeMayorCorrection('not what I asked for'), true);
  assert.equal(looksLikeMayorCorrection("don't build that"), true);
  assert.equal(looksLikeMayorCorrection('wrong approach'), true);
  assert.equal(looksLikeMayorCorrection('please undo that'), true);
  assert.equal(looksLikeMayorCorrection('revert that'), true);
  assert.equal(looksLikeMayorCorrection('why did you do this'), true);
  assert.equal(looksLikeMayorCorrection('you misunderstood me'), true);
});

test('looksLikeMayorCorrection does not false-positive on ordinary messages, including mid-sentence mentions', () => {
  assert.equal(looksLikeMayorCorrection('add a dark mode toggle'), false);
  assert.equal(looksLikeMayorCorrection('I think this is wrong sometimes but not here'), false);
  assert.equal(looksLikeMayorCorrection(''), false);
  assert.equal(looksLikeMayorCorrection(null), false);
  assert.equal(looksLikeMayorCorrection(undefined), false);
  assert.equal(looksLikeMayorCorrection('   '), false);
});

test('MAYOR_CORRECTION_RE is exported and matches the same cases as the wrapper', () => {
  assert.equal(MAYOR_CORRECTION_RE.test('no, stop'), true);
  assert.equal(MAYOR_CORRECTION_RE.test('sounds good, thanks'), false);
});

// ── step 11: session-title.maybeTitleFromSpec ───────────────────────────

function titleMockPool({ updateRowCount = 1 } = {}) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/UPDATE chat_sessions SET session_title/.test(sql)) return { rowCount: updateRowCount, rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('maybeTitleFromSpec no-ops when the session already has a PR (never clobbers a PR-owned title)', async () => {
  const pool = titleMockPool();
  const session = { id: 1, pr_number: 42, session_title: 'PR title' };
  const title = await sessionTitles.maybeTitleFromSpec({ pool, session, specTitle: 'New spec title', specContent: 'spec body' });
  assert.equal(title, null);
  assert.equal(pool.queries.length, 0);
  assert.equal(session.session_title, 'PR title');
});

test('maybeTitleFromSpec titles deterministically from the given specTitle — no LLM call', async () => {
  let llmCalls = 0;
  const origGen = llm.generateSessionTitleFromSpec;
  llm.generateSessionTitleFromSpec = async () => { llmCalls++; return { title: 'should not be used' }; };
  try {
    const pool = titleMockPool();
    const session = { id: 3, pr_number: null, session_title: 'Old title' };
    const events = [];
    const title = await sessionTitles.maybeTitleFromSpec({
      pool, session, specTitle: 'Dark mode toggle', specContent: 'full spec text',
      send: (type, data) => events.push({ type, data }),
    });
    assert.equal(title, 'Dark mode toggle');
    assert.equal(llmCalls, 0, 'deterministic H1 title needs no model call');
    assert.equal(session.session_title, 'Dark mode toggle');
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET session_title/.test(q.sql));
    assert.match(upd.sql, /pr_number IS NULL/);
    assert.deepEqual(upd.params, ['Dark mode toggle', 3]);
    assert.deepEqual(events, [{ type: 'session_titled', data: { sessionTitle: 'Dark mode toggle' } }]);
  } finally {
    llm.generateSessionTitleFromSpec = origGen;
  }
});

test('maybeTitleFromSpec falls back to the bounded Haiku call only when no specTitle is given, and only with an apiKey', async () => {
  let llmCalls = 0;
  const origGen = llm.generateSessionTitleFromSpec;
  llm.generateSessionTitleFromSpec = async ({ spec, apiKey }) => {
    llmCalls++;
    assert.equal(spec, 'full spec text');
    assert.equal(apiKey, 'sk-test');
    return { title: 'Haiku-derived title' };
  };
  try {
    const pool = titleMockPool();
    const session = { id: 4, pr_number: null, session_title: null };
    const title = await sessionTitles.maybeTitleFromSpec({
      pool, session, specTitle: null, specContent: 'full spec text', apiKey: 'sk-test',
    });
    assert.equal(title, 'Haiku-derived title');
    assert.equal(llmCalls, 1);
    assert.equal(session.session_title, 'Haiku-derived title');
  } finally {
    llm.generateSessionTitleFromSpec = origGen;
  }
});

test('maybeTitleFromSpec skips the Haiku fallback (and stays a no-op) when no apiKey is available', async () => {
  let llmCalls = 0;
  const origGen = llm.generateSessionTitleFromSpec;
  llm.generateSessionTitleFromSpec = async () => { llmCalls++; return { title: 'x' }; };
  try {
    const pool = titleMockPool();
    const session = { id: 5, pr_number: null, session_title: null };
    const title = await sessionTitles.maybeTitleFromSpec({
      pool, session, specTitle: null, specContent: 'full spec text', apiKey: null,
    });
    assert.equal(title, null);
    assert.equal(llmCalls, 0);
    assert.equal(pool.queries.length, 0);
  } finally {
    llm.generateSessionTitleFromSpec = origGen;
  }
});

test('maybeTitleFromSpec no-ops when the derived title is unchanged from the current one', async () => {
  const pool = titleMockPool();
  const session = { id: 6, pr_number: null, session_title: 'Dark mode toggle' };
  const title = await sessionTitles.maybeTitleFromSpec({ pool, session, specTitle: 'Dark mode toggle', specContent: 'x' });
  assert.equal(title, null);
  assert.equal(pool.queries.length, 0);
});

test('maybeTitleFromSpec resolves null (never throws) when the Haiku fallback fails', async () => {
  const origGen = llm.generateSessionTitleFromSpec;
  llm.generateSessionTitleFromSpec = async () => { throw new Error('boom'); };
  try {
    const pool = titleMockPool();
    const session = { id: 7, pr_number: null, session_title: null };
    const title = await sessionTitles.maybeTitleFromSpec({
      pool, session, specTitle: null, specContent: 'spec', apiKey: 'sk-test',
    });
    assert.equal(title, null);
    assert.equal(session.session_title, null);
  } finally {
    llm.generateSessionTitleFromSpec = origGen;
  }
});

test('maybeTitleFromSpec resolves null and touches nothing when losing the race to a PR-mirrored title', async () => {
  const pool = titleMockPool({ updateRowCount: 0 });
  const session = { id: 8, pr_number: null, session_title: 'Old title' };
  const title = await sessionTitles.maybeTitleFromSpec({ pool, session, specTitle: 'New title', specContent: 'x' });
  assert.equal(title, null);
  assert.equal(session.session_title, 'Old title');
});

// ── step 11: llm.generateSessionTitleFromSpec ───────────────────────────

test('generateSessionTitleFromSpec throws when the spec text is empty', async () => {
  await assert.rejects(() => llm.generateSessionTitleFromSpec({ spec: '', apiKey: null }), /LLM not initialized|Empty spec text/);
});

// ── step 11: generatePrMetadata leans on the spec's framing ─────────────

test("generatePrMetadata's system prompt instructs preferring the spec's framing over the literal first message", () => {
  // generatePrMetadata builds its own Anthropic client internally with no
  // seam to intercept the request without a network stub, so this asserts
  // directly on the prompt text baked into the function source — the same
  // text `activeClient.messages.create` sends as `system`.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/llm.js'), 'utf8');
  const fnStart = src.indexOf('async function generatePrMetadata');
  const fnBody = src.slice(fnStart, fnStart + 3000);
  assert.match(fnBody, /prefer ITS framing and terminology for the title/i);
  assert.match(fnBody, /lean on it for framing the title/i);
});
