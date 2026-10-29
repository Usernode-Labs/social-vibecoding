'use strict';

// POST /api/apps's creation choices (communities, stage 3): who the project
// is for, who is invited, and who approves. src/services/create-options.js is
// pure, so every rule is pinned here; tests/create-audience-postgres.test.js
// drives the route itself against the real schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const options = require('../src/services/create-options');
const { getTemplateFiles } = require('../src/services/template');

test('an audience resolves to the two visibility columns it implies', () => {
  const parse = (audience) => options.parseCreateOptions({ audience });
  assert.deepEqual(
    [parse('solo'), parse('invited'), parse('open')].map((o) => [o.collabVisibility, o.viewVisibility]),
    [['private', 'private'], ['private', 'private'], ['public', 'public']],
    'Just me and A private community are private; A public community is open to see and to build',
  );
  assert.equal(parse('solo').audience, 'solo');
  assert.match(options.parseCreateOptions({ audience: 'public' }).error, /audience must be/);
});

test('a body with no audience keeps today\'s two fields, defaults and rule', () => {
  const legacy = options.parseCreateOptions({});
  assert.equal(legacy.audience, null);
  assert.deepEqual([legacy.collabVisibility, legacy.viewVisibility], ['public', 'public']);
  const inviteOnly = options.parseCreateOptions({ collabVisibility: 'private', viewVisibility: 'public' });
  assert.deepEqual([inviteOnly.collabVisibility, inviteOnly.viewVisibility], ['private', 'public'],
    '"public to use, invite-only building" is still reachable by an older client');
  assert.equal(options.parseCreateOptions({ collabVisibility: 'public', viewVisibility: 'private' }).error,
    'An app that everyone can build cannot be private to view');
  // apps.js validates the visibility-PR route with the same function.
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8');
  assert.match(route, /const validateVisibilityCombo = createOptions\.visibilityComboError;/);
});

test('invitees are usernames, for a private community only, deduplicated and bounded', () => {
  const group = options.parseCreateOptions({ audience: 'invited', invitees: [' @Ada ', 'ada', 'grace', '', '@'] });
  assert.deepEqual(group.invitees, ['Ada', 'grace'], '@ and case do not make a second invite');
  assert.match(options.parseCreateOptions({ audience: 'solo', invitees: ['ada'] }).error, /Only a private community/);
  assert.match(options.parseCreateOptions({ audience: 'open', invitees: ['ada'] }).error, /Only a private community/);
  assert.deepEqual(options.parseCreateOptions({ audience: 'open', invitees: [] }).invitees, [],
    'an empty list is no invites, not an error');
  assert.match(options.parseCreateOptions({ audience: 'invited', invitees: 'ada' }).error, /list of usernames/);
  const many = Array.from({ length: options.MAX_INVITEES + 1 }, (_, i) => `u${i}`);
  assert.match(options.parseCreateOptions({ audience: 'invited', invitees: many }).error, /at most 20/);
});

test('who approves is dapp.json\'s own block, read strictly', () => {
  const gov = (governance, extra = {}) => options.parseCreateOptions({ audience: 'open', governance, ...extra });
  // #4666: absent is the default preset, You or the group.
  assert.equal(gov(undefined).governance.preset, 'you_or_the_group', 'absent is the default preset');
  assert.equal(gov({ preset: 'open_floor' }).governance.preset, 'open_floor');
  assert.match(gov({ preset: 'captain' }).error, /preset/);
  assert.equal(gov({ approvers: 'anyone', approvals: 'default' }).governance, null,
    'the old default rule, spelled out, is still the old default');
  assert.deepEqual(gov({ approvers: 'invited' }).governance, { approverPolicy: 'invited', approvalsRequired: null });
  assert.deepEqual(gov({ approvers: 'invited', approvals: { atLeast: 2 } }).governance,
    { approverPolicy: 'invited', approvalsRequired: 2 },
    'people I pick, then at least N of their yes votes');
  assert.match(gov({ approvers: 'admins' }).error, /approvers must be/);
  assert.match(gov({ approvers: 'invited', approvals: { atLeast: 0 } }).error, /atLeast/);
  assert.match(gov({ approvers: 'invited', approvals: { atLeast: 51 } }).error, /atLeast/);
  // An import sends a rule only when its repo's dapp.json has none (the
  // dialog reads it at the check), and the bot commits it there
  // (services/import-manifest.js); the repo's own rule still wins on deploy.
  assert.deepEqual(options.parseCreateOptions({ governance: { approvers: 'invited' } }, { imported: true }).governance,
    { approverPolicy: 'invited', approvalsRequired: null });
});

test('invite emails are addresses, for a private community only, lowercased, deduplicated, and share the twenty', () => {
  const group = options.parseCreateOptions({ audience: 'invited', invitees: ['ada'], inviteEmails: [' Sam@Example.com ', 'sam@example.com', ''] });
  assert.deepEqual(group.inviteEmails, ['sam@example.com']);
  assert.deepEqual(group.invitees, ['ada']);
  assert.deepEqual(options.parseCreateOptions({ audience: 'invited' }).inviteEmails, []);
  assert.match(options.parseCreateOptions({ audience: 'open', inviteEmails: ['a@b.co'] }).error, /Only a private community/);
  assert.match(options.parseCreateOptions({ audience: 'invited', inviteEmails: ['nope'] }).error, /not an email address/);
  assert.match(options.parseCreateOptions({ audience: 'invited', inviteEmails: 'a@b.co' }).error, /list of email addresses/);
  const people = Array.from({ length: 15 }, (_, i) => `u${i}`);
  const mails = Array.from({ length: 6 }, (_, i) => `p${i}@x.co`);
  assert.match(options.parseCreateOptions({ audience: 'invited', invitees: people, inviteEmails: mails }).error, /at most 20/,
    'usernames and addresses together hold at most twenty people');
});

test('the new repository\'s dapp.json carries a non-default rule, and only then', () => {
  const dapp = (governance) => JSON.parse(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { governance })
    .find((f) => f.path === 'dapp.json').content);
  assert.deepEqual(dapp(null), { category: 'other', secrets: [], tests: [] }, 'a default project\'s manifest is unchanged');
  assert.deepEqual(dapp({ approverPolicy: 'anyone', approvalsRequired: null }), { category: 'other', secrets: [], tests: [] });
  assert.deepEqual(dapp({ approverPolicy: 'invited', approvalsRequired: null }),
    { category: 'other', secrets: [], governance: { approvers: 'invited', approvals: 'default' }, tests: [] });
  assert.deepEqual(dapp({ approverPolicy: 'invited', approvalsRequired: 3 }),
    { category: 'other', secrets: [], governance: { approvers: 'invited', approvals: { atLeast: 3 } }, tests: [] });
  // What it writes is what the manifest reader reads back.
  const { readGovernance } = require('../src/services/app-manifest');
  assert.deepEqual(readGovernance(dapp({ approverPolicy: 'invited', approvalsRequired: 3 })),
    { approvers: 'invited', approvals: 3 });
  const creator = fs.readFileSync(path.join(__dirname, '../src/services/app-creator.js'), 'utf8');
  // One place makes a project's starter files (starterFiles), for the
  // setup's first commit and for a deploy without GitHub: the row's rule,
  // its line (else the first session's card's tagline,
  // tests/app-sketch.test.js) and its starter.
  assert.match(creator, /governance: governanceOf\(row\), description: descriptionOf\(row\) \|\| appSketch\.taglineOf\(sketch\),\s+template: templateOf\(row\), sketch,/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/services/staging.js'), 'utf8'), /require\('\.\/app-creator'\)\.starterFiles\(app, \{/);
});

test('"What is it?" is one optional line, tidied and bounded', () => {
  const desc = (description, opts) => options.parseCreateOptions({ audience: 'open', description }, opts);
  assert.equal(desc(undefined).description, null);
  assert.equal(desc('   ').description, null, 'blank is no line');
  assert.equal(desc('  A shared\n\tlist  for our house ').description, 'A shared list for our house');
  // #3572: 90, two lines of the hub hero on a phone (it was 100).
  assert.equal(options.DESCRIPTION_MAX, 90);
  assert.equal(desc('x'.repeat(options.DESCRIPTION_MAX)).description.length, 90);
  assert.match(desc('x'.repeat(91)).error, /^Say what it is in 90 characters or fewer\.$/);
  assert.equal(desc(`  ${'x'.repeat(90)}  `).description.length, 90, 'counted after tidying, so edge spaces cost nothing');
  assert.match(desc(42).error, /line of text/);
  // An import sends it only when its repo's dapp.json has no description.
  assert.equal(desc('A fork of ours', { imported: true }).description, 'A fork of ours');
});

test('the new repository\'s dapp.json and CLAUDE.md carry the line, and only when there is one', () => {
  const files = (description) => getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { description });
  const dapp = (description) => JSON.parse(files(description).find((f) => f.path === 'dapp.json').content);
  assert.deepEqual(dapp(null), { category: 'other', secrets: [], tests: [] });
  assert.deepEqual(dapp('Shared notes for the house'), { description: 'Shared notes for the house', category: 'other', secrets: [], tests: [] });
  const both = JSON.parse(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, {
    description: 'Shared notes', governance: { approverPolicy: 'invited', approvalsRequired: null },
  }).find((f) => f.path === 'dapp.json').content);
  assert.deepEqual(Object.keys(both), ['description', 'category', 'secrets', 'governance', 'tests']);
  const about = (description) => {
    const claude = files(description).find((f) => f.path === 'CLAUDE.md').content;
    return claude.slice(claude.indexOf('## About Notes'), claude.indexOf('## App-specific conventions'));
  };
  assert.match(about('Shared notes for the house'), /^## About Notes\n\nShared notes for the house\n\n/);
  assert.doesNotMatch(about(null), /Shared notes/);
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8');
  assert.match(route, /UPDATE apps SET manifest_snapshot = \$1 WHERE id = \$2 RETURNING \*`,\s*\[JSON\.stringify\(\{ description, secrets: \[\] \}\), appRow\.id\]/,
    'the route seeds the line where app-creator (and a Retry) reads it');
});

// #6026: what a connector token (the connector's create_app) may send. A
// project for the person who connected it and nothing more; the rest is
// refused by name, never dropped.
test('a connector makes a project from a name, an audience, a line and a brief, and nothing else', () => {
  assert.deepEqual([...options.CONNECTOR_CREATE_FIELDS], ['name', 'audience', 'description', 'brief']);
  assert.equal(options.connectorCreateRefusal({ name: 'The Best Color' }), null);
  assert.equal(options.connectorCreateRefusal({
    name: 'The Best Color', audience: 'solo', description: 'Find your favorite color', brief: 'Pick between two colors until it knows.',
  }), null);
  // Absent and null are the same as not sent.
  assert.equal(options.connectorCreateRefusal({ name: 'x', invitees: undefined, repoUrl: null }), null);
  assert.equal(options.connectorCreateRefusal(null), null);

  for (const extra of [
    { invitees: ['ada'] }, { inviteEmails: ['a@example.com'] }, { repoUrl: 'https://github.com/a/b' },
    { governance: { approvers: 'anyone' } }, { template: 'notes' }, { from: 'create' },
    { collabVisibility: 'public' }, { viewVisibility: 'public' }, { timeZone: 'UTC' },
  ]) {
    const refused = options.connectorCreateRefusal({ name: 'x', ...extra });
    const field = Object.keys(extra)[0];
    assert.ok(refused, `${field} is refused from a connector`);
    assert.match(refused, new RegExp(`Set ${field}`), 'the refusal names the field');
    assert.match(refused, /on Homeroom itself/);
  }
  // An empty list is still a field the caller chose to send.
  assert.ok(options.connectorCreateRefusal({ name: 'x', invitees: [] }));
  // Many fields: five named, the rest summarized, and each name bounded.
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}${'z'.repeat(60)}`, 1]));
  const said = options.connectorCreateRefusal({ name: 'x', ...many });
  assert.match(said, /and the rest/);
  assert.ok(said.length < 600);
});

test('a connector that names no audience makes a private community, never the older public default', () => {
  const parsed = (body) => options.parseCreateOptions(options.connectorCreateBody(body));
  assert.equal(parsed({ name: 'x' }).audience, 'invited');
  assert.deepEqual([parsed({ name: 'x' }).collabVisibility, parsed({ name: 'x' }).viewVisibility], ['private', 'private']);
  assert.equal(parsed({ name: 'x', audience: 'open' }).audience, 'open', 'one it names is kept');
  assert.equal(parsed({ name: 'x', audience: 'solo' }).audience, 'solo');
  // The browser's own body is untouched by it: an older client still gets today's fields.
  assert.equal(options.parseCreateOptions({ name: 'x' }).audience, null);
});

test('the route holds a connector token to those fields before it reads anything else', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8');
  const start = route.indexOf("router.post('/api/apps',");
  assert.ok(start > 0, 'the create route is where it was');
  const handler = route.slice(start, route.indexOf('router.', start + 30));
  const guard = handler.indexOf('createOptions.connectorCreateRefusal(req.body)');
  assert.ok(guard > 0, 'a connector token is held to its fields');
  assert.match(handler, /if \(req\.connectorClientId\) \{\s*const refused = createOptions\.connectorCreateRefusal\(req\.body\);\s*if \(refused\) return res\.status\(400\)/);
  for (const later of ['parseCreateOptions(', 'github.parseGithubUrl(repoUrl)', 'INSERT INTO apps', 'sendInvite(']) {
    const at = handler.indexOf(later);
    assert.ok(at > guard, `the refusal comes before ${later}`);
  }
  const defaulted = handler.indexOf('req.body = createOptions.connectorCreateBody(req.body);');
  assert.ok(defaulted > guard && defaulted < handler.indexOf('parseCreateOptions('),
    'and a connector without an audience is read as a private community');
});
