// Admin → Email delivery — the section, its three routes, and the two
// properties that make it safe to ship.
//
// WHY THIS FILE EXISTS. Everything the platform sends goes out on an
// always-200 endpoint (SPEC 1667), so no user surface can tell an
// operator that mail is broken. This section is the compensating
// visibility, and it is also the ONE place an authenticated admin can
// aim platform mail at an address of their choosing. That combination
// makes two things load-bearing:
//
//   1. THE WRITE GATE. Reads are open to any admin (view-only included);
//      the send is full-admin-only and rate-limited. A view-only admin
//      who can spend provider quota is a privilege escalation, so the
//      middleware chain is asserted rather than assumed.
//   2. THE STATUS RESPONSE CARRIES NO VALUES. It reports which keys are
//      absent, never what any of them are — the same rule the Topochain
//      settings card has followed since it shipped.
//
// These are source-shape assertions (the routes need a Postgres and a
// session to exercise live), plus real behavioural coverage of the
// recipient validator, which is where a header-injection bug would live.
//
// Run with: node --test tests/admin-mail-console.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const adminJs = fs.readFileSync(path.join(ROOT, 'src/routes/admin.js'), 'utf8');
const moduleJs = fs.readFileSync(path.join(ROOT, 'frontend/src/features/admin/admin-mail.js'), 'utf8');
const consoleJs = fs.readFileSync(path.join(ROOT, 'frontend/src/features/admin/admin-console.js'), 'utf8');
const limitsJs = fs.readFileSync(path.join(ROOT, 'src/middleware/rate-limits.js'), 'utf8');
const eventsJs = fs.readFileSync(path.join(ROOT, 'src/services/events.js'), 'utf8');

// The route block, isolated so the assertions below can't be satisfied by
// some unrelated part of a 1600-line file.
const mailBlock = adminJs.slice(adminJs.indexOf("router.get('/api/admin/mail/status'"));

// ─── the write gate ─────────────────────────────────────────────────────

test('the two read routes are open to any admin, including view-only', () => {
  // adminMiddleware is applied once to the whole /api/admin mount, so a
  // read route needs no extra chain — but it must not have picked up
  // requireAdminWrite either, or a view-only admin loses the section.
  for (const route of ['/api/admin/mail/status', '/api/admin/mail/activity']) {
    const decl = mailBlock.slice(mailBlock.indexOf(`router.get('${route}'`));
    const head = decl.slice(0, 120);
    assert.ok(!/requireAdminWrite/.test(head),
      `${route} must stay readable by a view-only admin`);
  }
  assert.match(adminJs, /router\.use\('\/api\/admin', adminMiddleware\)/,
    'the whole mount is admin-only to begin with');
});

test('the test send is full-admin-only AND rate-limited', () => {
  const decl = mailBlock.slice(mailBlock.indexOf("router.post('/api/admin/mail/test'"));
  const head = decl.slice(0, 200);
  assert.match(head, /requireAdminWrite/,
    'a view-only admin must not be able to spend provider quota');
  assert.match(head, /mailTestLimiter/,
    'the console button must not be an unbounded mail cannon');
  // The order matters: gate first, then spend a limiter slot.
  assert.ok(head.indexOf('requireAdminWrite') < head.indexOf('mailTestLimiter'),
    'the permission check runs before the limiter');
});

test('mailTestLimiter is keyed by user and does not exempt admins', () => {
  const decl = limitsJs.slice(limitsJs.indexOf('const mailTestLimiter = makeLimiter('));
  const body = decl.slice(0, 400);
  assert.match(body, /keyByUser: true/, 'the budget belongs to the operator, not the office IP');
  assert.ok(!/exemptAdmins/.test(body),
    'exempting admins would disable a limiter on a full-admin-only route');
  assert.match(body, /max: 10/);
  assert.match(limitsJs, /mailTestLimiter \}/, 'the limiter is exported');
});

// ─── the recipient validator ────────────────────────────────────────────
//
// Exercised for real: this is the one input on the section, and a CR/LF
// reaching an SMTP header is how a mailer becomes an open relay. The
// validator is a closure inside adminRoutes(), so it is re-derived here
// from the same source rather than re-implemented — a divergence between
// this regex and the shipped one would make the test worthless.

function loadValidator() {
  const src = adminJs.slice(adminJs.indexOf('const TEST_RECIPIENT_RE ='),
    adminJs.indexOf('// Configuration presence only'));
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return validateTestRecipient;`)();
}

test('the recipient validator refuses anything header-injecting', () => {
  const validate = loadValidator();
  for (const bad of [
    'ops@example.invalid\r\nBcc: victim@example.invalid',
    'ops@example.invalid\nBcc: victim@example.invalid',
    'a@b.invalid, c@d.invalid',
    'a@b.invalid; c@d.invalid',
    '<a@b.invalid>',
    'not-an-address',
    'a@b',
    '',
    '   ',
    `${'a'.repeat(250)}@example.invalid`,
    null,
    undefined,
    42,
    { to: 'a@b.invalid' },
  ]) {
    const result = validate(bad);
    assert.ok(result.error, `${JSON.stringify(bad)} must be refused`);
    assert.equal(result.to, undefined, 'a refused address never reaches the mailer');
  }
});

test('the recipient validator accepts an ordinary address, trimmed', () => {
  const validate = loadValidator();
  assert.equal(validate('  ops@example.invalid  ').to, 'ops@example.invalid');
  assert.equal(validate('first.last+tag@sub.example.co.uk').to, 'first.last+tag@sub.example.co.uk');
});

// ─── what the routes return ─────────────────────────────────────────────

test('a malformed recipient is a 400 and writes no ledger row', () => {
  const decl = mailBlock.slice(mailBlock.indexOf("router.post('/api/admin/mail/test'"));
  const body = decl.slice(0, 1400);
  const validateAt = body.indexOf('validateTestRecipient');
  const sendAt = body.indexOf('mail.sendTest');
  assert.ok(validateAt > -1 && sendAt > -1);
  assert.ok(validateAt < sendAt, 'validation happens before anything is attempted');
  assert.match(body.slice(validateAt, sendAt), /return res\.status\(400\)/,
    'a bad address is rejected, not recorded as a failed delivery');
});

test('every reportable mail outcome is HTTP 200, not an error status', () => {
  // `failed` and `no_transport` are ANSWERS to the operator's question.
  // Turning them into a 5xx would make the console show "request failed"
  // for the exact case the section exists to explain.
  const decl = mailBlock.slice(mailBlock.indexOf("router.post('/api/admin/mail/test'"));
  const body = decl.slice(0, 1600);
  assert.match(body, /res\.json\(\{ outcome \}\)/,
    'the outcome is returned as-is, whatever its status');
  const statuses = [...body.matchAll(/res\.status\((\d+)\)/g)].map((m) => m[1]);
  assert.deepEqual(statuses.sort(), ['400', '500'],
    'only a malformed request or a genuine crash gets a non-200');
});

test('the test send is recorded as a durable event', () => {
  assert.match(eventsJs, /MAIL_TEST_SENT: 'mail_test_sent'/);
  const decl = mailBlock.slice(mailBlock.indexOf("router.post('/api/admin/mail/test'"));
  const body = decl.slice(0, 1600);
  assert.match(body, /events\.EVENT_TYPES\.MAIL_TEST_SENT/);
  // Metadata mirrors the ledger — never the rendered message, never a key.
  assert.match(body, /metadata: \{ status: outcome\.status, provider: outcome\.provider, recipient: to \}/);
});

test('the status route returns presence, never a credential value', () => {
  const decl = mailBlock.slice(mailBlock.indexOf("router.get('/api/admin/mail/status'"),
    mailBlock.indexOf("router.get('/api/admin/mail/activity'"));
  // describe() is value-free by construction; the route must not enrich
  // the response by reading process.env directly for anything else.
  assert.match(decl, /mail\.describe\(process\.env\)/);
  const envReads = [...decl.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(envReads, [], 'the route reads no individual env value');
  assert.match(decl, /SELECT email FROM users WHERE id = \$1/,
    'the form pre-fill comes from the signed-in admin, not from a header');
});

test('the activity route clamps its limit and parameterises its filter', () => {
  const decl = mailBlock.slice(mailBlock.indexOf("router.get('/api/admin/mail/activity'"),
    mailBlock.indexOf("router.post('/api/admin/mail/test'"));
  assert.match(decl, /Math\.min\(100, Math\.max\(1, Math\.floor\(requested\)\)\)/,
    'an unbounded LIMIT is a trivial denial of service');
  // The kind filter is user input and MUST be a bound parameter.
  assert.match(decl, /\(\$1::text IS NULL OR kind = \$1\)/);
  assert.ok(!/\$\{kind\}/.test(decl), 'the kind filter is never interpolated');
});

// ─── the existing Topochain card is untouched ───────────────────────────

test('the older v4 mail routes are still there and unchanged in shape', () => {
  const settings = fs.readFileSync(
    path.join(ROOT, 'src/routes/topochain/admin/settings.js'), 'utf8');
  assert.match(settings, /\/mail-status/, 'the Topochain settings card keeps its own status route');
  assert.match(settings, /\/mail-activity/, 'and its own activity route');
  const topochainJs = fs.readFileSync(path.join(ROOT, 'frontend/src/features/admin/admin-topochain.js'), 'utf8');
  assert.match(topochainJs, /\/api\/v4\/admin\/settings\/mail-status/,
    'the Topochain card was not quietly repointed at the new routes');
});

// ─── the section module ─────────────────────────────────────────────────

test('the section is registered and mapped to its module', () => {
  assert.match(consoleJs, /key: 'mail', label: 'Email delivery', group: 'Platform'/);
  assert.match(consoleJs, /mail: 'AdminMail'/);
  // Not public: this one is admin-only in both navs.
  const sectionBlock = consoleJs.slice(consoleJs.indexOf('SECTIONS: ['),
    consoleJs.indexOf('isOpen()'));
  const entry = sectionBlock.slice(sectionBlock.indexOf("key: 'mail'"));
  assert.ok(!/public: true/.test(entry.slice(0, 120)),
    'the mail section must not be reachable without admin');
});

test('the module hides the send form from a view-only admin', () => {
  assert.match(moduleJs, /canWrite\(\)\s*\?/,
    'the form is rendered only for a full admin');
  assert.match(moduleJs, /needs full admin access/,
    'and a view-only admin is told why, rather than shown a dead button');
});

test('the module escapes everything it renders', () => {
  // Recipients and provider error strings come from the ledger, which is
  // fed by user-supplied addresses. Every interpolation into innerHTML
  // must go through esc().
  assert.match(moduleJs, /AdminConsole\.esc\(s\)/);
  for (const field of ['r.recipient', 'r.error', 'r.provider', 'r.kind',
    'outcome.status', 'outcome.provider', 'outcome.error']) {
    assert.ok(moduleJs.includes(`esc(${field}`),
      `${field} is escaped before it reaches innerHTML`);
  }
});

test('an unanswered request is reported differently from a refused send', () => {
  // fetchJson returns status 0 when the request never got a reply. Saying
  // "failed" there would be a claim about the mailer we have no evidence
  // for — the email may well have gone out.
  assert.match(moduleJs, /res\.status === 0/);
  assert.match(moduleJs, /Could not reach the platform/);
  assert.match(moduleJs, /whether the email was attempted is\s*\n?\s*unknown/,
    'the copy is explicit about the ambiguity');
});

test('destroy() makes in-flight responses harmless', () => {
  // Nothing here polls, so the teardown is generational: a status,
  // activity or test response that lands after the operator navigated
  // away must not write into the next section's host element.
  assert.match(moduleJs, /generation \+= 1/);
  assert.match(moduleJs, /if \(mine !== generation\) return;/);
  const destroy = moduleJs.slice(moduleJs.indexOf('destroy() {'));
  assert.match(destroy.slice(0, 400), /generation \+= 1/,
    'destroy() bumps the generation');
});
