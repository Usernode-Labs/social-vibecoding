// The launchpad — what a session shows instead of a composer when the work
// is happening somewhere else (#1281).
//
// Three of the six venues build elsewhere, and for all three a chat box is
// a control with nothing on the other end of it: no turn will ever run in
// this session. The spec's type 2 and 3 wireframes draw that literally —
// no composer, just the steps — so public/js/launchpad.js owns the panel
// that stands in its place and dev-chat.js swaps them.
//
// What these tests pin:
//
//   1. WHICH venues get a launchpad, and that the list agrees with the
//      `chat: false` rows in build-venues.js rather than being a second
//      opinion about the same thing;
//   2. the prefill is genuinely usable — it names the app, carries the
//      session's own brief, and spells the two connector calls that
//      bracket the job, because a "tell your agent" block that says
//      "build the thing" is worse than no block at all;
//   3. every string that reaches the markup is escaped, since the app slug
//      and the session title are user content; and
//   4. the copy buttons carry exactly the text that is rendered above
//      them, so what you copy is what you read.
//
// Run with: node --test tests/launchpad.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const Launchpad = require('../public/js/launchpad.js');
const BuildVenues = require('../public/js/build-venues.js');

const ORIGIN = 'https://social-vibecoding.usernodelabs.org';

test('the launchpad venues are exactly the ones with no Usernode chat', () => {
  // build-venues.js already answers this, per venue, with `chat`. This
  // module keeps its own list so it still works loaded alone — so the two
  // have to be asserted equal, or they are free to drift.
  const chatless = BuildVenues.VENUES.filter((v) => !v.chat).map((v) => v.id);
  assert.deepEqual([...Launchpad.LAUNCHPAD_VENUES].sort(), [...chatless].sort());

  for (const id of chatless) assert.ok(Launchpad.isLaunchpad(id), `${id} launches`);
  for (const v of BuildVenues.VENUES.filter((x) => x.chat)) {
    assert.ok(!Launchpad.isLaunchpad(v.id), `${v.id} keeps its composer`);
  }
  // A venue id that is not a venue must not launch anything either.
  assert.ok(!Launchpad.isLaunchpad('nonsense'));
  assert.ok(!Launchpad.isLaunchpad(null));
  assert.ok(!Launchpad.isLaunchpad(undefined));
});

test('the connector URL is derived from the page, never hardcoded', () => {
  // A self-hosted fork has to print its own origin — the same derivation
  // the Settings → Connectors field uses, and the reason neither has to
  // know the deployment's domain.
  assert.equal(Launchpad.connectorUrl(ORIGIN), `${ORIGIN}/mcp`);
  assert.equal(Launchpad.connectorUrl('https://example.test/'), 'https://example.test/mcp');
  assert.equal(Launchpad.connectorUrl('https://example.test///'), 'https://example.test/mcp');
  assert.match(Launchpad.mcpCommand(ORIGIN), /^claude mcp add --transport http usernode https:/);
  // Streamable HTTP is what src/routes/mcp-remote.js actually mounts, so
  // the transport in the command is a fact about the server, not a guess.
  assert.match(Launchpad.mcpCommand(ORIGIN), /--transport http\b/);
});

test('the prefill names the app, the brief, and both connector calls', () => {
  const text = Launchpad.prefillText({
    slug: 'usernode-2d5619',
    issueNumber: 1281,
    sessionTitle: 'Rework build method UI',
  });
  assert.match(text, /usernode-2d5619/, 'names the app');
  assert.match(text, /request #1281/, 'names the request');
  assert.match(text, /Rework build method UI/, 'carries the title');
  assert.match(text, /prepare_work/, 'the call that starts the job');
  assert.match(text, /submit_work/, 'the call that finishes it');
  assert.match(text, /requestNumber 1281/, 'the request rides on prepare_work');
  // The base commit is the single instruction a work order most often
  // loses — see the "know your base commit" rule in AGENTS.md — so the
  // prefill has to say it rather than leaving the agent to infer it.
  assert.match(text, /base commit/i);
  assert.match(text, /testingPaths/, 'or the voters get screenshots of the home page');
});

test('a session with no request falls back to its own title, then to a blank', () => {
  const titled = Launchpad.prefillText({ slug: 'app-1', sessionTitle: 'Add a dark mode' });
  assert.match(titled, /What to build: Add a dark mode/);
  assert.doesNotMatch(titled, /request #/, 'no request number to invent');
  assert.doesNotMatch(titled, /requestNumber/, 'and none on the prepare_work call');

  const bare = Launchpad.prefillText({ slug: 'app-1' });
  assert.match(bare, /<describe the change here>/,
    'an empty brief is an obvious blank to fill in, not a confident lie');

  // No slug at all still produces a runnable shape rather than "undefined".
  const noSlug = Launchpad.prefillText({});
  assert.doesNotMatch(noSlug, /undefined|null/);
  assert.match(noSlug, /<app slug>/);
});

test('a non-numeric or nonsense request number is ignored, not printed', () => {
  for (const issueNumber of ['12; rm -rf /', 0, -3, NaN, null, {}]) {
    const text = Launchpad.prefillText({ slug: 'app-1', issueNumber, sessionTitle: 'A change' });
    assert.doesNotMatch(text, /request #/, `${JSON.stringify(issueNumber)} must not become a request`);
    assert.match(text, /What to build: A change/);
  }
});

test('user content reaches the markup escaped, never as tags', () => {
  // The slug comes from the URL and the title is written by whoever named
  // the session. Both land in a <pre> and in a data attribute.
  const html = Launchpad.ownToolsHtml({
    origin: ORIGIN,
    slug: '"><img src=x onerror=alert(1)>',
    sessionTitle: '</pre><script>alert(2)</script>',
  });
  assert.ok(!html.includes('<img'), 'no raw tag survives');
  assert.ok(!html.includes('<script>'), 'no script survives');
  // `onerror=alert(1)` survives as TEXT, which is correct and harmless —
  // what makes it inert is that every `<` and `"` around it is escaped, so
  // it can neither open a tag nor close the attribute it sits in. That is
  // the property worth asserting, and it is the same one
  // tests/credit-options.test.js pins.
  assert.ok(!html.includes('onerror="'), 'no attribute injection');
  assert.ok(!html.includes('"><img src=x'), 'the raw payload never appears unescaped');
  assert.ok(html.includes('&lt;img'), 'it is rendered as escaped text');
  // The data attribute is the copy payload and is quoted — an unescaped
  // double quote there would break out into new attributes.
  const attrs = html.match(/data-launchpad-text="[^"]*"/g) || [];
  assert.ok(attrs.length >= 2, 'both copy buttons carry their payload');
});

test('the own-tools launchpad is three steps, with both copy blocks', () => {
  const html = Launchpad.ownToolsHtml({ origin: ORIGIN, slug: 'app-1', issueNumber: 7 });
  assert.match(html, /data-launchpad="own-tools-pr"/);
  assert.equal((html.match(/dc-launchpad-step"/g) || []).length, 3);
  assert.match(html, /data-launchpad-copy="connect"/);
  assert.match(html, /data-launchpad-copy="prefill"/);
  assert.match(html, /data-launchpad-action="import"/);
  // What you copy is what you read: the button's payload must be the text
  // rendered above it, not a second derivation of it.
  assert.ok(
    html.includes(Launchpad.escapeHtml(Launchpad.mcpCommand(ORIGIN))),
    'the command is rendered',
  );
  assert.ok(
    html.includes(`data-launchpad-text="${Launchpad.escapeHtml(Launchpad.mcpCommand(ORIGIN))}"`),
    'and the copy button carries the same string',
  );
});

test('a viewer who cannot push is told why, not offered a button that fails', () => {
  const denied = Launchpad.ownToolsHtml({ origin: ORIGIN, slug: 'a', canImport: false });
  assert.doesNotMatch(denied, /data-launchpad-action="import"/);
  assert.match(denied, /push access/i, 'it says why instead of going quiet');
  // The connector path still works for them — submit_work opens the PR —
  // so the step must not read as a dead end.
  assert.match(denied, /submit_work/);

  const allowed = Launchpad.ownToolsHtml({ origin: ORIGIN, slug: 'a' });
  assert.match(allowed, /data-launchpad-action="import"/, 'the default is the button');
});

test('wire() is idempotent per node and reports copies and actions', () => {
  const handlers = [];
  const node = {
    __handlers: handlers,
    addEventListener(type, fn) { handlers.push(fn); },
    contains() { return true; },
  };
  const seen = { copies: [], actions: [] };
  Launchpad.wire(node, {
    onCopy: (key, text) => seen.copies.push([key, text]),
    onAction: (action) => seen.actions.push(action),
  });
  Launchpad.wire(node, { onCopy() {}, onAction() {} });
  assert.equal(handlers.length, 1, 'a second wire() call does not stack handlers');

  const fire = (attrs) => handlers[0]({
    preventDefault() {},
    target: { closest: () => ({ getAttribute: (k) => attrs[k] || null }) },
  });
  fire({ 'data-launchpad-copy': 'prefill', 'data-launchpad-text': 'hello' });
  assert.deepEqual(seen.copies, [['prefill', 'hello']]);
  fire({ 'data-launchpad-action': 'import' });
  assert.deepEqual(seen.actions, ['import']);

  // A click on neither is left alone — the browser keeps whatever default
  // it had, which is what lets ordinary text selection work inside the
  // <pre> blocks.
  handlers[0]({
    preventDefault() { assert.fail('must not preventDefault a plain click'); },
    target: { closest: () => null },
  });
});

// ── The swap: dev-chat renders the launchpad WHERE the composer was ─────
//
// Source guards rather than DOM assertions, for the same reason the rest of
// this repo's chat-view tests are: renderChatView writes one large template
// literal and mounting it needs the whole shell. What is worth pinning is
// the handful of decisions inside it that are easy to undo by accident.

const fs = require('node:fs');
const path = require('node:path');

const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '../frontend/src/features/dev-chat/dev-chat.js'), 'utf8',
);

test('the composer is HIDDEN, never removed', () => {
  // Every public/js/** and chat-helper module looks its controls up by id
  // (#dc-input, #dc-form, #dc-budget, #dc-runner…). A getElementById that
  // started returning null would throw on a route the checks load, and a
  // console error on any route fails proposal checks — so the composer is
  // hidden beside the launchpad rather than replaced by it.
  // #1078: the composer is a component, so the swap is a `hidden` FIELD of
  // its model rather than an interpolation in the template. Same guarantee,
  // read on both halves of the seam.
  assert.match(DEV_CHAT_SRC, /hidden: !!DevChat\._launchpadVenue\(\),/,
    'the model carries the swap');
  assert.match(DEV_CHAT_SRC, /id="dc-launchpad-slot"/);
  const COMPOSER_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'composer.tsx'), 'utf8');
  assert.match(COMPOSER_TSX, /id="dc-composer-controls" hidden=\{s\.hidden \|\| undefined\}/);
  // Both always render, so neither id ever disappears from the document —
  // which is what the `hidden` attribute buys over a conditional subtree.
  const at = COMPOSER_TSX.indexOf('id="dc-composer-controls"');
  const body = COMPOSER_TSX.slice(at);
  assert.ok(body.includes('id="dc-form"'), 'the form is inside it');
  assert.doesNotMatch(body.slice(0, body.indexOf('id="dc-form"')), /s\.hidden \?/,
    'and is not rendered conditionally on the same flag');
});

test('the venue control stays outside the swap — it is the way back', () => {
  // The venue selector is the persistent control the spec asks for. If it
  // were inside #dc-composer-controls it would be hidden by exactly the
  // state it exists to undo, stranding the session in its launchpad. #1348
  // moved it further out of reach of the swap, into the session header.
  // The strip is a component now (features/dev-chat/session-header.tsx) and
  // the button is one of its children, so "outside the swap" is a property of
  // where the HEADER is written rather than of where the string landed.
  // The header is written by `renderChatView`; the swap is inside the
  // composer, which is a different file entirely — so the two cannot be
  // compared by position any more, and the guarantee is stronger for it.
  assert.match(DEV_CHAT_SRC, /id="dc-session-header"/, 'the session header is painted');
  const COMPOSER_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'composer.tsx'), 'utf8');
  assert.ok(COMPOSER_TSX.includes('id="dc-composer-controls"'), 'the swap is the composer\'s');
  assert.doesNotMatch(COMPOSER_TSX, /dc-venue-select/,
    'and the venue selector is not inside the thing it exists to undo');
  const headerTsx = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'session-header.tsx'), 'utf8');
  assert.match(headerTsx, /<VenueSelect/, 'and the venue selector is in that strip');
});

test('the walkthrough repaints on whichever surface it is living on', () => {
  // Every dev-flow action used to end in renderMessages(), because the card
  // was the last row of the transcript. In a launchpad venue renderMessages
  // deliberately omits it, so repainting that way would freeze the card on
  // its pre-click state — the #1304 class of bug.
  assert.match(DEV_CHAT_SRC, /_repaintDevFlow\(\)\s*\{[\s\S]{0,400}dc-launchpad-slot/);
  assert.match(
    DEV_CHAT_SRC,
    /_launchpadVenue\(\) \? '' : DevChat\._devFlowHtml\(\)/,
    'and the transcript drops it so it cannot render twice',
  );
  const actions = DEV_CHAT_SRC.match(/async _devFlowAction\([\s\S]*?\n  \},/);
  assert.ok(actions, '_devFlowAction must exist');
  assert.doesNotMatch(actions[0], /DevChat\.renderMessages\(\)/,
    'no dev-flow action may repaint only the transcript');
});

test('the launchpad is wired on every re-render, in its own host', () => {
  // _wireDevFlowCard only ever scans #dc-messages, so a walkthrough card in
  // the launchpad slot needs its own wiring — a card wired by nobody is
  // every button on it doing nothing.
  const wire = DEV_CHAT_SRC.match(/_wireLaunchpad\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(wire, '_wireLaunchpad must exist');
  assert.match(wire[0], /data-flow-wizard/, 'it wires the walkthrough too');
  assert.match(wire[0], /data-launchpad\b/, 'and the own-tools panel');
  assert.match(DEV_CHAT_SRC, /DevChat\._wireLaunchpad\(\);/, 'called from renderChatView');
});

test('the vendor toggle switches in place and stores the new venue', () => {
  const actions = DEV_CHAT_SRC.match(/async _devFlowAction\([\s\S]*?\n  \},/)[0];
  assert.match(actions, /vendor-claude-code|vendor-codex/, 'both toggle actions are handled');
  assert.match(actions, /_saveDevFlowPreference\(next\)/, 'the saved default moves with it');
  assert.match(actions, /_persistBuildVenue\(venue\)/, 'and so does this session');
  assert.match(actions, /flow\.status = null/,
    'the status is re-read for the new vendor rather than reused');
});

test('the brief field lives in the card, because the composer is hidden', () => {
  const DevFlowSelect = require('../public/js/dev-flow-select.js');
  const ready = { github: { linked: true }, fork: { state: 'ready', owner: 'a', repo: 'b' } };

  // On the step you are on, and only there.
  const html = DevFlowSelect.wizardHtml({ agent: 'codex', status: ready, brief: 'Add dark mode' });
  assert.match(html, /data-flow-brief="1"/, 'the prepare step carries a brief box');
  assert.equal((html.match(/data-flow-brief/g) || []).length, 1, 'exactly one');
  assert.match(html, />Add dark mode</, 'and it keeps what was typed');

  // Once the task exists there is nothing left to describe.
  const prepared = DevFlowSelect.wizardHtml({
    agent: 'codex',
    status: { ...ready, task: { branch: 'b', baseSha: 'abc1234', agent: 'codex' } },
  });
  assert.doesNotMatch(prepared, /data-flow-brief/, 'a prepared task needs no brief box');

  // The step copy must not point at a control the launchpad hides.
  assert.doesNotMatch(html, /message box below/,
    'the composer is not on screen in a launchpad venue');

  // It escapes like everything else — the brief is user text going back
  // into a textarea.
  const nasty = DevFlowSelect.wizardHtml({
    agent: 'codex', status: ready, brief: '</textarea><script>alert(1)</script>',
  });
  assert.ok(!nasty.includes('<script>'), 'no script survives');
  // The rendered card legitimately contains `</textarea>` — its own closing
  // tag. What must not appear is the PAYLOAD verbatim, which is what would
  // mean the brief closed the field and opened a script.
  assert.ok(!nasty.includes('</textarea><script>'), 'and it cannot close its own field');
  assert.match(nasty, /&lt;\/textarea&gt;/, 'it lands as escaped text instead');
});

test('preparing reads the card first and the composer only as a fallback', () => {
  // In a launchpad venue #dc-input is hidden, so reading it would make
  // "Prepare work order" permanently impossible — the button would report
  // an empty brief no matter what the user typed.
  const fn = DEV_CHAT_SRC.match(/async _devFlowPrepare\([\s\S]*?\n  \},/);
  assert.ok(fn, '_devFlowPrepare must exist');
  const body = fn[0];
  const cardAt = body.indexOf("querySelector('[data-flow-brief]')");
  const composerAt = body.indexOf("getElementById('dc-input')");
  assert.ok(cardAt > -1, 'it reads the card field');
  assert.ok(composerAt > cardAt, 'and the composer only after it, as a fallback');
  assert.match(body, /flow\.brief = brief/, 'the brief survives the repaints that follow');
});

test('dismissing a launchpad repaints the whole bar, not just the slot', () => {
  // "Build on Usernode instead" changes the SWAP. Repainting only the slot
  // would empty the launchpad and leave the composer still hidden behind
  // it — a session with no way to type at all.
  const fn = DEV_CHAT_SRC.match(/_repaintDevFlow\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(fn);
  assert.match(fn[0], /inLaunchpad !== composer\.hasAttribute\('hidden'\)/,
    'a changed swap falls through to renderChatView');
  assert.match(fn[0], /renderChatView\(\)/);
});

test('the web launchpad takes its vendor from the VENUE, not the flow target', () => {
  // Regression: _launchpadHtml delegated to _devFlowHtml, which asks
  // _devFlowTarget() which vendor this is. That answers null in cases where
  // the launchpad is legitimately up — a ?shot=launchpad URL stores no
  // venue, and the saved-preference path additionally wants an untouched
  // session, a linked deployment and no PR — so the panel rendered EMPTY.
  // The venue is what put the launchpad on screen, so it is what knows the
  // vendor.
  const fn = DEV_CHAT_SRC.match(/_launchpadHtml\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(fn, '_launchpadHtml must exist');
  const body = fn[0];
  assert.match(body, /agent: venue === 'web-codex' \? 'codex' : 'claude-code'/,
    'the vendor is derived from the venue');
  assert.doesNotMatch(body, /_devFlowHtml\(\)/,
    'and not routed through the target-gated helper');
  assert.match(body, /_devFlowEnsureStatus\(\)/,
    'the status read still has to be kicked on first paint');
});

test('the walkthrough carries its vendor toggle in every state', () => {
  // A staging page paints before the status read resolves, and a clone
  // often answers "unavailable" — so a toggle that only rendered on the
  // live card would be missing exactly where a reviewer looks first.
  const DevFlowSelect = require('../public/js/dev-flow-select.js');
  const states = [null, { available: false, reason: 'no_repository' }, { github: { linked: true } }];
  for (const status of states) {
    const html = DevFlowSelect.wizardHtml({ agent: 'codex', status });
    assert.match(html, /dc-flow-vendors/, `toggle missing for ${JSON.stringify(status)}`);
    assert.match(html, /data-flow-action="vendor-claude-code"/);
    // The vendor you are already on is a statement, so it is inert.
    assert.match(html, /dc-flow-vendor-on[^>]*>ChatGPT|ChatGPT<\/button>/);
  }
});
