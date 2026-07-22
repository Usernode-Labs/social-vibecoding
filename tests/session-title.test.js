// Tests for #249 — meaningful default session names.
//
//  - llm.parseSessionTitleText: tolerant parsing (JSON shape, raw text,
//    fences/quotes), sanitization, length cap, throws on empty.
//  - services/session-title: first-message hook fires only when both
//    session_title and pr_number are unset; success persists with the
//    `pr_number IS NULL` guard and emits session_titled; failures
//    resolve null and touch nothing (never throw); the turn-end refresh
//    gathers the full request history + live spec.
//  - services/pr-metadata: both PR UPDATE statements mirror pr_title
//    into session_title.
//
// Run with: node --test tests/session-title.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const llmReal = require('../src/services/llm');

// ---- parseSessionTitleText ----

test('parseSessionTitleText accepts the JSON shape', () => {
  assert.equal(llmReal.parseSessionTitleText('{"title": "Session naming defaults"}'), 'Session naming defaults');
});

test('parseSessionTitleText accepts fenced JSON', () => {
  assert.equal(
    llmReal.parseSessionTitleText('```json\n{"title": "Fix login redirect"}\n```'),
    'Fix login redirect'
  );
});

test('parseSessionTitleText accepts plain text and strips quotes/fences/trailing period', () => {
  assert.equal(llmReal.parseSessionTitleText('Leaderboard pagination'), 'Leaderboard pagination');
  assert.equal(llmReal.parseSessionTitleText('"Leaderboard pagination."'), 'Leaderboard pagination');
  assert.equal(llmReal.parseSessionTitleText('```\nLeaderboard pagination\n```'), 'Leaderboard pagination');
});

test('parseSessionTitleText collapses whitespace and newlines', () => {
  assert.equal(llmReal.parseSessionTitleText('  Fix   session\nnaming  '), 'Fix session naming');
});

test('parseSessionTitleText hard-caps at 256 chars', () => {
  const long = 'x'.repeat(400);
  assert.equal(llmReal.parseSessionTitleText(long).length, 256);
});

test('parseSessionTitleText throws on empty/unusable input', () => {
  assert.throws(() => llmReal.parseSessionTitleText(''));
  assert.throws(() => llmReal.parseSessionTitleText('   '));
  assert.throws(() => llmReal.parseSessionTitleText('"."'));
});

// ---- session-title service ----

// Stub ./llm and ./limits in require.cache, then force-load the subject.
function loadServiceWithStubs({ onGenerate, spends = [] }) {
  const llmPath = require.resolve('../src/services/llm');
  const limitsPath = require.resolve('../src/services/limits');
  const subjectPath = require.resolve('../src/services/session-title');
  const orig = {
    llm: require.cache[llmPath],
    limits: require.cache[limitsPath],
    subject: require.cache[subjectPath],
  };

  require.cache[llmPath] = {
    exports: {
      generateSessionTitle: async (args) => onGenerate(args),
      estimateCostCents: () => 0.01,
    },
    loaded: true, id: llmPath, filename: llmPath, paths: orig.llm ? orig.llm.paths : [],
  };
  require.cache[limitsPath] = {
    exports: { recordSpend: async (...a) => { spends.push(a); } },
    loaded: true, id: limitsPath, filename: limitsPath, paths: orig.limits ? orig.limits.paths : [],
  };
  delete require.cache[subjectPath];
  const subject = require('../src/services/session-title');

  const restore = () => {
    if (orig.llm) require.cache[llmPath] = orig.llm; else delete require.cache[llmPath];
    if (orig.limits) require.cache[limitsPath] = orig.limits; else delete require.cache[limitsPath];
    delete require.cache[subjectPath];
    if (orig.subject) require.cache[subjectPath] = orig.subject;
  };
  return { subject, restore };
}

function mockPool({ updateRowCount = 1, userRows = [], specMd = '' } = {}) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/UPDATE chat_sessions SET session_title/.test(sql)) return { rowCount: updateRowCount, rows: [] };
      if (/FROM chat_session_messages/.test(sql)) return { rows: userRows };
      if (/SELECT spec_md FROM chat_sessions/.test(sql)) return { rows: [{ spec_md: specMd }] };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('headlessTitle derives "#N · title" and truncates to 256', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    assert.equal(subject.headlessTitle(249, 'Session naming should default to meaningful identifiers'),
      '#249 · Session naming should default to meaningful identifiers');
    assert.equal(subject.headlessTitle(7, '  spaced \n out  '), '#7 · spaced out');
    assert.equal(subject.headlessTitle(7, 'x'.repeat(400)).length, 256);
    // Degraded fetch (no title) and bogus numbers -> null, branch fallback.
    assert.equal(subject.headlessTitle(7, ''), null);
    assert.equal(subject.headlessTitle(7, null), null);
    assert.equal(subject.headlessTitle(null, 'title'), null);
    assert.equal(subject.headlessTitle(0, 'title'), null);
  } finally {
    restore();
  }
});

// ---- deriveFromRequest (token-optimization: deterministic, LLM-free) ----

test('deriveFromRequest takes the first non-empty line and upper-cases it', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    assert.equal(subject.deriveFromRequest('fix the session naming please'), 'Fix the session naming please');
    assert.equal(subject.deriveFromRequest('\n\n  add a dark mode toggle\nmore detail'), 'Add a dark mode toggle');
  } finally {
    restore();
  }
});

test('deriveFromRequest strips code/URLs/markdown and trims to the first sentence', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    assert.equal(subject.deriveFromRequest('## Add `useAuth()` hook. Then wire it up.'), 'Add useAuth() hook');
    assert.equal(subject.deriveFromRequest('See https://example.com/x for the redirect bug'), 'See for the redirect bug');
  } finally {
    restore();
  }
});

test('deriveFromRequest cuts to a word boundary near the cap and returns "" when empty', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const long = subject.deriveFromRequest('word '.repeat(40), { maxChars: 20 });
    assert.ok(long.length <= 20, `expected <=20, got ${long.length}: ${long}`);
    assert.ok(!/\s$/.test(long), 'no trailing whitespace');
    assert.equal(subject.deriveFromRequest(''), '');
    assert.equal(subject.deriveFromRequest('   \n  '), '');
    assert.equal(subject.deriveFromRequest('```\n```'), '');
  } finally {
    restore();
  }
});

test('maybeTitleFirstMessage titles a fresh session deterministically — no LLM, no spend', async () => {
  const spends = [];
  let calls = 0;
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => { calls++; return { title: 'should not be used' }; },
    spends,
  });
  try {
    const pool = mockPool();
    const session = { id: 5, session_title: null, pr_number: null };
    const events = [];
    const title = await subject.maybeTitleFirstMessage({
      pool, session, message: 'fix the session naming please',
      userId: 3, apiKey: null, send: (type, data) => events.push({ type, data }),
    });

    assert.equal(title, 'Fix the session naming please');
    assert.equal(calls, 0, 'no LLM call — titling is deterministic now');
    assert.equal(session.session_title, 'Fix the session naming please');
    // The persist is guarded so neither a PR-mirrored nor an existing
    // title can be clobbered.
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET session_title/.test(q.sql));
    assert.match(upd.sql, /pr_number IS NULL/);
    assert.match(upd.sql, /session_title IS NULL/);
    assert.deepEqual(upd.params, ['Fix the session naming please', 5]);
    assert.deepEqual(events, [{ type: 'session_titled', data: { sessionTitle: 'Fix the session naming please' } }]);
    // No debit — no model call happened.
    assert.equal(spends.length, 0);
  } finally {
    restore();
  }
});

test('maybeTitleFirstMessage skips when the session already has a title or a PR', async () => {
  let calls = 0;
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => { calls++; return { title: 'x' }; } });
  try {
    const pool = mockPool();
    assert.equal(await subject.maybeTitleFirstMessage({
      pool, session: { id: 1, session_title: 'Already named', pr_number: null }, message: 'hi',
    }), null);
    assert.equal(await subject.maybeTitleFirstMessage({
      pool, session: { id: 2, session_title: null, pr_number: 42 }, message: 'hi',
    }), null);
    assert.equal(calls, 0, 'no LLM call when title or PR already exists');
    assert.equal(pool.queries.length, 0, 'no DB writes either');
  } finally {
    restore();
  }
});

test('maybeTitleFirstMessage resolves null and touches nothing when nothing is derivable', async () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const pool = mockPool();
    const session = { id: 9, session_title: null, pr_number: null };
    const events = [];
    // A message that reduces to empty (only a code fence) yields no title.
    const title = await subject.maybeTitleFirstMessage({
      pool, session, message: '```\n```', userId: 1, send: (t) => events.push(t),
    });
    assert.equal(title, null);
    assert.equal(session.session_title, null, 'session left untouched');
    assert.equal(events.length, 0, 'no event emitted');
    assert.equal(pool.queries.length, 0, 'no UPDATE attempted');
  } finally {
    restore();
  }
});

test('losing the race to a PR-mirrored title emits nothing', async () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // rowCount 0 = the guarded UPDATE matched nothing (PR landed meanwhile).
    const pool = mockPool({ updateRowCount: 0 });
    const session = { id: 9, session_title: null, pr_number: null };
    const events = [];
    const title = await subject.maybeTitleFirstMessage({
      pool, session, message: 'do the thing', send: (t) => events.push(t),
    });
    assert.equal(title, null);
    assert.equal(session.session_title, null);
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
});

test('refreshFromHistory feeds the full request history + live spec to the LLM', async () => {
  const captured = [];
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async (args) => { captured.push(args); return { title: 'Fix session naming defaults', usage: undefined, model: 'claude-haiku-4-5' }; },
  });
  try {
    const pool = mockPool({
      userRows: [{ content: "something's off with naming" }, { content: 'yes, default the titles' }],
      specMd: '# Spec: session naming',
    });
    const session = { id: 5, session_title: 'Old vague title', pr_number: null };
    const events = [];
    const title = await subject.refreshFromHistory({
      pool, session, userId: 3, send: (type, data) => events.push({ type, data }),
    });
    assert.equal(title, 'Fix session naming defaults');
    assert.deepEqual(captured[0].requests, ["something's off with naming", 'yes, default the titles']);
    assert.deepEqual(captured[0].specs, ['# Spec: session naming']);
    assert.equal(session.session_title, 'Fix session naming defaults');
    assert.deepEqual(events, [{ type: 'session_titled', data: { sessionTitle: 'Fix session naming defaults' } }]);
  } finally {
    restore();
  }
});

// ---- applyPrMetadata mirrors pr_title into session_title ----

// Same stub shape as tests/pr-metadata.test.js.
function loadPrMetadataWithStubs({ githubCalls }) {
  const llmPath = require.resolve('../src/services/llm');
  const ghPath = require.resolve('../src/services/github');
  const subjectPath = require.resolve('../src/services/pr-metadata');
  const orig = { llm: require.cache[llmPath], gh: require.cache[ghPath], subject: require.cache[subjectPath] };

  require.cache[llmPath] = {
    exports: {
      isEnabled: () => true,
      estimateCostCents: () => 0,
      generatePrMetadata: async () => ({ title: 'PR title', body: 'Body', usage: undefined, model: 'claude-haiku-4-5' }),
    },
    loaded: true, id: llmPath, filename: llmPath, paths: orig.llm ? orig.llm.paths : [],
  };
  require.cache[ghPath] = {
    exports: {
      createPR: async (owner, repo, opts) => { githubCalls.push({ type: 'create', opts }); return { number: 42, html_url: 'https://example/pr/42' }; },
      updatePR: async (owner, repo, num, opts) => { githubCalls.push({ type: 'update', num, opts }); },
    },
    loaded: true, id: ghPath, filename: ghPath, paths: orig.gh ? orig.gh.paths : [],
  };
  delete require.cache[subjectPath];
  const subject = require('../src/services/pr-metadata');
  const restore = () => {
    if (orig.llm) require.cache[llmPath] = orig.llm; else delete require.cache[llmPath];
    if (orig.gh) require.cache[ghPath] = orig.gh; else delete require.cache[ghPath];
    delete require.cache[subjectPath];
    if (orig.subject) require.cache[subjectPath] = orig.subject;
  };
  return { subject, restore };
}

function prMetadataMockPool() {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM chat_session_specs/i.test(sql)) return { rows: [] };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return { rows: [{ spec_md: '', linked_issues: [], pr_linked_issues_applied: [], testing_md: null, testing_path: null, pr_testing_applied: null }] };
      }
      if (/FROM chat_session_messages/i.test(sql)) return { rows: [{ role: 'user', content: 'x', metadata: {} }] };
      return { rows: [] };
    },
  };
}

test('the create-PR UPDATE mirrors pr_title into session_title', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ githubCalls });
  try {
    const pool = prMetadataMockPool();
    const session = { id: 1, branch_name: 'feat/x', pr_number: null, session_title: 'Early haiku title' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'create');
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_number/.test(q.sql));
    assert.match(upd.sql, /session_title = \$3/, 'create-path UPDATE writes session_title');
    assert.equal(upd.params[2], 'PR title');
    assert.equal(session.session_title, 'PR title', 'in-memory session mirrors too');
  } finally {
    restore();
  }
});

test('the update-PR UPDATE mirrors pr_title into session_title', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ githubCalls });
  try {
    const pool = prMetadataMockPool();
    const session = { id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u', pr_title: 'old', session_title: 'old' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'update');
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_title/.test(q.sql));
    assert.match(upd.sql, /session_title = \$1/, 'update-path UPDATE writes session_title');
    assert.equal(upd.params[0], 'PR title');
    assert.equal(session.session_title, 'PR title');
  } finally {
    restore();
  }
});
