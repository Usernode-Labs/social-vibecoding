// Tests for #249 — meaningful default change names.
//
//  - services/session-title: deterministicTitle is the shared, LLM-free
//    trim a change's name and its pull request's title come from: markdown
//    dropped, whitespace collapsed, a conversational lead-in skipped, a
//    whole sentence preferred, cut at a word under 72 characters.
//  - #2500 / #3518 / #3183 the scaffolding: parseIssueSeed peels the issue
//    card's `Please implement GitHub issue #N: "…"` and the Homeroom bot's
//    `Build issue #N:` off, and parseTitledRequest a work order's TITLE:
//    line, so the deterministic name (change AND pull request) is what the
//    wrapper wraps.
//  - services/pr-metadata: both PR UPDATE statements mirror pr_title
//    into session_title, and an OpenRouter PR title equals the change's
//    deterministic name (#1949).
//
// Run with: node --test tests/session-title.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- session-title service ----

// The subject, loaded fresh for each test.
function loadService() {
  const subjectPath = require.resolve('../src/services/session-title');
  delete require.cache[subjectPath];
  const subject = require('../src/services/session-title');
  return { subject, restore: () => { delete require.cache[subjectPath]; } };
}

// ---- #2500: the issue card's kickoff scaffolding ----

const ISSUE_SEED = 'Please implement GitHub issue #2496: "Add claimed issues to workshop current work".'
  + '\n\nThe workshop lists proposals but not the issues people have claimed.\n\n'
  + 'Open a PR that closes this issue (include "Closes #2496" so it links and closes the issue on merge).';

test('parseIssueSeed splits the issue card seed and ignores anything else', () => {
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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

// ---- #3518: the Homeroom bot's build seed ----

// The first message of every build session the bot opens
// (homeroom-bot-live.js buildAndPropose): the issue on its own line, the
// triage's plan under it.
const BOT_SEED = 'Build issue #3233: Quota notifications are cryptic codes\n\n'
  + 'Edit the app_quota_changed row in notifications.js so it reads as a sentence. '
  + 'Keep the fallback line for a detail that is not two numbers.';

test('parseIssueSeed peels the Homeroom bot\'s build seed too (#3518)', () => {
  const { subject, restore } = loadService();
  try {
    const seed = subject.parseIssueSeed(BOT_SEED);
    assert.equal(seed.number, 3233);
    assert.equal(seed.title, 'Quota notifications are cryptic codes', 'the title line alone');
    assert.match(seed.body, /^Edit the app_quota_changed row/, 'the plan is the body, not part of the title');
    // An issue fetch that fell back to "Issue #N" still names something,
    // and a seed with no plan under it still parses.
    assert.equal(subject.parseIssueSeed('Build issue #7: Issue #7\n\n').title, 'Issue #7');
    assert.equal(subject.parseIssueSeed('Build issue #7: Sort by date').body, '');
    // The card's own seed is unchanged by the second wrapper.
    assert.equal(subject.parseIssueSeed(ISSUE_SEED).title, 'Add claimed issues to workshop current work');
    // Only at the very start, and only with a number.
    assert.equal(subject.parseIssueSeed('Please build issue #7: sort'), null);
    assert.equal(subject.parseIssueSeed('Build issue: sort the list'), null);
  } finally {
    restore();
  }
});

test('the bot\'s deterministic name is the issue, not "Build issue N:" and a severed plan (#3518)', () => {
  const { subject, restore } = loadService();
  try {
    // Before: `Build issue 3233: Quota notifications are cryptic codes Edit
    // the app…`, the title every bot proposal on the platform carried.
    assert.equal(subject.deterministicTitle(BOT_SEED), 'Quota notifications are cryptic codes');
    assert.doesNotMatch(subject.deterministicTitle(BOT_SEED), /Build issue|3233|Edit the/);
    // An issue title past the cap is still cut the way #2500 cuts one: at a
    // word, and only the title, never the plan run into it.
    const long = subject.deterministicTitle(`Build issue #9: ${'Accepted proposals scored one point versus '
      + 'a hundred and fifty with no reason given anywhere'}\n\nShow the reason.`);
    assert.ok(long.length <= 72, long);
    assert.equal(long, 'Accepted proposals scored one point versus a hundred and fifty with no…');
  } finally {
    restore();
  }
});

// ---- #1949: deterministic OpenRouter titles ----

test('deterministicTitle trims markdown, collapses whitespace and caps at 72 chars', () => {
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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
  const { subject, restore } = loadService();
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

test('an OpenRouter PR title is the change\'s deterministic name (#1949)', async () => {
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
    // The seeded linkage is what puts the closing line in the body (#2537),
    // naming the request in words on GitHub, where `#2496` is GitHub's own.
    assert.match(githubCalls[0].opts.body, /^Closes request 2496$/m);
  } finally {
    restore();
  }
});

// #3518: the pull request the Homeroom bot's promotion opens is named by the
// same deterministic draft when the spec gave it no name of its own, so the
// seed's scaffolding must not reach it there either.
test('a deterministic PR title for a bot build never carries "Build issue N:" (#3518)', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ githubCalls });
  try {
    const ask = 'Build issue #3233: Quota notifications are cryptic codes\n\n'
      + 'Edit the app_quota_changed row in notifications.js so it reads as a sentence.';
    const pool = prMetadataMockPool();
    pool.query = async function query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM chat_session_messages/i.test(sql)) return { rows: [{ role: 'user', content: ask, metadata: {} }] };
      if (/FROM chat_session_specs/i.test(sql)) return { rows: [] };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return { rows: [{ spec_md: '', linked_issues: [3233], pr_linked_issues_applied: [], testing_md: null, testing_path: null, pr_testing_applied: null }] };
      }
      return { rows: [] };
    };
    const session = {
      id: 14, branch_name: 'dev/homeroom_bot-s14', pr_number: null,
      agent_backend: 'codex_openrouter', session_title: 'Homeroom bot: #3233 Quota notifications are cryptic codes',
    };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: ask, ccSummary: '', username: 'homeroom_bot',
    });
    assert.equal(githubCalls[0].type, 'create');
    assert.equal(githubCalls[0].opts.title, 'Quota notifications are cryptic codes');
    // The issue is where the proposal says it is: in Addresses, and in the
    // body's closing line.
    assert.match(githubCalls[0].opts.body, /^Closes request 3233$/m);
  } finally {
    restore();
  }
});

// #3183: sessions driven by a templated work order were named after the
// template — "implement this change in the app: TITLE: Add Calm mode: slower
// sheep…" — by the deterministic trim and in the PR title
// deterministicPrMetadataDraft derives from it.
const WORK_ORDER = 'Please implement this change in the app: TITLE: Add Calm mode: slower sheep, '
  + 'softer colors, same rounds. DETAIL: A Calm mode toggle in the Grown-ups panel that slows '
  + "the flock's movement and softens the meadow's colors, without changing flock sizes, seeds "
  + 'or round numbering. Persist it like the other settings. Must keep canvas, DOM fallback and '
  + 'a11y list working. When done, build/check it. Do NOT promote/put to vote yet; just reply '
  + 'DONE + summary when the code is ready.';

test('a work order is named after its TITLE, not its instruction (#3183)', () => {
  const { subject, restore } = loadService();
  try {
    assert.equal(subject.deterministicTitle(WORK_ORDER),
      'Add Calm mode: slower sheep, softer colors, same rounds');
    assert.equal(subject.deterministicTitle(
      'Please implement this change in the app: TITLE: Add mid-round save and resume. DETAIL: '
        + 'If a child leaves in the middle of a round, save the board.',
    ), 'Add mid-round save and resume');
    // A TITLE on its own line, with markdown emphasis, and no DETAIL field.
    assert.equal(subject.deterministicTitle(
      'Implement the following change:\n**TITLE:** Show quota changes as a sentence\n'
        + 'The app_quota_changed row should read as a sentence.',
    ), 'Show quota changes as a sentence');
    assert.deepEqual(subject.parseTitledRequest('TITLE: Fix the login redirect\nDETAIL: it loops'),
      { title: 'Fix the login redirect', body: 'it loops' });
    // Prose that mentions a title is not a work order.
    assert.equal(subject.parseTitledRequest('Change the page title: it should say Homeroom'), null);
    assert.equal(subject.parseTitledRequest('make the leaderboard paginate'), null);
    assert.equal(subject.deterministicTitle('Change the page title: it should say Homeroom'),
      'Change the page title: it should say Homeroom');
  } finally {
    restore();
  }
});

test('the instruction to make a change is dropped even from a message that fits (#3183)', () => {
  const { subject, restore } = loadService();
  try {
    assert.equal(subject.deterministicTitle('Please implement this change in the app: Add dark mode'),
      'Add dark mode');
    assert.equal(subject.deterministicTitle('Implement the following change:\n\nThe leaderboard should paginate'),
      'The leaderboard should paginate');
    assert.equal(subject.deterministicTitle(
      'Hey, could you build this feature for the game — a wolf that hides in the flock',
    ), 'a wolf that hides in the flock');
    const long = subject.deterministicTitle('Please apply this fix to the project: the avatar upload '
      + 'rejects anything over four megabytes with an unhelpful five hundred error page');
    assert.match(long, /^the avatar upload rejects/);
    assert.doesNotMatch(long, /apply this fix|project/);
    // Without a colon, dash or line break it is a request, not boilerplate.
    assert.match(subject.deterministicTitle('Make this change permanent across all pages of the '
      + 'app and the admin area too please'), /^Make this change permanent/);
    // A greeting a person typed is still theirs when it fits.
    assert.equal(subject.deterministicTitle('please fix the login redirect'),
      'please fix the login redirect');
  } finally {
    restore();
  }
});

