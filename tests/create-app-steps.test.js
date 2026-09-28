// The create dialog is steps that UNFOLD in one card (#1911), not one page of
// every choice. Since the rework (drawn and agreed as a clickable mock first)
// it asks six questions, each a step of its own:
//
//   who      Just me, A group, A community
//   invite   a group only: one row per person, a @username or an email
//   kind     App; Document and Video there, dimmed, saying Soon
//   details  the name and the optional "What is it?"
//   approve  who approves changes — a group or a community only
//   start    LAST: from scratch, from a template (Soon), or from a GitHub
//            repo, whose check also reads its dapp.json
//
// Nothing is chosen for the person: every answer starts empty, pressing a
// row selects it, and Next — beside Cancel on every step — stays dimmed until
// the step is answered. `data-step` is the furthest step reached; every
// section ships on every step and app.css folds and unfolds them off
// #create-card[data-step] and [data-final]. This pins the component's
// wiring, the wire body, the repo notice, the CSS, the shot links and the
// checks at source level, and renders the dialog to prove the prerendered
// document starts on the first step with every id.
//
// Run with: node --test tests/create-app-steps.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SRC = read('frontend/src/features/dialogs/create-app.tsx');
const CSS = read('public/css/app.css');
const DAPP = JSON.parse(read('dapp.json'));
const { shellMarkup } = require('./lib/shell-markup');
const { loadTsx } = require('./lib/render-tsx');

const mod = () => loadTsx('frontend/src/features/dialogs/create-app.tsx');

test('the steps a set of answers walks: four for Just me, five for a community, six for a group', () => {
  const { stepsFor } = mod();
  assert.deepEqual([...stepsFor(null)], ['who', 'kind', 'details', 'start'], 'unanswered counts as Just me');
  assert.deepEqual([...stepsFor('solo')], ['who', 'kind', 'details', 'start']);
  assert.deepEqual([...stepsFor('open')], ['who', 'kind', 'details', 'approve', 'start']);
  assert.deepEqual([...stepsFor('invited')], ['who', 'invite', 'kind', 'details', 'approve', 'start']);
  // Every answer starts empty, and the step is the first.
  for (const [what, re] of [
    ['audience', /useState<Audience \| null>\(null\)/],
    ['kind', /useState<Kind \| null>\(null\)/],
    ['start', /useState<Mode \| null>\(null\)/],
    ['approvers', /useState<Approvers \| null>\(null\)/],
    ['approvals', /useState<Approvals \| null>\(null\)/],
    ['people', /useState<Invitee\[\]>\(\[\]\)/],
    ['step', /useState<Step>\('who'\)/],
  ]) assert.match(SRC, re, what);
  // Every answer rides on the root AND the card: the kit lifts the card out
  // of the root while presented. Each is "" until answered.
  assert.match(SRC, /id="create-modal"\s+ref=\{dialog\.rootRef\}\s+\{\.\.\.answers\}/);
  assert.match(SRC, /id="create-card"\s+\{\.\.\.answers\}/);
  for (const attr of ['data-mode', 'data-import-state', 'data-step', 'data-audience', 'data-kind', 'data-approvers',
    'data-approvals', 'data-final', 'data-repo-sets']) {
    assert.match(SRC, new RegExp(`'${attr}': `), attr);
  }
  assert.match(SRC, /'data-audience': audience \?\? ''/);
  assert.match(SRC, /'data-mode': mode \?\? ''/);
  // Close puts every answer back to empty.
  assert.match(SRC, /formRef\.current\?\.reset\(\);[\s\S]*?applyMode\(null\);\s*setAudience\(null\);\s*setPeople\(\[\]\);\s*setKind\(null\);[\s\S]*?setStep\('who'\);\s*setApprovers\(null\);\s*setApprovals\(null\);/);
});

test('a row selects, and Next beside Cancel moves on once the step is answered', () => {
  const answered = SRC.slice(SRC.indexOf('function answered(which: Step)'), SRC.indexOf('const stepAnswered'));
  assert.match(answered, /case 'who': return audience != null;/);
  assert.match(answered, /case 'invite': return people\.length > 0;/);
  assert.match(answered, /case 'kind': return kind != null;/);
  assert.match(answered, /case 'details': return name\.trim\(\)\.length > 0;/);
  assert.match(answered, /case 'approve': return approvers != null && \(approvers !== 'invited' \|\| approvals != null\);/);
  assert.match(answered, /case 'start': return mode != null && \(mode !== 'import' \|\| importState === 'ok'\);/);
  // On its own step a row only selects; a collapsed row reopens its step.
  assert.match(SRC, /function chooseAudience\(next: Audience\) \{\s*setError\(''\);\s*if \(step !== 'who'\) \{ setStep\('who'\); return; \}\s*setAudience\(next\);\s*\}/);
  assert.match(SRC, /function chooseKind\(next: Kind\) \{\s*setError\(''\);\s*if \(step !== 'kind'\) \{ setStep\('kind'\); return; \}\s*setKind\(next\);\s*\}/);
  // Next walks the list, and only when answered.
  const next = SRC.slice(SRC.indexOf('function next() {'), SRC.indexOf('/** One entry point'));
  assert.match(next, /if \(!stepAnswered\) \{/);
  assert.match(next, /const to = steps\[steps\.indexOf\(step\) \+ 1\];/);
  assert.match(next, /Give your project a name\./);
  // Both footer buttons wait for the answer.
  const footer = SRC.slice(SRC.indexOf('id="create-cancel"'));
  assert.ok(footer.indexOf('id="create-next"') > 0 && footer.indexOf('id="create-next"') < footer.indexOf('id="create-submit"'),
    'Cancel, then Next, then Create');
  assert.match(footer, /id="create-next"[\s\S]{0,200}disabled=\{quotaBlocksCreation \|\| !stepAnswered\}/);
  assert.match(footer, /id="create-submit"[\s\S]{0,220}disabled=\{quotaBlocksCreation \|\| submitting \|\| !stepAnswered\}/);
  // Enter before the last step advances; only the last step creates.
  assert.match(SRC, /if \(!isLast\) \{\s*next\(\);\s*return;\s*\}/);
  assert.doesNotMatch(SRC, /id="create-back"/, 'no Back: the earlier steps stay on screen');
});

test('the wire body: who it is for, the people and addresses, and what an import leaves to its repo', () => {
  const { createBody } = mod();
  const base = { name: 'Book club', mode: 'new', approvers: 'anyone', approvals: null };
  const ada = { kind: 'user', username: 'ada' };
  const sam = { kind: 'email', email: 'sam@example.com' };
  assert.deepEqual(createBody({ ...base, audience: 'solo', invitees: [ada] }),
    { name: 'Book club', audience: 'solo' }, 'Just me sends no invitees, whatever the rows hold');
  assert.deepEqual(createBody({ ...base, audience: 'invited', invitees: [ada, sam] }),
    { name: 'Book club', audience: 'invited', invitees: ['ada'], inviteEmails: ['sam@example.com'] });
  assert.deepEqual(createBody({ ...base, audience: 'open', approvers: 'invited', approvals: 'majority' }).governance,
    { approvers: 'invited', approvals: 'default' });
  assert.deepEqual(createBody({ ...base, audience: 'open', approvers: 'invited', approvals: 'atLeast', approvalsN: 3 }).governance,
    { approvers: 'invited', approvals: { atLeast: 3 } });
  assert.equal(createBody({ ...base, audience: 'open' }).governance, undefined, 'members vote sends nothing');
  assert.equal(createBody({ ...base, audience: 'open', description: '  Swap seeds \n and plan  ' }).description, 'Swap seeds and plan');
  assert.equal(createBody({ ...base, audience: 'open', description: '   ' }).description, undefined, 'blank sends nothing');
  // An import sends the line and the rule only where its dapp.json has none.
  const imp = { ...base, mode: 'import', repoUrl: 'https://github.com/o/r', audience: 'open', approvers: 'invited', approvals: 'majority', description: 'Ours' };
  assert.deepEqual(createBody({ ...imp, repo: {} }),
    { name: 'Book club', audience: 'open', repoUrl: 'https://github.com/o/r', description: 'Ours', governance: { approvers: 'invited', approvals: 'default' } });
  assert.deepEqual(createBody({ ...imp, repo: { description: 'Theirs', governance: { approvers: 'anyone', approvals: null } } }),
    { name: 'Book club', audience: 'open', repoUrl: 'https://github.com/o/r' });
  const submit = SRC.slice(SRC.indexOf('async function submit(event: FormEvent) {'), SRC.indexOf('  const stepIndex'));
  assert.match(submit, /const body = createBody\(\{/);
  assert.match(submit, /invitees: people,/);
  assert.match(submit, /repo,\s*\}\);/);
  assert.match(submit, /body: JSON\.stringify\(body\)/);
});

test('an import names each earlier answer its repo’s dapp.json replaces', () => {
  const { repoOverrides } = mod();
  const answers = { name: 'Book club', description: '', audience: 'invited', approvers: 'anyone', approvals: null };
  const repo = {
    name: 'Book Club',
    description: 'Pick a book, read it together, talk about it.',
    visibility: { build: 'private', view: 'public' },
    governance: { approvers: 'invited', approvals: 2 },
  };
  const all = repoOverrides(repo, answers);
  assert.deepEqual(all.map((o) => o.key), ['name', 'desc', 'vis', 'gov']);
  assert.deepEqual(all.find((o) => o.key === 'gov'),
    { key: 'gov', label: 'Who approves changes', repo: 'People I pick, at least 2 yes', yours: 'Members vote' });
  assert.equal(all.find((o) => o.key === 'desc').yours, 'left blank');
  assert.equal(all.find((o) => o.key === 'vis').repo, 'Anyone can see it; only people invited can build');
  // Only real differences.
  assert.deepEqual(repoOverrides({}, answers), [], 'a repo that sets nothing replaces nothing');
  assert.deepEqual(repoOverrides(null, answers), []);
  assert.deepEqual(repoOverrides({ visibility: { build: 'private', view: 'private' } }, answers), [],
    'a private repo does not clash with a group');
  assert.equal(repoOverrides({ visibility: { build: 'private', view: 'private' } }, { ...answers, audience: 'open' }).length, 1);
  assert.deepEqual(repoOverrides({ name: 'Book club' }, answers), [], 'the same name is not a change');
  assert.deepEqual(repoOverrides({ governance: { approvers: 'invited', approvals: 2 } }, { ...answers, audience: 'solo' }), [],
    'Just me was never asked who approves');
  // The notice, and what the card says for app.css.
  assert.match(SRC, /This repo already sets some of this/);
  assert.match(SRC, /You chose: \$\{o\.yours\}/);
  assert.match(SRC, /Nothing in this repo’s dapp\.json changes your answers\. They’re written into it when it’s imported\./);
  assert.match(SRC, /Couldn’t read this repo’s dapp\.json\./);
  assert.match(SRC, /'data-repo-sets': overrides\.map\(\(o\) => o\.key\)\.join\(' '\)/);
  assert.match(SRC, /setRepo\(manifest && typeof manifest === 'object' \? manifest : \{\}\);\s*setRepoUnread\(manifest === null\);/);
});

test('the invite step: one row per person, suggestions from the user search, an email marked Will invite', () => {
  const rows = SRC.slice(SRC.indexOf('function InviteRows('), SRC.indexOf('/* ── The repo notice'));
  assert.match(SRC, /fetch\(`\/api\/users\/search\?scope=messages&q=\$\{encodeURIComponent\(q\)\}`/,
    'friends first, without you or anyone blocked');
  assert.match(rows, /id="create-invite-block"/);
  assert.match(rows, /id="create-invitees"/);
  assert.match(rows, /placeholder="@username or email"/);
  assert.match(rows, /Will invite/);
  assert.match(rows, /Add another person/);
  assert.match(rows, /No one on Homeroom is called @\$\{name\}\. Check the spelling, or invite them by email\./);
  assert.match(rows, /That email is already on the list\./);
  assert.match(rows, /onMouseDown=\{\(e\) => \{ e\.preventDefault\(\); add\(/, 'a pick lands before the blur folds the list');
  assert.match(rows, /disabled=\{full\}/, `no more than the server takes`);
  assert.match(SRC, /export const MAX_INVITEES = 20;/);
  // No focus is moved onto "Add another person" after adding somebody: that
  // drew a stray focus ring in the mock.
  assert.doesNotMatch(rows, /add[\s\S]{0,80}\.focus\(\)[\s\S]{0,40}create-invitee-add/);
  const { EMAIL_RE } = mod();
  assert.ok(EMAIL_RE.test('sam@example.com'));
  assert.ok(!EMAIL_RE.test('sam@example'));
  assert.ok(!EMAIL_RE.test('@sam'));
});

test('the kind step and the last step: rows, with what is not ready yet dimmed and saying Soon', () => {
  const kind = SRC.slice(SRC.indexOf('data-create-step="kind"'), SRC.indexOf('data-create-step="details"'));
  assert.match(kind, /data-kind-pill="app"/);
  assert.match(kind, /Something you build and use together\./);
  assert.match(kind, /data-kind-pill="doc" aria-disabled="true"/);
  assert.match(kind, /Pages you write and edit together\./);
  assert.match(kind, /data-kind-pill="video" aria-disabled="true"/);
  assert.match(kind, /A video you make together, from script to cut\./);
  const start = SRC.slice(SRC.indexOf('data-create-step="start"'), SRC.indexOf('id="create-error"'));
  assert.ok(start.indexOf('data-mode-pill="new"') < start.indexOf('data-mode-pill="template"')
    && start.indexOf('data-mode-pill="template"') < start.indexOf('data-mode-pill="import"')
    && start.indexOf('data-mode-pill="import"') < start.indexOf('id="create-import-block"'),
    'scratch, template, repo, then the repo check under them');
  assert.match(start, /Start from scratch/);
  assert.match(start, /Start from a template/);
  assert.match(start, /Import a GitHub repo/);
  assert.match(SRC, /\{`\$\{numberOf\('start'\)\}\. How do you want to start\?`\}/);
  assert.match(SRC, />\s*A majority\s*</, '"Most of them" reads "A majority"');
  assert.doesNotMatch(SRC, /Most of them/);
});

test('app.css unfolds the steps in place, keeps each step to the answers it belongs to, and shapes the footer', () => {
  const rule = (sel) => new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const sel of [
    '#create-card[data-step="who"]     :is([data-create-step="invite"], [data-create-step="kind"], [data-create-step="details"], [data-create-step="approve"], [data-create-step="start"])',
    '#create-card[data-step="invite"]  :is([data-create-step="kind"], [data-create-step="details"], [data-create-step="approve"], [data-create-step="start"])',
    '#create-card[data-step="kind"]    :is([data-create-step="details"], [data-create-step="approve"], [data-create-step="start"])',
    '#create-card[data-step="details"] :is([data-create-step="approve"], [data-create-step="start"])',
    '#create-card[data-step="approve"] [data-create-step="start"]',
    '#create-card:not([data-audience="invited"]) [data-create-step="invite"]',
    '#create-card:is([data-audience="solo"], [data-audience=""]) [data-create-step="approve"]',
    '#create-card[data-final="false"] #create-submit',
    '#create-card[data-final="true"]  #create-next',
    '#create-card:not([data-mode="import"]) .create-import-block { display: none; }',
  ]) assert.match(CSS, rule(sel), sel);
  assert.doesNotMatch(CSS, /\[data-step="start"\]\) #create-next \{\s*display: none/, 'Next is never hidden on a question step now');
  // A question step collapses to its chosen row once the card moves past it.
  assert.match(CSS, rule('#create-card:not([data-step="who"])[data-audience="invited"] .create-who-pill:not([data-audience-pill="invited"])'));
  assert.match(CSS, rule('#create-card:is([data-step="details"], [data-step="approve"], [data-step="start"]) [data-create-step="kind"] :is(.create-choice-chevron, .create-choice-caption, .create-kind-soon)'));
  // What an import's dapp.json replaces is dimmed and tagged.
  assert.match(CSS, rule('#create-card[data-step="start"][data-mode="import"][data-repo-sets~="gov"]  #create-approve-block'));
  assert.match(CSS, rule('#create-card[data-step="start"][data-mode="import"][data-repo-sets~="vis"] [data-repo-tag="vis"]'));
});

test('every selected choice wears the Create button\'s accent, the moment it is pressed', () => {
  const fill = CSS.slice(CSS.indexOf('#create-card[data-audience="solo"]      .create-who-pill[data-audience-pill="solo"],'));
  const block = fill.slice(0, fill.indexOf('}') + 1);
  for (const sel of ['.create-who-pill[data-audience-pill="open"]', '.create-kind-row[data-kind-pill="app"]',
    '.create-mode-pill[data-mode-pill="import"]', '.create-approver-pill[data-approver-pill="invited"]',
    '.create-approvals-pill[data-approvals-pill="atLeast"]']) {
    assert.ok(block.includes(sel), sel);
  }
  assert.match(block, /background: #0a6ee0;/);
  assert.doesNotMatch(block, /:not\(\[data-step="who"\]\)/, 'a row fills on its own step now');
});

test('the shot links land on the state they name, and each has a check', () => {
  assert.match(SRC, /if \(shot === 'create-group'\) return \{ \.\.\.open, step: 'invite', audience: 'invited' \};/);
  assert.match(SRC, /if \(shot === 'create-details'\) return \{ \.\.\.open, step: 'details', audience: 'solo', kind: 'app' \};/);
  assert.match(SRC, /if \(shot === 'create-approve' \|\| shot === 'create-access'\) return \{ \.\.\.named, step: 'approve', audience: 'open' \};/);
  assert.match(SRC, /if \(shot === 'create-import'\) return \{ \.\.\.named, step: 'start', audience: 'solo', mode: 'import' \};/);
  const byPath = new Map(DAPP.tests.map((t) => [t.path, t]));
  const first = DAPP.tests.find((t) => t.path === '/#create' && /Step 1 of 4/.test(t.expectText || ''));
  assert.ok(first, 'a check reads the step count on a cold open');
  assert.match(first.expectSelector, /\[data-step="who"\]\[data-audience=""\]:has\(#create-cancel \+ #create-next:disabled\)/);
  const details = byPath.get('/?shot=create-details#create');
  assert.match(details.expectSelector, /\[data-step="details"\]\[data-kind="app"\]/);
  assert.equal(details.expectText, 'Project name');
  const approve = byPath.get('/?shot=create-approve#create');
  assert.match(approve.expectSelector, /\[data-step="approve"\]\[data-audience="open"\]\[data-final="false"\] #create-approve-block/);
  assert.equal(approve.expectText, 'Who approves changes?');
  const group = byPath.get('/?shot=create-group#create');
  assert.match(group.expectSelector, /\[data-step="invite"\] \[data-create-step="invite"\] #create-invite-block #create-invitees/);
  assert.equal(group.expectText, 'Who do you want to invite?');
  const imp = byPath.get('/?shot=create-import#create');
  assert.match(imp.expectSelector, /\[data-mode-pill="new"\] \+ \[data-mode-pill="template"\] \+ \[data-mode-pill="import"\] \+ #create-import-block/);
  assert.equal(byPath.get('/?shot=create-access#create'), undefined, 'the retired step has no check left');
});

test('the prerendered document starts on the first step, nothing chosen, with every id in place', () => {
  const html = shellMarkup();
  const card = html.slice(html.indexOf('id="create-card"'), html.indexOf('id="rename-modal"'));
  assert.match(card, /data-step="who"/);
  assert.match(card, /data-audience=""/);
  assert.match(card, /data-mode=""/);
  assert.match(card, /data-final="false"/);
  for (const step of ['who', 'invite', 'kind', 'details', 'approve', 'start']) {
    assert.match(card, new RegExp(`data-create-step="${step}"`), step);
  }
  assert.match(card, /Step 1 of 4/);
  for (const id of ['create-step-indicator', 'create-invite-block', 'create-invitees', 'create-import-block',
    'create-name-block', 'create-approve-block', 'create-approvals-n', 'create-cancel', 'create-next',
    'create-submit', 'import-url', 'app-name', 'app-description']) {
    assert.match(card, new RegExp(`id="${id}"`), id);
  }
  assert.match(card, /<button[^>]*id="create-next"[^>]*disabled=""/, 'Next is dimmed until the first answer');
  assert.match(card, />New project</);
});

// QA 2026-09-24 Q5: a double-click on Create sent two POSTs and made two apps,
// each taking a slot. The handler claims a ref BEFORE its first await, so a
// second click (or an Enter) in the same frame returns without a request; the
// button is disabled and busy while the request is in flight; and both are
// released in a `finally`, so a failed request can be retried.
test('Create sends one request at a time and shows it is busy', () => {
  const submit = SRC.slice(SRC.indexOf('async function submit(event: FormEvent) {'), SRC.indexOf('  return (\n    <DialogRoot'));
  const guard = submit.indexOf('if (submittingRef.current) return;');
  assert.ok(guard > 0, 'the handler has its own in-flight guard');
  assert.ok(guard < submit.indexOf("await fetch('/api/apps'"), 'claimed before the request');
  assert.match(submit, /if \(submittingRef\.current\) return;\s*submittingRef\.current = true;\s*setSubmitting\(true\);\s*try \{/);
  assert.match(submit, /\} finally \{\s*submittingRef\.current = false;\s*setSubmitting\(false\);\s*\}/);
  assert.equal((submit.match(/fetch\('\/api\/apps'/g) || []).length, 1);
  const button = SRC.slice(SRC.indexOf('id="create-submit"'), SRC.indexOf('</Button>', SRC.indexOf('id="create-submit"')));
  assert.match(button, /aria-busy=\{submitting \|\| undefined\}/, 'no aria-busy in the prerender');
  assert.match(button, /\{submitting \? <SpinnerArcIcon /);
  assert.match(button, /\(importing \? 'Importing…' : 'Creating…'\)/);
  assert.match(SRC, /const \[submitting, setSubmitting\] = useState\(false\);/, 'starts idle, as prerendered');
});

test('the prerendered Create button is idle', () => {
  const html = shellMarkup();
  const submit = html.match(/<button[^>]*id="create-submit"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(submit, /aria-busy/);
  assert.doesNotMatch(submit, /<svg/);
  assert.match(submit, />Create<\/button>$/);
});
