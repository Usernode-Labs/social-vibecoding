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
//  - #1949 OpenRouter sessions: deterministicTitle is the shared,
//    LLM-free trim; titleFromFirstMessage names an untitled, PR-less
//    session from its first user message with no model call and no
//    spend, and an OpenRouter PR title equals that session name.
//  - #2500 the issue-card scaffolding: parseIssueSeed peels
//    `Please implement GitHub issue #N: "…"` off, so the deterministic
//    name (session AND pull request) is the issue title and the helper
//    model is handed that title as its issueTitle input; titleAtTurnEnd is
//    the shared turn-end hook, which now falls back to that deterministic
//    name when no payer resolves instead of leaving the branch name; and a
//    hand-chosen title outranks every generated one.
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

test('maybeTitleFirstMessage titles a fresh session and emits session_titled', async () => {
  const captured = [];
  const spends = [];
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async (args) => { captured.push(args); return { title: 'Session naming defaults', usage: { input_tokens: 10, output_tokens: 5 }, model: 'claude-haiku-4-5' }; },
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

    assert.equal(title, 'Session naming defaults');
    assert.deepEqual(captured[0].requests, ['fix the session naming please']);
    assert.equal(session.session_title, 'Session naming defaults');
    // The persist is guarded so a PR-mirrored title can't be clobbered.
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET session_title/.test(q.sql));
    assert.match(upd.sql, /pr_number IS NULL/);
    assert.match(upd.sql, /proposed_pr_title IS NULL/,
      'a later automatic title cannot replace an author-chosen proposal title');
    assert.deepEqual(upd.params, ['Session naming defaults', 5]);
    assert.deepEqual(events, [{ type: 'session_titled', data: { sessionTitle: 'Session naming defaults' } }]);
    // The Haiku call was debited to the requesting user.
    assert.equal(spends.length, 1);
    assert.equal(spends[0][1], 3);
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

// #2500: an unreachable helper model used to leave the session showing its
// branch name forever, which is exactly the case the issue-title fallback
// exists for. The failure is still non-fatal and still never throws — it
// just leaves a readable name behind now.
test('a failed generation falls back to the deterministic name (never throws)', async () => {
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => { throw new Error('LLM down'); },
  });
  try {
    const pool = mockPool();
    const session = { id: 9, session_title: null, pr_number: null };
    const events = [];
    const title = await subject.maybeTitleFirstMessage({
      pool, session, message: 'do the thing', userId: 1, send: (t, d) => events.push(t),
    });
    assert.equal(title, 'do the thing');
    assert.equal(session.session_title, 'do the thing');
    assert.deepEqual(events, ['session_titled']);
    assert.equal(pool.queries.length, 1, 'one guarded UPDATE, no model call');
  } finally {
    restore();
  }
});

test('a failed generation on an issue-started session falls back to the ISSUE TITLE', async () => {
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => { throw new Error('LLM down'); },
  });
  try {
    const pool = mockPool();
    const session = { id: 9, session_title: null, pr_number: null };
    const title = await subject.maybeTitleFirstMessage({
      pool,
      session,
      message: 'Please implement GitHub issue #2496: "Add claimed issues to workshop current work".'
        + '\n\nThe workshop only lists proposals today.\n\n'
        + 'Open a PR that closes this issue (include "Closes #2496" so it links and closes the issue on merge).',
      userId: 1,
      send: () => {},
    });
    assert.equal(title, 'Add claimed issues to workshop current work');
  } finally {
    restore();
  }
});

// A refresh must never trade a name the model already produced for the
// deterministic trim just because THIS call failed.
test('a failed refresh leaves an already-named session alone', async () => {
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => { throw new Error('LLM down'); },
  });
  try {
    const pool = mockPool({ userRows: [{ content: 'do the thing' }] });
    const session = { id: 9, session_title: 'Paginated leaderboard rows', pr_number: null };
    const events = [];
    const title = await subject.refreshFromHistory({
      pool, session, userId: 1, send: (t) => events.push(t),
    });
    assert.equal(title, null);
    assert.equal(session.session_title, 'Paginated leaderboard rows', 'session left untouched');
    assert.equal(events.length, 0, 'no event emitted');
    assert.equal(
      pool.queries.filter((q) => /UPDATE chat_sessions SET session_title/.test(q.sql)).length,
      0,
      'no UPDATE attempted',
    );
  } finally {
    restore();
  }
});

test('losing the race to a PR-mirrored title emits nothing', async () => {
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => ({ title: 'Slow early title', usage: undefined, model: 'claude-haiku-4-5' }),
  });
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

// ---- #2500: the issue card's kickoff scaffolding ----

const ISSUE_SEED = 'Please implement GitHub issue #2496: "Add claimed issues to workshop current work".'
  + '\n\nThe workshop lists proposals but not the issues people have claimed.\n\n'
  + 'Open a PR that closes this issue (include "Closes #2496" so it links and closes the issue on merge).';

test('parseIssueSeed splits the issue card seed and ignores anything else', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const seed = subject.parseIssueSeed(ISSUE_SEED);
    assert.equal(seed.number, 2496);
    assert.equal(seed.title, 'Add claimed issues to workshop current work');
    assert.equal(seed.body, 'The workshop lists proposals but not the issues people have claimed.');
    // An issue with no title still parses; the body carries the meaning.
    assert.equal(subject.parseIssueSeed('Please implement GitHub issue #7: "".\n\nbody').title, '');
    // Anything a person wrote themselves is left alone.
    assert.equal(subject.parseIssueSeed('Please implement the login fix'), null);
    assert.equal(subject.parseIssueSeed(''), null);
    assert.equal(subject.parseIssueSeed(null), null);
  } finally {
    restore();
  }
});

test('deterministicTitle names an issue-started session after its ISSUE, not the instruction', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // The reported #2500 title, before: `Please implement GitHub issue 2496:
    // "Add claimed issues to workshop cur…` — the `#` eaten by the markdown
    // class, the whole thing cut at 72.
    assert.equal(
      subject.deterministicTitle(ISSUE_SEED),
      'Add claimed issues to workshop current work',
    );
    assert.doesNotMatch(subject.deterministicTitle(ISSUE_SEED), /Please implement/);
    // A degraded seed (the issue fetch produced no title) falls through to
    // the body rather than to an empty name.
    assert.equal(
      subject.deterministicTitle('Please implement GitHub issue #7: "".\n\nThe avatar upload 500s.'),
      'The avatar upload 500s.',
    );
  } finally {
    restore();
  }
});

test('titleInputsFromRequests hands the model the issue title and drops the wrapper', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const prepared = subject.titleInputsFromRequests([ISSUE_SEED, 'also sort them by date']);
    assert.equal(prepared.issueTitle, 'Add claimed issues to workshop current work');
    assert.deepEqual(prepared.requests, [
      'Add claimed issues to workshop current work'
        + '\n\nThe workshop lists proposals but not the issues people have claimed.',
      'also sort them by date',
    ]);
    // Nothing to peel: requests pass through and there is no issue signal.
    const plain = subject.titleInputsFromRequests(['make the leaderboard paginate']);
    assert.equal(plain.issueTitle, null);
    assert.deepEqual(plain.requests, ['make the leaderboard paginate']);
  } finally {
    restore();
  }
});

test('refreshFromHistory passes the issue title through to generateSessionTitle', async () => {
  const captured = [];
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async (args) => {
      captured.push(args);
      return { title: 'Claimed issues on the workshop board', usage: undefined, model: 'claude-haiku-4-5' };
    },
  });
  try {
    const pool = mockPool({ userRows: [{ content: ISSUE_SEED }, { content: 'group them by owner' }] });
    const session = { id: 11, session_title: 'dev/tester-1789', pr_number: null };
    const title = await subject.refreshFromHistory({ pool, session, userId: 3, send: () => {} });
    assert.equal(title, 'Claimed issues on the workshop board');
    assert.equal(captured[0].issueTitle, 'Add claimed issues to workshop current work');
    assert.doesNotMatch(captured[0].requests[0], /Please implement GitHub issue/);
    assert.match(captured[0].requests[0], /^Add claimed issues to workshop current work/);
  } finally {
    restore();
  }
});

// The guarded UPDATE is the whole defence against clobbering a name its
// author chose: `proposed_pr_title` is set by PATCH /api/sessions/:id/title
// (#2327) and by submit_work's title, so a manual rename outranks every
// generated one without needing a flag of its own.
test('every generated title loses to a hand-chosen one', async () => {
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => ({ title: 'Generated name', usage: undefined, model: 'claude-haiku-4-5' }),
  });
  try {
    const pool = mockPool();
    const session = { id: 12, session_title: null, pr_number: null };
    await subject.maybeTitleFirstMessage({ pool, session, message: 'do the thing', send: () => {} });
    const update = pool.queries.find((q) => /UPDATE chat_sessions SET session_title/.test(q.sql));
    assert.match(update.sql, /pr_number IS NULL/);
    assert.match(update.sql, /proposed_pr_title IS NULL/);
  } finally {
    restore();
  }
});

// ---- #2500: the shared turn-end hook ----

test('titleAtTurnEnd re-titles from history, and names a first turn from its ask', async () => {
  const captured = [];
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async (args) => {
      captured.push(args);
      return { title: 'Claimed issues on the board', usage: undefined, model: 'claude-haiku-4-5' };
    },
  });
  try {
    // firstTurn: the cheap path, titled straight from the turn's message.
    const firstPool = mockPool();
    const fresh = { id: 21, session_title: null, pr_number: null };
    assert.equal(await subject.titleAtTurnEnd({
      pool: firstPool, session: fresh, message: 'make the board show claims',
      userId: 3, firstTurn: true, resolveBilling: async () => ({ apiKey: 'sk-x' }), send: () => {},
    }), 'Claimed issues on the board');
    assert.deepEqual(captured[0].requests, ['make the board show claims']);

    // Every later turn, and every OpenRouter turn (their eager trim already
    // named them), re-reads the whole history instead.
    const laterPool = mockPool({ userRows: [{ content: 'make the board show claims' }, { content: 'and sort by date' }] });
    const named = { id: 22, session_title: 'make the board show claims', pr_number: null };
    assert.equal(await subject.titleAtTurnEnd({
      pool: laterPool, session: named, message: 'and sort by date',
      userId: 3, firstTurn: false, resolveBilling: async () => ({ apiKey: 'sk-x' }), send: () => {},
    }), 'Claimed issues on the board');
    assert.deepEqual(captured[1].requests, ['make the board show claims', 'and sort by date']);
  } finally {
    restore();
  }
});

// The whole point of the hook: no payer used to mean no name at all, which
// is how an OpenRouter or over-budget session kept its branch name.
test('titleAtTurnEnd falls back to the deterministic name when no payer resolves', async () => {
  let generateCalls = 0;
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => { generateCalls += 1; return { title: 'never' }; },
  });
  try {
    const seeded = 'Please implement GitHub issue #2496: "Add claimed issues to workshop current work".'
      + '\n\nThe workshop lists proposals but not the issues people have claimed.';
    for (const resolveBilling of [
      async () => ({ error: 'over_budget', reason: 'daily cap' }),
      async () => { throw new Error('billing lookup exploded'); },
    ]) {
      const pool = mockPool({ userRows: [{ content: seeded }] });
      const session = { id: 23, session_title: null, pr_number: null };
      const events = [];
      const title = await subject.titleAtTurnEnd({
        pool, session, message: seeded, userId: 3, firstTurn: true,
        resolveBilling, send: (t) => events.push(t),
      });
      assert.equal(title, 'Add claimed issues to workshop current work');
      assert.deepEqual(events, ['session_titled']);
    }
    assert.equal(generateCalls, 0, 'no helper-model call was bought');
  } finally {
    restore();
  }
});

test('titleAtTurnEnd leaves a session that already has a PR to applyPrMetadata', async () => {
  let billingCalls = 0;
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({ title: 'never' }) });
  try {
    const pool = mockPool();
    const title = await subject.titleAtTurnEnd({
      pool,
      session: { id: 24, session_title: 'Mirrored PR title', pr_number: 2151 },
      message: 'another turn',
      userId: 3,
      firstTurn: false,
      resolveBilling: async () => { billingCalls += 1; return { apiKey: 'sk-x' }; },
      send: () => {},
    });
    assert.equal(title, null);
    assert.equal(billingCalls, 0, 'no payer is even resolved');
    assert.equal(pool.queries.length, 0);
  } finally {
    restore();
  }
});

// ---- #1949: deterministic OpenRouter titles ----

test('deterministicTitle trims markdown, collapses whitespace and caps at 72 chars', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    assert.equal(subject.deterministicTitle('  Fix   the\nlogin  redirect  '), 'Fix the login redirect');
    assert.equal(subject.deterministicTitle('## Fix `login` [redirect](x) *now*'), 'Fix login redirect x now');
    assert.equal(subject.deterministicTitle('```js\nfoo()\n```'), '', 'a fenced block alone leaves nothing');
    assert.equal(subject.deterministicTitle(''), '');
    assert.equal(subject.deterministicTitle(null), '');
    const exact = 'x'.repeat(72);
    assert.equal(subject.deterministicTitle(exact), exact, '72 chars fit untouched');
    const long = `${'word '.repeat(20)}end`;
    const trimmed = subject.deterministicTitle(long);
    // #2653: this used to assert `long.slice(0, 71).trimEnd() + '…'` — a cut
    // at exactly 71 characters, wherever that landed, which was usually the
    // middle of a word. The assertion is REVERSED rather than deleted
    // because it pinned the behaviour on purpose; the behaviour is what
    // changed. A title is now cut at the last word boundary that fits, so it
    // is at most 72 and never ends mid-word.
    assert.ok(trimmed.length <= 72, `still within the cap (${trimmed.length})`);
    assert.ok(trimmed.endsWith('…'));
    assert.equal(trimmed, `${'word '.repeat(14).trimEnd()}…`,
      'cut at the last whole word, not at character 71');
    assert.notEqual(trimmed, `${long.slice(0, 71).trimEnd()}…`,
      'the old mid-word cut must not come back');
  } finally {
    restore();
  }
});

// ---- #2653: the deterministic name uses more of the message ----
//
// Reported by an admin: "Autogenerated session titles could be improved;
// just the first line of what I typed in one case". The trim was a blind
// 72-character prefix, so whatever the person wrote first spent the whole
// budget — a greeting, or the opening clause of a long sentence, cut
// mid-word. These pin the three rules that replaced it.

test('a message that already fits is returned in the person\'s own words', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // The rules below exist to spend a budget. With no budget to spend,
    // rephrasing would be taking words out of somebody's mouth for nothing
    // — so a short greeting-led message keeps its greeting.
    assert.equal(subject.deterministicTitle('hey there'), 'hey there');
    assert.equal(subject.deterministicTitle('please fix the login redirect'),
      'please fix the login redirect');
  } finally {
    restore();
  }
});

test('a conversational lead-in does not spend the title budget', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // 88 characters, of which the first 21 say nothing at all. The old trim
    // produced "Hey! Could you please make the leaderboard paginate so it
    // stops loading ever…" — the greeting survived and the point did not.
    const ask = 'Hey! Could you please make the leaderboard paginate so it '
      + 'stops loading every row at once';
    const title = subject.deterministicTitle(ask);
    assert.equal(title,
      'make the leaderboard paginate so it stops loading every row at once');
    assert.doesNotMatch(title, /Hey|Could you|please/,
      'the lead-in is the thing being dropped');
    assert.ok(!title.endsWith('…'),
      'and dropping it brought the whole ask under the cap, so nothing is lost');
  } finally {
    restore();
  }
});

test('several lead-ins stack, and one made only of them survives', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const long = (opener) => `${opener}the avatar upload rejects anything over `
      + 'four megabytes with an unhelpful five hundred error page';
    for (const opener of [
      'Hi, ', 'Hey — could you please ', 'OK, so I need you to ',
      "Let's ", 'Please kindly ', 'Go ahead and ', 'Thanks! Can you ',
    ]) {
      const title = subject.deterministicTitle(long(opener));
      assert.match(title, /^the avatar upload rejects/,
        `"${opener}" was not stripped`);
    }
    // The accepted miss: "OK" and its kind only count as filler when
    // punctuation follows, because "OK button" is a control and "Right
    // sidebar" is a side of the screen. An unpunctuated "OK so …" therefore
    // keeps two words of filler — untidy, and the right way round.
    assert.match(subject.deterministicTitle(long('OK so I need you to ')), /^OK so/);
  } finally {
    restore();
  }
});

test('a whole sentence beats a truncated one', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const ask = 'Fix the login redirect. It sends people to the dashboard '
      + 'instead of back to where they started, which is confusing.';
    assert.equal(subject.deterministicTitle(ask), 'Fix the login redirect',
      'a complete short sentence is a name; a severed long one is a quote');

    // The full stop goes, because a title has none. A question mark stays,
    // because it is part of what the sentence says.
    const question = 'Why does the avatar upload 500? It only happens on the '
      + 'profile screen and only for large files.';
    assert.equal(subject.deterministicTitle(question),
      'Why does the avatar upload 500?');
  } finally {
    restore();
  }
});

test('an opening fragment is not mistaken for a name', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // "Two things" is a complete sentence and tells you nothing. It has to
    // clear a length AND a word count before it can win, so this falls
    // through to the truncation instead.
    const ask = 'Two things. The avatar upload returns a 500 for anything '
      + 'over about four megabytes.';
    const title = subject.deterministicTitle(ask);
    assert.notEqual(title, 'Two things');
    assert.ok(title.startsWith('Two things. The avatar upload'));
  } finally {
    restore();
  }
});

test('an abbreviation is not the end of a sentence', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const ask = 'Fix the e.g. case in the markdown parser, which currently '
      + 'cuts the sentence off at the abbreviation instead of continuing.';
    const title = subject.deterministicTitle(ask);
    assert.notEqual(title, 'Fix the e.g', 'that is where the naive scan stopped');
    assert.match(title, /^Fix the e\.g\. case/);
  } finally {
    restore();
  }
});

test('a truncated title is cut at a word boundary', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const ask = 'Rework the notification digest so it groups by app rather '
      + 'than by day, and drops anything already read elsewhere';
    const title = subject.deterministicTitle(ask);
    assert.ok(title.endsWith('…'));
    assert.ok(title.length <= 72);
    assert.doesNotMatch(title.slice(0, -1), /\s$/, 'no dangling space before the ellipsis');
    assert.ok(ask.startsWith(title.slice(0, -1)), 'it is still a prefix of what was typed');
    // Trailing punctuation rides along with the last whole word and is
    // dropped: "groups by day,…" reads worse than "groups by day…".
    assert.match(title.slice(0, -1), /\w$/, 'and it ends on a whole word');
    assert.equal(title, 'Rework the notification digest so it groups by app rather than by day…');
  } finally {
    restore();
  }
});

test('an issue-started session is still named after its issue, untouched', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // The issue title is already a name — none of the rules above may
    // rewrite it. "Let us…" here is deliberately a phrase the lead-in
    // stripper would otherwise eat.
    const seeded = 'Please implement GitHub issue #7: "Let us reconsider how '
      + 'the workshop orders its cards". Some body text that runs on.';
    assert.equal(subject.deterministicTitle(seeded),
      'Let us reconsider how the workshop orders its cards');
  } finally {
    restore();
  }
});

// Review's findings on the rules above. Each is a case where a heuristic
// helped one message and damaged another.
const OVERFLOW = ' and this part makes the whole message run past the cap';

test('a hyphen glued to an opening word is part of that word', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // "right" and "hi" are both lead-ins, and the punctuation that follows
    // a lead-in used to include the hyphen — so these became "click the
    // account menu" and "res image uploads".
    assert.match(subject.deterministicTitle(`Right-click the account menu${OVERFLOW}`),
      /^Right-click the account menu/);
    assert.match(subject.deterministicTitle(`Hi-res image uploads${OVERFLOW}`),
      /^Hi-res image uploads/);
    // The lead-in strip itself still works when the word really is one.
    assert.match(subject.deterministicTitle(`Hey, make the avatar upload bigger${OVERFLOW}`),
      /^make the avatar upload bigger/);
  } finally {
    restore();
  }
});

test('a word that is only sometimes a greeting needs the punctuation', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // "OK" and "Right" are greetings in "OK, do this" and control names or
    // directions in "OK button" and "Right sidebar". Stripping them
    // unconditionally took the name of the control with them.
    for (const [ask, keeps] of [
      ['OK button remains disabled', /^OK button remains disabled/],
      ['Right sidebar overlaps the content', /^Right sidebar overlaps/],
      ['Actually broken layout on mobile', /^Actually broken layout/],
    ]) {
      assert.match(subject.deterministicTitle(ask + OVERFLOW), keeps, ask);
    }

    // Punctuation is what makes it a greeting, and then it goes.
    for (const opener of ['OK, ', 'Right — ', 'Actually: ', 'So... ', 'Alright! ']) {
      assert.match(
        subject.deterministicTitle(`${opener}make the avatar upload bigger${OVERFLOW}`),
        /^make the avatar upload bigger/, opener);
    }

    // An unambiguous greeting never needed the punctuation.
    assert.match(subject.deterministicTitle(`Hey make the avatar upload bigger${OVERFLOW}`),
      /^make the avatar upload bigger/);
  } finally {
    restore();
  }
});

test('a dotted initialism is not a sentence end, listed or not', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // An allowlist got "e.g." right and still cut "U.S." — so the shape is
    // recognised instead of the word. These are read whole.
    for (const [phrase, expected] of [
      ['Add filtering for U.S. accounts', /^Add filtering for U\.S\. accounts/],
      ['Rename the a.k.a. column', /^Rename the a\.k\.a\. column/],
      ['Fix the e.g. case in the parser', /^Fix the e\.g\. case/],
      ['Handle the etc. case in the parser', /^Handle the etc\. case/],
    ]) {
      assert.match(subject.deterministicTitle(phrase + OVERFLOW), expected, phrase);
    }
  } finally {
    restore();
  }
});

test('an over-long issue title is cut, never re-sentenced', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // An issue title is already a name. Picking a sentence out of it is a
    // rewrite, and it silently drops the half that says what changes.
    const seeded = 'Please implement GitHub issue #9: "Fix imports from foo.js. '
      + 'Preserve the compatibility path for older apps and their forks". Body.';
    const title = subject.deterministicTitle(seeded);
    assert.notEqual(title, 'Fix imports from foo.js', 'that is the sentence rule leaking in');
    assert.ok(title.startsWith('Fix imports from foo.js. Preserve'));
    assert.ok(title.endsWith('…') && title.length <= 72);
  } finally {
    restore();
  }
});

test('a link is left exactly where the person put it', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // Two revisions tried to drop URLs, on the reasoning that a link is long
    // and is rarely the name of a change. Both destroyed the subject of a
    // real sentence — first "Fix https://a.co callback" -> "Fix callback",
    // then "Allow https://example.com/callback as an OAuth redirect origin"
    // -> "Allow as an OAuth redirect origin". Nothing here can tell a
    // pointer from a subject, so the rule is gone rather than guessing a
    // third time. This pins that it stays gone.
    assert.equal(subject.deterministicTitle('Fix https://a.co callback'),
      'Fix https://a.co callback');

    const oauth = 'Allow https://example.com/callback as an OAuth redirect '
      + 'origin for customer workspaces everywhere';
    const title = subject.deterministicTitle(oauth);
    assert.match(title, /https:\/\/example\.com\/callback/,
      'the link is what the sentence is about');
    assert.ok(title.length <= 72);

    // Including one that really was only a pointer: it costs budget, and
    // that is the accepted price of never deleting a subject.
    const pointer = 'Have a look at https://github.com/x/y/pull/2662 and tell '
      + 'me what is wrong with the rate limiter';
    assert.match(subject.deterministicTitle(pointer), /^Have a look at https/);
  } finally {
    restore();
  }
});

test('a cut never splits a character in half', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // Lengths here are UTF-16 units, so an emoji is two of them. A no-space
    // run of them reaches the hard cut, and slicing at an odd offset used to
    // leave a lone high surrogate — the malformed character
    // llm.stripLoneSurrogates exists because of, in a string that is
    // persisted and later fed to a model.
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (let pad = 0; pad < 140; pad += 1) {
      const title = subject.deterministicTitle('x'.repeat(pad) + '\u{1F44D}'.repeat(40));
      assert.doesNotMatch(title, LONE, `lone surrogate at padding ${pad}`);
      assert.ok(title.length <= 72, `over the cap at padding ${pad}`);
    }
  } finally {
    restore();
  }
});

test('titleFromFirstMessage names an untitled OpenRouter session from its first user message', async () => {
  let generateCalls = 0;
  const spends = [];
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => { generateCalls += 1; return { title: 'never' }; },
    spends,
  });
  try {
    // The FIRST user row wins over the turn's own message — a session
    // whose opening turn was refused or stopped is still named from its
    // opening ask, and that is the request the PR title comes from too.
    const pool = mockPool({ userRows: [{ content: 'Make the **leaderboard** paginate' }, { content: 'try again' }] });
    const session = { id: 5, session_title: null, pr_number: null };
    const events = [];
    const title = await subject.titleFromFirstMessage({
      pool, session, message: 'try again', send: (type, data) => events.push({ type, data }),
    });

    assert.equal(title, 'Make the leaderboard paginate');
    assert.equal(session.session_title, 'Make the leaderboard paginate');
    const sel = pool.queries.find((q) => /FROM chat_session_messages/.test(q.sql));
    assert.match(sel.sql, /role = 'user'/);
    assert.match(sel.sql, /ORDER BY id ASC LIMIT 1/);
    assert.deepEqual(sel.params, [5]);
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET session_title/.test(q.sql));
    assert.match(upd.sql, /pr_number IS NULL/, 'same guard as the Haiku path');
    assert.deepEqual(upd.params, ['Make the leaderboard paginate', 5]);
    assert.deepEqual(events, [{ type: 'session_titled', data: { sessionTitle: 'Make the leaderboard paginate' } }]);
    assert.equal(generateCalls, 0, 'no model call');
    assert.equal(spends.length, 0, 'nothing to debit');
  } finally {
    restore();
  }
});

test('titleFromFirstMessage falls back to the turn message and skips when nothing is usable', async () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // No stored row yet -> the turn's own message names the session.
    const pool = mockPool({ userRows: [] });
    const session = { id: 6, session_title: null, pr_number: null };
    assert.equal(await subject.titleFromFirstMessage({ pool, session, message: 'Add a dark mode toggle' }),
      'Add a dark mode toggle');
    assert.equal(session.session_title, 'Add a dark mode toggle');

    // Nothing readable at all -> no title, no UPDATE, branch name stays.
    const empty = mockPool({ userRows: [{ content: '```\ncode only\n```' }] });
    const bare = { id: 7, session_title: null, pr_number: null };
    assert.equal(await subject.titleFromFirstMessage({ pool: empty, session: bare, message: '   ' }), null);
    assert.equal(bare.session_title, null);
    assert.ok(!empty.queries.some((q) => /UPDATE chat_sessions/.test(q.sql)), 'no UPDATE attempted');
  } finally {
    restore();
  }
});

test('titleFromFirstMessage skips titled and PR sessions without touching the DB', async () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const pool = mockPool();
    assert.equal(await subject.titleFromFirstMessage({
      pool, session: { id: 1, session_title: 'Already named', pr_number: null }, message: 'hi',
    }), null);
    assert.equal(await subject.titleFromFirstMessage({
      pool, session: { id: 2, session_title: null, pr_number: 42 }, message: 'hi',
    }), null);
    assert.equal(await subject.titleFromFirstMessage({ pool, session: null, message: 'hi' }), null);
    assert.equal(pool.queries.length, 0, 'no reads or writes');
  } finally {
    restore();
  }
});

test('titleFromFirstMessage never throws: a DB failure resolves null, a lost race emits nothing', async () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const broken = {
      async query() { throw new Error('db down'); },
    };
    const session = { id: 9, session_title: null, pr_number: null };
    const events = [];
    assert.equal(await subject.titleFromFirstMessage({
      pool: broken, session, message: 'do the thing', send: (t) => events.push(t),
    }), null);
    assert.equal(session.session_title, null, 'session left untouched');
    assert.equal(events.length, 0);

    // rowCount 0 = the guarded UPDATE matched nothing (PR landed meanwhile).
    const raced = mockPool({ updateRowCount: 0, userRows: [{ content: 'do the thing' }] });
    const late = { id: 10, session_title: null, pr_number: null };
    assert.equal(await subject.titleFromFirstMessage({
      pool: raced, session: late, message: 'do the thing', send: (t) => events.push(t),
    }), null);
    assert.equal(late.session_title, null);
    assert.equal(events.length, 0);
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

test('an OpenRouter PR title is the session name titleFromFirstMessage gave it (#1949)', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ githubCalls });
  try {
    const ask = 'Make the leaderboard paginate 20 rows at a time and add a sticky header row for the column names';
    const sessionTitles = require('../src/services/session-title');
    const expected = sessionTitles.deterministicTitle(ask);
    // #2653: the trim cuts at a word boundary now, so a truncated title is
    // at MOST 72 rather than exactly 72. What this test is actually about is
    // the parity below — it only needs the input to be long enough to trim.
    assert.ok(expected.endsWith('…') && expected.length <= 72,
      'long enough to exercise the trim');

    const pool = prMetadataMockPool();
    pool.query = async function query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM chat_session_messages/i.test(sql)) return { rows: [{ role: 'user', content: ask, metadata: {} }] };
      if (/FROM chat_session_specs/i.test(sql)) return { rows: [] };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return { rows: [{ spec_md: '', linked_issues: [], pr_linked_issues_applied: [], testing_md: null, testing_path: null, pr_testing_applied: null }] };
      }
      return { rows: [] };
    };
    const session = {
      id: 12, branch_name: 'dev/evan-17890406', pr_number: null,
      agent_backend: 'codex_openrouter', session_title: expected,
    };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: ask, ccSummary: 'Paginated the leaderboard.', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'create');
    assert.equal(githubCalls[0].opts.title, expected, 'PR title == pre-PR session name');
    assert.equal(session.session_title, expected, 'the mirrored name is unchanged');
  } finally {
    restore();
  }
});

// #2500: the deterministic draft is what named the pull request that started
// this — "Please implement GitHub issue 2496: …" on the PR as well as on the
// session. Both come off deterministicTitle, so peeling the scaffolding
// there fixes the pull request too.
test('a deterministic PR title never carries the issue-card scaffolding (#2500)', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ githubCalls });
  try {
    const ask = 'Please implement GitHub issue #2496: "Add claimed issues to workshop current work".'
      + '\n\nThe workshop lists proposals but not the issues people have claimed.\n\n'
      + 'Open a PR that closes this issue (include "Closes #2496" so it links and closes the issue on merge).';

    const pool = prMetadataMockPool();
    pool.query = async function query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM chat_session_messages/i.test(sql)) return { rows: [{ role: 'user', content: ask, metadata: {} }] };
      if (/FROM chat_session_specs/i.test(sql)) return { rows: [] };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return { rows: [{ spec_md: '', linked_issues: [2496], pr_linked_issues_applied: [], testing_md: null, testing_path: null, pr_testing_applied: null }] };
      }
      return { rows: [] };
    };
    const session = {
      id: 13, branch_name: 'dev/evan-17890406', pr_number: null,
      agent_backend: 'codex_openrouter', session_title: null,
    };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: ask, ccSummary: '', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'create');
    assert.equal(githubCalls[0].opts.title, 'Add claimed issues to workshop current work');
    assert.doesNotMatch(githubCalls[0].opts.title, /Please implement GitHub issue/);
    // The seeded linkage is what puts `Closes #N` in the body (#2537).
    assert.match(githubCalls[0].opts.body, /^Closes #2496$/m);
  } finally {
    restore();
  }
});
