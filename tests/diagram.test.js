'use strict';

// #4490: the diagram record (src/services/diagram.js), shared with #4098.
// Validation and caps per kind, the Mermaid rules (only beside impact
// "none"; no directive, interaction, CSS URL or tag), the text a pull
// request carries, and the ```diagram / ```mermaid fences.

const test = require('node:test');
const assert = require('node:assert/strict');

const diagram = require('../src/services/diagram');

const MERMAID = 'flowchart TD\n  A[Copy database] --> B{Hiccup?}\n  B -- yes --> C[Retry up to 3 times]\n  C --> B';

test('the four fixed kinds are accepted and normalised', () => {
  assert.deepEqual(
    diagram.parseDiagram({ version: 1, kind: 'rename', from: ' spec ', to: 'plan', places: ['Chat cards', 'Buttons'], note: 'Only the words change.' }),
    { version: 1, kind: 'rename', from: 'spec', to: 'plan', places: ['Chat cards', 'Buttons'], note: 'Only the words change.' },
  );
  assert.deepEqual(
    diagram.parseDiagram({ version: 1, kind: 'flow', before: ['Vote', 'Closes'], after: ['Vote', 'Checks', 'Closes'] }),
    { version: 1, kind: 'flow', before: ['Vote', 'Closes'], after: ['Vote', 'Checks', 'Closes'] },
  );
  assert.equal(diagram.parseDiagram({ version: 1, kind: 'changes', rows: [{ op: 'added', what: 'A setting' }] }).rows[0].op, 'added');
  assert.deepEqual(
    diagram.parseDiagram({ version: 1, kind: 'numbers', unit: 's', rows: [{ label: 'Load time', before: 2.4, after: '0.9' }] }).rows[0],
    { label: 'Load time', before: 2.4, after: 0.9 },
  );
});

test('every text is 1 to 60 characters and every list is capped', () => {
  const long = 'x'.repeat(61);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'rename', from: long, to: 'plan' }), /diagram\.from: at most 60/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'rename', from: '', to: 'plan' }), /diagram\.from: required/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'rename', from: 'a', to: 'b', places: Array(9).fill('p') }), /diagram\.places: 0 to 8/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'flow', before: Array(7).fill('s'), after: ['t'] }), /diagram\.before: 1 to 6/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'changes', rows: Array(7).fill({ op: 'added', what: 'w' }) }), /diagram\.rows: 1 to 6/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'changes', rows: [{ op: 'renamed', what: 'w' }] }), /added, changed or removed/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'numbers', rows: [{ label: 'x', before: Infinity, after: 1 }] }), /finite number/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'rename', from: 'a', to: 'a' }), /must differ/);
});

test('no other kind, version or field is accepted, and nothing is half drawn', () => {
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'svg', svg: '<svg/>' }), (err) => err.code === 'invalid_diagram' && /rename, flow, changes or numbers/.test(err.message));
  assert.throws(() => diagram.parseDiagram({ version: 2, kind: 'rename', from: 'a', to: 'b' }), /version: must be 1/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'rename', from: 'a', to: 'b', html: '<b>x</b>' }), /unknown field "html"/);
  assert.throws(() => diagram.parseDiagram('rename'), /must be an object/);
  assert.equal(diagram.storedDiagram({ version: 1, kind: 'rename', from: 'a' }), null);
});

test('Mermaid is accepted only beside visible changes of impact "none"', () => {
  const record = { version: 1, kind: 'mermaid', source: MERMAID };
  assert.equal(diagram.parseDiagram(record, { impact: 'none' }).source, MERMAID);
  assert.throws(() => diagram.parseDiagram(record, { impact: 'ui' }), /only for a change nobody sees.*declares "ui".*rename, flow, changes or numbers/);
  assert.throws(() => diagram.parseDiagram(record), /declares no visibleChanges/);
  // A stored one is read back without the question being asked again.
  assert.equal(diagram.storedDiagram(record).kind, 'mermaid');
});

test('Mermaid source is checked without Mermaid: type, size, directives, interaction, URLs and tags', () => {
  const ok = (source) => diagram.checkMermaidSource(source);
  for (const type of ['flowchart LR', 'graph TD', 'sequenceDiagram', 'stateDiagram-v2', 'classDiagram', 'erDiagram']) {
    assert.ok(ok(`${type}\n  A --> B`));
  }
  assert.ok(ok('sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi'));
  assert.ok(ok('classDiagram\n  Animal <|-- Duck'));
  assert.throws(() => ok('gantt\n  title x'), /must open with one of/);
  assert.throws(() => ok('%%{init: {"securityLevel": "loose"}}%%\nflowchart TD\n  A --> B'), /directives/);
  assert.throws(() => ok('flowchart TD\n  A --> B\n  click A "https://example.com"'), /"click" is not allowed/);
  assert.throws(() => ok('flowchart TD\n  A[href] --> B'), /"href" is not allowed/);
  assert.throws(() => ok('flowchart TD\n  A --> B\n  click A callback'), /not allowed/);
  assert.throws(() => ok('flowchart TD\n  A[javascript:alert(1)] --> B'), /javascript:/);
  assert.throws(() => ok('flowchart TD\n  A --> B\n  style A fill:url(https://example.com/x)'), /"url\(" is not allowed/);
  assert.throws(() => ok('flowchart TD\n  A[<img src=x>] --> B'), /only in arrows/);
  assert.throws(() => ok('flowchart TD\n  A[x > 3] --> B'), /only in arrows/);
  assert.throws(() => ok(`flowchart TD\n${'  A --> B\n'.repeat(40)}`), /at most 40 lines/);
  assert.throws(() => ok(`flowchart TD\n  A[${'x'.repeat(2000)}] --> B`), /at most 2000 characters/);
});

test('the pull request carries a text version, and a ```mermaid block for Mermaid', () => {
  const rename = { version: 1, kind: 'rename', from: 'spec', to: 'plan', places: ['Chat cards', 'Buttons'] };
  assert.equal(diagram.toMarkdown(rename), '**Rename:** spec → plan (Chat cards, Buttons)');
  assert.match(diagram.toMarkdown({ version: 1, kind: 'flow', before: ['Vote', 'Closes'], after: ['Vote', 'Checks', 'Closes'] }),
    /- Before: Vote → Closes\n- After: Vote → Checks → Closes/);
  assert.match(diagram.toMarkdown({ version: 1, kind: 'numbers', unit: 's', rows: [{ label: 'Load time', before: 2.4, after: 0.9 }] }),
    /- Load time: 2\.4 s → 0\.9 s/);
  assert.equal(diagram.toMarkdown({ version: 1, kind: 'mermaid', source: MERMAID }), `\`\`\`mermaid\n${MERMAID}\n\`\`\``);
  // An author's words cannot become markup or a mention on GitHub.
  assert.equal(diagram.toMarkdown({ version: 1, kind: 'rename', from: '@team', to: '[x](y)' }), '**Rename:** @​team → \\[x\\]\\(y\\)');

  const block = diagram.prBlock(rename, 'author');
  assert.ok(block.startsWith(diagram.PR_MARKER_START) && block.endsWith(diagram.PR_MARKER_END));
  assert.match(block, /## Diagram/);
  assert.match(block, /_Diagram by the change's author\._/);
  const body = diagram.upsertPrBlock('The change.', block);
  assert.equal(diagram.extractPrBlock(body), block);
  // Rewritten when it changes, and dropped when it is removed.
  const next = diagram.upsertPrBlock(body, diagram.prBlock({ ...rename, to: 'outline' }));
  assert.match(next, /spec → outline/);
  assert.doesNotMatch(next, /→ plan/);
  assert.equal(diagram.upsertPrBlock(next, ''), 'The change.');
});

test('a ```diagram or ```mermaid fence reads as the same record (#4098)', () => {
  assert.equal(diagram.fromFence('diagram', JSON.stringify({ version: 1, kind: 'rename', from: 'a', to: 'b' })).kind, 'rename');
  assert.equal(diagram.fromFence('mermaid', MERMAID).kind, 'mermaid');
  assert.throws(() => diagram.fromFence('diagram', '{not json'), /must hold the diagram's JSON/);
  assert.throws(() => diagram.fromFence('svg', '<svg/>'), /```diagram or ```mermaid/);
});

test('a regenerated pull request body carries the diagram under the summary, before the other blocks', () => {
  const { renderPrMetadataDraft } = require('../src/services/pr-metadata');
  const block = diagram.prBlock({ version: 1, kind: 'rename', from: 'spec', to: 'plan' });
  const out = renderPrMetadataDraft(
    { title: 'Rename', body: '- Renames spec to plan', summary: 'Spec is now plan.' },
    { username: 'ada', closingBlock: 'Closes #4490', testingBlock: '## How to test\n\n1. Look.', diagramBlock: block },
  );
  const body = out.body;
  assert.ok(body.indexOf('Spec is now plan.') < body.indexOf(diagram.PR_MARKER_START));
  assert.ok(body.indexOf(diagram.PR_MARKER_END) < body.indexOf('## How to test'));
  assert.ok(body.indexOf('## How to test') < body.indexOf('Closes #4490'));
  // And none at all when there is no diagram: legacy bodies stay identical.
  const plain = renderPrMetadataDraft({ title: 'T', body: 'B', summary: '' }, { username: 'ada' });
  assert.doesNotMatch(plain.body, /usernode:diagram/);
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/services/pr-metadata.js'), 'utf8'),
    /&& !shotsChanged && !diagramChanged && !summaryChanged\)/, 'a changed diagram reaches GitHub on a title-unchanged turn');
});

test('a hosted build declares its diagram beside its visible changes, on its own session only', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const worker = read('worker/visible-changes-mcp.js');
  assert.match(worker, /server\.registerTool\('declare_diagram'/);
  assert.match(worker, /\/api\/internal\/sessions\/\$\{sessionId\}\/diagram/);
  assert.match(read('worker/run-codex-agent.sh'), /enabled_tools = \["declare_visible_changes", "declare_diagram"\]/);
  const internal = read('src/routes/internal.js');
  const at = internal.indexOf("router.post('/api/internal/sessions/:sessionId/diagram'");
  assert.ok(at > 0, 'the route');
  const route = internal.slice(at, internal.indexOf('\n    });\n', at));
  assert.match(route, /Number\(req\.workerSession\.sessionId\) !== sessionId/, 'its own session only');
  assert.match(route, /parseDiagram\(req\.body\?\.diagram, \{ impact: rows\[0\]\.impact \|\| null \}\)/, 'Mermaid only beside impact "none"');
  assert.match(route, /code: 'invalid_diagram'/);
  // Asked for by Homeroom bot's build prompt (the session Mayor's, which
  // asked too, is retired), never drawn by the bot on its own.
  assert.match(read('src/services/homeroom-bot-live.js'), /'declare_diagram once with that kind \(rename, flow, changes or numbers\)/);
});

// #6815: with nothing visible, the diagram is the only picture voters get, so
// every builder is asked for one rather than told it is optional.
test('declare_diagram is expected, not optional, for a change declared impact none', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const worker = read('worker/visible-changes-mcp.js');
  const at = worker.indexOf("server.registerTool('declare_diagram'");
  assert.ok(at > 0);
  const block = worker.slice(at, worker.indexOf('inputSchema:', at));
  assert.doesNotMatch(block, /'Optional\./, 'the description no longer opens by calling it optional');
  // #6832: it says what a change nobody sees needs, and names the three
  // pictures in the order the bot chooses them.
  assert.match(block, /Required for every change you declared with declare_visible_changes impact "none"/);
  assert.match(block, /Call declare_visible_changes first\. Calling again replaces the diagram\./,
    'the kind rules and limits are kept');
  assert.ok(block.indexOf('kind seen') < block.indexOf('kind moment') && block.indexOf('kind moment') < block.indexOf('kind steps'),
    'the three pictures are named in the order the bot picks them');
  assert.match(worker, /After impact none, call declare_diagram: it is the only picture voters get\./);
  assert.match(read('src/services/homeroom-bot-live.js'),
    /'If you declared impact "none", always call declare_diagram with one of its three pictures/);
});

// ── #6832: the three pictures for a change nobody sees ────────────────────

const SEEN = {
  version: 1, kind: 'seen', where: "A stuck change's status", look: 'status',
  before: { title: 'Tests failed', lines: ['#22 ERROR: exit code: 1'] },
  after: { title: 'Needs a catch-up with main', lines: ['Your edit and a newer one changed the same text.'] },
};
const MOMENT = {
  version: 1, kind: 'moment',
  before: { date: '2026-11-18', ref: 'PR #6699', lasted: 'about 25 minutes', events: ['Caught up with main', 'The same text was kept twice'] },
  after: { events: ['Tried again', 'Pushed or handed back'] },
};
const STEP = { pic: 'two-edits', caption: 'Two edits' };
const STEPS = {
  version: 1, kind: 'steps',
  before: [STEP, { pic: 'text-twice', caption: 'Same text twice' }, { pic: 'cant-build', caption: "Preview can't build" }],
  after: [STEP, { pic: 'merged', caption: 'Merged' }, { pic: 'checked', caption: 'Checked', retry: true, note: 'Handed back if still wrong' }, { pic: 'builds', caption: 'Preview builds' }],
};

test('#6832: seen, moment and steps are accepted and normalised beside impact "none"', () => {
  assert.deepEqual(diagram.parseDiagram(SEEN, { impact: 'none' }), SEEN);
  assert.deepEqual(diagram.parseDiagram(MOMENT, { impact: 'none' }), MOMENT);
  const steps = diagram.parseDiagram(STEPS, { impact: 'none' });
  assert.equal(steps.before.length, 3);
  assert.equal(steps.after[2].retry, true);
  // The list the renderer draws from is frozen and exported.
  assert.ok(Object.isFrozen(diagram.SCENES));
  assert.ok(diagram.SCENES.includes('two-edits') && diagram.SCENES.includes('vote'));
  assert.deepEqual([...diagram.NONE_KINDS], ['seen', 'moment', 'steps']);
  assert.ok(Object.isFrozen(diagram.SEEN_LOOKS));
});

test('#6832: each of the three is refused unless the call declares impact "none"', () => {
  for (const d of [SEEN, MOMENT, STEPS]) {
    assert.throws(() => diagram.parseDiagram(d, { impact: 'ui' }), /only for a change nobody sees/);
    assert.throws(() => diagram.parseDiagram(d, {}), /only for a change nobody sees/);
    // A stored record reads back without re-asking its submission's impact.
    assert.equal(diagram.storedDiagram(d).kind, d.kind);
  }
});

test('#6832: a seen picture needs a look from the frozen set, at most two lines a side, and must change', () => {
  assert.equal(diagram.parseDiagram({ ...SEEN, look: 'notice' }, { impact: 'none' }).look, 'notice');
  assert.throws(() => diagram.parseDiagram({ ...SEEN, look: 'banner' }, { impact: 'none' }), /diagram\.look: must be status, notice, message, count/);
  assert.throws(() => diagram.parseDiagram({ ...SEEN, after: { title: 'Tests failed', lines: SEEN.before.lines } }, { impact: 'none' }), /must differ/);
  assert.throws(() => diagram.parseDiagram({ ...SEEN, before: { title: 'x', lines: ['a', 'b', 'c'] } }, { impact: 'none' }), /at most 2 entries|1 to 2|0 to 2/);
  assert.throws(() => diagram.parseDiagram({ ...SEEN, where: 'x'.repeat(61) }, { impact: 'none' }), /at most 60/);
  assert.throws(() => diagram.parseDiagram({ ...SEEN, extra: 1 }, { impact: 'none' }), /unknown field "extra"/);
  assert.throws(() => diagram.parseDiagram({ ...SEEN, before: { title: 'x', extra: 1 } }, { impact: 'none' }), /unknown field "extra"/);
});

test('#6832: a moment needs a real past date, a change it happened to, and 1 to 4 events a side', () => {
  assert.throws(() => diagram.parseDiagram({ ...MOMENT, before: { ...MOMENT.before, date: '2999-01-01' } }, { impact: 'none' }), /must not be in the future/);
  assert.throws(() => diagram.parseDiagram({ ...MOMENT, before: { ...MOMENT.before, date: '2026-02-31' } }, { impact: 'none' }), /real calendar date/);
  assert.throws(() => diagram.parseDiagram({ ...MOMENT, before: { ...MOMENT.before, date: '18 Nov' } }, { impact: 'none' }), /YYYY-MM-DD/);
  assert.throws(() => diagram.parseDiagram({ ...MOMENT, before: { ...MOMENT.before, ref: 'a merge that went wrong' } }, { impact: 'none' }), /must name the change it happened to/);
  assert.throws(() => diagram.parseDiagram({ ...MOMENT, after: { events: [] } }, { impact: 'none' }), /1 to 4/);
  assert.throws(() => diagram.parseDiagram({ ...MOMENT, before: { ...MOMENT.before, events: ['a', 'b', 'c', 'd', 'e'] } }, { impact: 'none' }), /1 to 4/);
  assert.equal(diagram.parseDiagram({ ...MOMENT, before: { date: '2026-11-18', ref: 'request #6829', events: ['One'] }, after: { events: ['Two'] } }, { impact: 'none' }).before.lasted, undefined);
});

test('#6832: a steps picture keeps to the fixed set, five a row, three caption words and one note a row', () => {
  assert.throws(() => diagram.parseDiagram({ ...STEPS, before: [{ pic: 'sparkles', caption: 'x' }] }, { impact: 'none' }), /picture set/);
  assert.throws(() => diagram.parseDiagram({ ...STEPS, before: Array(6).fill(STEP) }, { impact: 'none' }), /1 to 5/);
  assert.throws(() => diagram.parseDiagram({ ...STEPS, before: [{ pic: 'merged', caption: 'one two three four' }] }, { impact: 'none' }), /at most 3 words/);
  assert.throws(() => diagram.parseDiagram({ ...STEPS, before: [{ pic: 'merged', caption: 'x'.repeat(25) }] }, { impact: 'none' }), /at most 24/);
  assert.throws(() => diagram.parseDiagram({ ...STEPS, before: [{ pic: 'merged', caption: 'a', note: 'n' }, { pic: 'vote', caption: 'b', note: 'm' }] }, { impact: 'none' }), /at most one step may carry a note/);
  assert.throws(() => diagram.parseDiagram({ ...STEPS, before: [{ pic: 'merged', caption: 'a', retry: 'yes' }] }, { impact: 'none' }), /must be true or false/);
  assert.throws(() => diagram.parseDiagram({ ...STEPS, after: STEPS.before }, { impact: 'none' }), /must differ/);
});

test('#6832: the pull request block says a seen, a moment and a steps picture in words', () => {
  const seen = diagram.toMarkdown(SEEN);
  assert.match(seen, /What you'd see:\*\* A stuck change's status/);
  assert.match(seen, /Before: Tests failed\. /);
  assert.match(seen, /After: Needs a catch-up with main\./);
  const moment = diagram.toMarkdown(MOMENT);
  assert.match(moment, /2026-11-18 · PR \\#6699 · about 25 minutes/);
  assert.match(moment, /- Now:/);
  const steps = diagram.toMarkdown(STEPS);
  assert.match(steps, /Before: Two edits → Same text twice → Preview can't build/);
  assert.match(steps, /After: Two edits → Merged → Checked → Preview builds/);
  assert.equal(diagram.LABELS.seen, "What you'd see");
  assert.equal(diagram.LABELS.moment, 'What happened');
  assert.equal(diagram.LABELS.steps, 'How it works');
});
