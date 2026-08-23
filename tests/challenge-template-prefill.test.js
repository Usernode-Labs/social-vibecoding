// Add-challenge form: the template picker fills the whole form (#1063).
//
// WHAT THIS PINS. The picker used to be a bare id-selector: an admin chose
// a template and every other field stayed empty, so the goal, task, reward,
// metric and CTA the template already defines had to be re-typed from the
// Challenge templates screen. Now picking one fills the form, and picking
// a DIFFERENT one fills it again.
//
// The second half is the part a source grep cannot see. Re-filling is not
// "write the new template's values"; it is "make the form show this
// template and nothing else", so a field the new template leaves null has
// to be CLEARED rather than skipped — otherwise the previous template's
// value survives the switch and gets saved as if it had been chosen.
//
// So the shipped admin-topochain.js runs in a vm against a DOM shim (same
// idiom as tests/estimator-card-render.test.js), and the real form is
// driven through the real `change` handler.
//
// Run with: node --test tests/challenge-template-prefill.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const TOPO_SRC = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-topochain.js'), 'utf8')
  // The four lines a bare vm cannot evaluate — the module's imports. Each
  // binding is supplied below instead, as the bundler does in the browser:
  // AdminUI from ADMIN_UI_SRC, the control tokens from TOKENS_SRC, and the
  // React seam from PORTAL_STUB_SRC.
  .replace(/^import [\s\S]*?from '[^']*';$/gm, '');

// The control-styling tokens (frontend/src/features/admin/topochain/tokens.ts).
// The module interpolates them into every screen's markup, so they have to be
// bound before its body runs. Read from the real file rather than restated
// here: a restated copy would keep passing after the real one changed.
const TOKENS_SRC = (() => {
  const src = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/tokens.ts'), 'utf8');
  const body = src.slice(src.indexOf('export const BTN_BASE'));
  assert.ok(body.length > 500, 'tokens.ts exports its token block');
  return body.replace(/^export const/gm, 'var');
})();

// The fetch helpers (frontend/src/features/admin/topochain/api.ts). Read from
// the real file for the same reason as the tokens: AdminTopochain.fetchJson
// delegates to this copy, so a restated one would keep passing after the real
// contract changed. `export`/type annotations are stripped for the vm — the
// bodies are plain JS.
const API_SRC = (() => {
  const src = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/api.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function fetchJson'));
  assert.ok(body.includes('export async function send'), 'api.ts exports both helpers');
  return body
    .replace(/^export /gm, '')
    .replace(/^\s*url: string,$/m, '  url,')
    .replace(/^\s*opts\?: RequestInit,$/m, '  opts,')
    .replace(/\): Promise<\{ status: number; ok: boolean; data: any \}> \{/, ') {')
    .replace(/function send\(method: string, url: string, body\?: unknown\)/, 'function send(method, url, body)')
    .replace(/const opts: RequestInit = \{ method \};/, 'const opts = { method };');
})();

// The React seam. TOPO_REACT_SCREENS maps a screen key to a portal mount, and
// a vm cannot render React — so it is stubbed EMPTY, which makes _renderSub
// fall through to the innerHTML switch for every screen. That is the right
// stub for this file: the challenge form lives on season-events, which is one
// of the screens still rendered that way.
const PORTAL_STUB_SRC = 'var TOPO_REACT_SCREENS = {};\n'
  + 'function unmountLegacyPortal() {}\n';

// The module's PANEL_CLS reads AdminUI at load time, so the registry has to
// be bound before the module body runs. Same extraction as the estimator test.
const ADMIN_UI_SRC = (() => {
  const consoleSrc = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-console.js'), 'utf8');
  const m = consoleSrc.match(/export const AdminUI = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert.ok(m, 'admin-console.js defines the AdminUI registry');
  return m[0].replace(/^export const/, 'var');
})();

// ── Two staging-shaped templates, straight out of the seed ─────────────
//
// 900501 defines a metric; 900500 defines none. Switching between them is
// exactly the "the new template is silent about this field" case.
const TEMPLATE_WITH_METRIC = {
  id: 900501,
  category: 'onchain',
  goal: 'Send your first testnet transaction',
  task: 'Send a transaction on the testnet within the event window.',
  reward: '100 points',
  description: 'Send-transaction challenge template.',
  requirements: null,
  schedule_start: '2026-03-01T09:00:00.000Z',
  schedule_end: null,
  reward_logic: null,
  cta_button: 'Open wallet',
  cta_label: 'Send it',
  cta_link: 'https://example.com/wallet',
  kind: 'SEND_TRANSACTION_CHALLENGE',
  cta_type: 'url',
  mobile_cta_type: 'app',
  mobile_cta_label: 'Open the wallet',
  mobile_cta_link: 'usernode://wallet',
  metric_type: 'transactions_sent',
  metric_target: 1,
  metric_label: 'transactions',
};
const TEMPLATE_BARE = {
  id: 900500,
  category: 'bug',
  goal: 'Report a reproducible bug',
  task: 'Find and file a reproducible bug report against the testnet client.',
  reward: '250 points',
  description: 'Bug-report challenge template.',
  requirements: null,
  schedule_start: null,
  schedule_end: null,
  reward_logic: null,
  cta_button: null,
  cta_label: null,
  cta_link: null,
  kind: 'REPORT_BUG_CHALLENGE',
  cta_type: null,
  mobile_cta_type: null,
  mobile_cta_label: null,
  mobile_cta_link: null,
  metric_type: null,
  metric_target: null,
  metric_label: null,
};

// ── DOM shim ───────────────────────────────────────────────────────────
//
// Small, but it does parse the generated markup: this module builds forms
// as HTML strings and then looks the controls up by id, so a shim that
// doesn't register what innerHTML contained can't run the code at all.

function decode(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
}

function makeElement(tagName, id) {
  const el = {
    tagName: tagName.toUpperCase(),
    id: id || '',
    value: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: {},
    _attrs: {},
    _handlers: {},
    options: null,
    setAttribute(n, v) { el._attrs[n] = String(v); },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(el._attrs, n) ? el._attrs[n] : null; },
    removeAttribute(n) { delete el._attrs[n]; },
    addEventListener(type, fn) { (el._handlers[type] = el._handlers[type] || []).push(fn); },
    removeEventListener() {},
    appendChild() {},
    remove() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    // Fire a listener the module bound, with the event shape it reads.
    fire(type) { (el._handlers[type] || []).forEach((fn) => fn({ target: el })); },
  };
  el.classList = {
    _set: new Set(),
    add: (c) => el.classList._set.add(c),
    remove: (c) => el.classList._set.delete(c),
    toggle() {},
    contains: (c) => el.classList._set.has(c),
  };
  return el;
}

// Register every id-bearing control (and every id-bearing plain element)
// the assigned markup contains, replacing whatever the host held before.
function parseInto(html, register) {
  const seen = new Set();
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/g;
  for (let m = selectRe.exec(html); m; m = selectRe.exec(html)) {
    const id = attr(m[1], 'id');
    if (!id) continue;
    const el = makeElement('select', id);
    el.options = [];
    const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/g;
    for (let o = optRe.exec(m[2]); o; o = optRe.exec(m[2])) {
      const opt = makeElement('option', '');
      opt.value = attr(o[1], 'value') ?? '';
      opt.textContent = decode(o[2]);
      if (/\bselected\b/.test(o[1])) { opt.setAttribute('selected', 'selected'); el.value = opt.value; }
      el.options.push(opt);
    }
    seen.add(id);
    register(id, el);
  }
  const textareaRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g;
  for (let m = textareaRe.exec(html); m; m = textareaRe.exec(html)) {
    const id = attr(m[1], 'id');
    if (!id) continue;
    const el = makeElement('textarea', id);
    el.value = decode(m[2]);
    el.textContent = el.value;
    seen.add(id);
    register(id, el);
  }
  const inputRe = /<input\b([^>]*?)>/g;
  for (let m = inputRe.exec(html); m; m = inputRe.exec(html)) {
    const id = attr(m[1], 'id');
    if (!id) continue;
    const el = makeElement('input', id);
    const v = attr(m[1], 'value');
    if (v != null) { el.value = v; el.setAttribute('value', v); }
    const t = attr(m[1], 'type');
    if (t) el.setAttribute('type', t);
    seen.add(id);
    register(id, el);
  }
  const anyRe = /<(p|div|button|span|section|label)\b([^>]*)>/g;
  for (let m = anyRe.exec(html); m; m = anyRe.exec(html)) {
    const id = attr(m[2], 'id');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    register(id, makeElement(m[1], id));
  }
}

function loadModule() {
  const elements = new Map();
  const hostOwned = new Map(); // host id -> ids it registered
  const byId = (id) => elements.get(id) || null;

  // Re-creating a host with an id that is already taken DETACHES the old
  // element, as a repaint does: it keeps working as an object, but nothing
  // written into it is reachable by getElementById any more. Without that,
  // a form rendered into an orphaned panel looks indistinguishable from one
  // rendered into the live document.
  function makeHost(id) {
    const previous = elements.get(id);
    if (previous) previous._detached = true;
    const el = makeElement('div', id);
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => html,
      set: (next) => {
        html = String(next);
        if (el._detached) {
          parseInto(html, () => {});
          return;
        }
        for (const owned of hostOwned.get(id) || []) elements.delete(owned);
        const fresh = [];
        parseInto(html, (childId, childEl) => {
          elements.set(childId, childEl);
          fresh.push(childId);
        });
        hostOwned.set(id, fresh);
      },
    });
    elements.set(id, el);
    return el;
  }

  const location = { hash: '', search: '' };
  const history = {
    replaced: [],
    replaceState(_s, _t, url) { history.replaced.push(url); location.hash = url; },
  };
  const fetchCalls = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    location,
    history,
    URLSearchParams,
    URL,
    Date,
    navigator: { language: 'en-US' },
    fetchCalls,
    async fetch(url, opts) {
      fetchCalls.push({ url, opts: opts || {} });
      const body = url.includes('available-activity-types')
        ? { success: true, data: [TEMPLATE_WITH_METRIC, TEMPLATE_BARE] }
        : { success: true, data: [] };
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => body,
      };
    },
  };
  const document = {
    getElementById: byId,
    createElement: (tag) => makeElement(tag, ''),
    body: makeElement('body', 'body'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  sandbox.document = document;
  sandbox.window = {
    document,
    addEventListener() {},
    removeEventListener() {},
    alert() {},
    confirm: () => true,
  };
  // canWrite() reads AdminConsole, as the real page does.
  const adminConsole = { canWrite: () => true, _alert() {}, _confirm: async () => true };
  sandbox.window.AdminConsole = adminConsole;
  sandbox.AdminConsole = adminConsole;
  vm.createContext(sandbox);
  // `var` at a vm context's top level IS the sandbox global, so the module
  // body resolves the bare AdminUI identifier without further wiring.
  vm.runInContext(ADMIN_UI_SRC, sandbox, { filename: 'admin-console.js#AdminUI' });
  vm.runInContext(TOKENS_SRC, sandbox, { filename: 'topochain/tokens.ts' });
  vm.runInContext(API_SRC, sandbox, { filename: 'topochain/api.ts' });
  vm.runInContext(PORTAL_STUB_SRC, sandbox, { filename: 'topochain/screens.tsx#stub' });
  vm.runInContext(TOPO_SRC, sandbox, { filename: 'admin-topochain.js' });
  const Topo = sandbox.window.AdminTopochain;
  assert.ok(Topo, 'AdminTopochain is mirrored onto window');
  return {
    Topo, byId, makeHost, location, history, fetchCalls, elements, adminConsole,
  };
}

// Open the create form on a stub event, the way the detail screen does.
async function openCreateForm(opts = {}) {
  const ctx = loadModule();
  ctx.makeHost('admin-topo-ch-form');
  ctx.Topo._sub = 'season-events';
  ctx.Topo._se.detailId = 900504;
  ctx.location.hash = '#admin/seasons/season-events/900504';
  await ctx.Topo._openChallengeForm(null, opts);
  return ctx;
}

const fieldEl = (ctx, key) => ctx.byId(`admin-topo-ch-f-${key}`);
const fieldVal = (ctx, key) => (fieldEl(ctx, key) || {}).value;

// ── The form itself ────────────────────────────────────────────────────

test('the create form renders a control for every template-backed field', async () => {
  const ctx = await openCreateForm();
  for (const f of ctx.Topo._CH_TEMPLATE_FIELDS) {
    assert.ok(fieldEl(ctx, f.id), `admin-topo-ch-f-${f.id} is rendered — otherwise the prefill has nowhere to write`);
  }
  assert.ok(ctx.byId('admin-topo-ch-f-template'), 'the template picker is rendered');
  assert.ok(ctx.byId('admin-topo-ch-f-display_order'), 'display order is rendered');
});

test('every field starts empty — the fill is what puts values on screen', async () => {
  const ctx = await openCreateForm();
  for (const f of ctx.Topo._CH_TEMPLATE_FIELDS) {
    assert.equal(fieldVal(ctx, f.id), '', `${f.id} starts empty`);
  }
});

// ── Picking a template ─────────────────────────────────────────────────

test('picking a template fills every field that template defines', async () => {
  const ctx = await openCreateForm();
  const picker = ctx.byId('admin-topo-ch-f-template');
  picker.value = '900501';
  picker.fire('change'); // the real listener, not a direct _apply call

  assert.equal(fieldVal(ctx, 'goal'), 'Send your first testnet transaction');
  assert.equal(fieldVal(ctx, 'reward'), '100 points');
  assert.equal(fieldVal(ctx, 'kind'), 'SEND_TRANSACTION_CHALLENGE');
  assert.equal(fieldVal(ctx, 'task'), 'Send a transaction on the testnet within the event window.');
  assert.equal(fieldVal(ctx, 'description'), 'Send-transaction challenge template.');
  assert.equal(fieldVal(ctx, 'cta_button'), 'Open wallet');
  assert.equal(fieldVal(ctx, 'cta_label'), 'Send it');
  assert.equal(fieldVal(ctx, 'cta_type'), 'url');
  assert.equal(fieldVal(ctx, 'cta_link'), 'https://example.com/wallet');
  assert.equal(fieldVal(ctx, 'mobile_cta_label'), 'Open the wallet');
  assert.equal(fieldVal(ctx, 'mobile_cta_type'), 'app');
  assert.equal(fieldVal(ctx, 'mobile_cta_link'), 'usernode://wallet');
  assert.equal(fieldVal(ctx, 'metric_type'), 'transactions_sent');
  assert.equal(fieldVal(ctx, 'metric_label'), 'transactions');
  assert.equal(fieldVal(ctx, 'metric_target'), '1', 'a numeric template value crosses as a string');
  // An ISO instant has to land as a datetime-local value, or the input
  // shows nothing at all.
  assert.match(fieldVal(ctx, 'schedule_start'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  // Fields the template leaves null are empty, not "null".
  assert.equal(fieldVal(ctx, 'requirements'), '');
  assert.equal(fieldVal(ctx, 'reward_logic'), '');
  assert.equal(fieldVal(ctx, 'schedule_end'), '');
});

test('the fill reaches the markup, not just the live value', async () => {
  const ctx = await openCreateForm();
  const picker = ctx.byId('admin-topo-ch-f-template');
  picker.value = '900501';
  picker.fire('change');
  assert.equal(fieldEl(ctx, 'goal').getAttribute('value'), 'Send your first testnet transaction',
    'an input mirrors onto its value attribute');
  assert.equal(fieldEl(ctx, 'task').textContent, 'Send a transaction on the testnet within the event window.',
    'a textarea mirrors onto its text');
  const cta = fieldEl(ctx, 'cta_type');
  const selected = cta.options.filter((o) => o.getAttribute('selected') != null).map((o) => o.value);
  assert.deepEqual(selected, ['url'], 'a select marks exactly the filled option');
  assert.equal(ctx.byId('admin-topo-ch-form').dataset.templateApplied, '900501',
    'the form records which template it is showing');
});

// ── Switching template ────────────────────────────────────────────────

test('switching template re-fills, and CLEARS what the new one does not define', async () => {
  const ctx = await openCreateForm();
  const picker = ctx.byId('admin-topo-ch-f-template');
  picker.value = '900501';
  picker.fire('change');
  assert.equal(fieldVal(ctx, 'metric_type'), 'transactions_sent', 'precondition: filled from the first template');

  picker.value = '900500';
  picker.fire('change');

  assert.equal(fieldVal(ctx, 'goal'), 'Report a reproducible bug', 'the new template overwrites');
  assert.equal(fieldVal(ctx, 'kind'), 'REPORT_BUG_CHALLENGE');
  // 900500 defines no metric, no CTA and no schedule. None of the first
  // template's values may survive.
  for (const key of ['metric_type', 'metric_label', 'metric_target',
    'cta_button', 'cta_label', 'cta_type', 'cta_link',
    'mobile_cta_label', 'mobile_cta_type', 'mobile_cta_link',
    'schedule_start', 'schedule_end']) {
    assert.equal(fieldVal(ctx, key), '', `${key} is cleared, not left stale`);
  }
  assert.equal(fieldEl(ctx, 'metric_type').getAttribute('value'), '',
    'the clear reaches the markup too');
  assert.deepEqual(fieldEl(ctx, 'cta_type').options.filter((o) => o.getAttribute('selected') != null).map((o) => o.value),
    [''], 'the select falls back to its blank option');
});

test('going back to no template empties the form', async () => {
  const ctx = await openCreateForm();
  const picker = ctx.byId('admin-topo-ch-f-template');
  picker.value = '900501';
  picker.fire('change');
  picker.value = '';
  picker.fire('change');
  for (const f of ctx.Topo._CH_TEMPLATE_FIELDS) {
    assert.equal(fieldVal(ctx, f.id), '', `${f.id} is empty again`);
  }
  assert.equal(ctx.Topo._ch.templateId, '');
});

test('display order is the operator\'s, so a template switch leaves it alone', async () => {
  const ctx = await openCreateForm();
  const picker = ctx.byId('admin-topo-ch-f-template');
  ctx.byId('admin-topo-ch-f-display_order').value = '7';
  picker.value = '900501';
  picker.fire('change');
  picker.value = '900500';
  picker.fire('change');
  assert.equal(ctx.byId('admin-topo-ch-f-display_order').value, '7',
    'no template defines display order — clearing it would throw away a real choice');
});

// ── Saving ─────────────────────────────────────────────────────────────

// These columns are per-event overrides where null means "inherit the
// template". A challenge created before the prefill existed stored null in
// all of them, so it tracked later template edits — posting the whole
// filled form back would silently end that for every new challenge.
test('create posts only what the operator changed, so untouched fields keep inheriting', async () => {
  const ctx = await openCreateForm();
  const picker = ctx.byId('admin-topo-ch-f-template');
  picker.value = '900501';
  picker.fire('change');
  // An operator edit on top of the fill must survive.
  ctx.Topo._setFieldValue(fieldEl(ctx, 'reward'), '250 points');

  await ctx.Topo._saveChallenge(900504, null);

  const post = ctx.fetchCalls.find((c) => (c.opts.method || 'GET') === 'POST');
  assert.ok(post, 'the save POSTs');
  const body = JSON.parse(post.opts.body);
  assert.equal(body.challenge_template_id, 900501);
  assert.equal(body.reward, '250 points', 'the edited field is sent as this event\'s override');
  assert.equal(body.goal, null, 'the field left as the template filled it keeps inheriting');
  assert.equal(body.metric_type, null);
  assert.equal(body.metric_target, null);
  assert.equal(body.cta_type, null);
  assert.equal(body.mobile_cta_link, null);
  assert.equal(body.schedule_start, null, 'including the dates, compared in the form\'s own format');
  assert.equal(body.requirements, null, 'a field the template leaves empty stays empty');
  assert.equal(body.display_order, 0);
});

test('an edited date and an edited number are sent in the API\'s types', async () => {
  const ctx = await openCreateForm();
  const picker = ctx.byId('admin-topo-ch-f-template');
  picker.value = '900501';
  picker.fire('change');
  ctx.Topo._setFieldValue(fieldEl(ctx, 'schedule_start'), '2026-10-02T09:30');
  ctx.Topo._setFieldValue(fieldEl(ctx, 'metric_target'), '5');
  ctx.Topo._setFieldValue(fieldEl(ctx, 'requirements'), 'A wallet with testnet funds.');

  await ctx.Topo._saveChallenge(900504, null);
  const body = JSON.parse(ctx.fetchCalls.find((c) => (c.opts.method || 'GET') === 'POST').opts.body);
  assert.match(body.schedule_start, /^\d{4}-\d{2}-\d{2}T/, 'the datetime-local goes back out as an instant');
  assert.equal(body.metric_target, 5, 'numeric field is sent as a number');
  assert.equal(body.requirements, 'A wallet with testnet funds.');
  assert.equal(body.goal, null, 'and the untouched fields are still left inheriting');
});

test('edit still writes only the override keys the API reports back', async () => {
  const ctx = loadModule();
  ctx.makeHost('admin-topo-ch-form');
  ctx.Topo._sub = 'season-events';
  ctx.Topo._se.detailId = 900504;
  ctx.Topo._challenges = [{
    id: 4242,
    display_order: 2,
    activity_type: TEMPLATE_WITH_METRIC,
    overrides: {
      goal: 'Send two transactions', reward: null, task: null, description: null,
      requirements: null, schedule_start: null, schedule_end: null, reward_logic: null,
      cta_button: null, cta_label: null, cta_link: null, enabled: true,
    },
  }];
  await ctx.Topo._openChallengeForm('4242');
  assert.equal(fieldVal(ctx, 'goal'), 'Send two transactions', 'the edit form shows the override');
  assert.equal(ctx.byId('admin-topo-ch-f-template'), null, 'no template picker on an existing challenge');
  assert.equal(fieldEl(ctx, 'metric_type'), null,
    'the metric fields are absent: the list endpoint reports no challenge-level metric, '
    + 'so showing the template\'s would save it as an override');

  await ctx.Topo._saveChallenge(900504, '4242');
  const put = ctx.fetchCalls.find((c) => c.opts.method === 'PUT');
  assert.ok(put, 'the save PUTs');
  assert.deepEqual(Object.keys(JSON.parse(put.opts.body)).sort(),
    ['description', 'display_order', 'goal', 'kind', 'reward', 'task']);
});

// ── The address ────────────────────────────────────────────────────────

test('the Add-challenge form and its template are an address', async () => {
  const ctx = await openCreateForm();
  const picker = ctx.byId('admin-topo-ch-f-template');
  picker.value = '900501';
  picker.fire('change');
  // The write is always the CANONICAL single-level address (#1179) — the
  // legacy #admin/seasons/... starting hash self-heals on the same write.
  assert.equal(ctx.location.hash, '#admin/season-events/900504/new-challenge/900501',
    'the picked template is in the hash, so the filled form can be linked and screenshotted');
});

test('a deep link opens the form already filled from the named template', async () => {
  const ctx = loadModule();
  ctx.makeHost('admin-topo-ch-form');
  ctx.location.hash = '#admin/seasons/season-events/900504/new-challenge/900501';
  ctx.Topo._readSeasonEventsDeepLink('season-events');
  assert.equal(ctx.Topo._se.detailId, 900504, 'the event segment opens the detail screen');
  assert.equal(ctx.Topo._ch.open, true);
  assert.equal(ctx.Topo._ch.pendingTemplateId, '900501');

  ctx.Topo._sub = 'season-events';
  await ctx.Topo._openChallengeForm(null, { templateId: ctx.Topo._ch.pendingTemplateId });
  assert.equal(ctx.byId('admin-topo-ch-f-template').value, '900501', 'the picker shows it');
  assert.equal(fieldVal(ctx, 'goal'), 'Send your first testnet transaction', 'and the form is filled');
});

test('an address with no nested segments resets the nested state', async () => {
  const ctx = loadModule();
  ctx.Topo._se.detailId = 900504;
  ctx.Topo._ch.open = true;
  ctx.Topo._ch.pendingTemplateId = '900501';
  ctx.location.hash = '#admin/seasons/season-events';
  ctx.Topo._readSeasonEventsDeepLink('season-events');
  assert.equal(ctx.Topo._se.detailId, null, 'the event list, not whatever was open last time');
  assert.equal(ctx.Topo._ch.open, false);
  assert.equal(ctx.Topo._ch.pendingTemplateId, null);
});

test('the legacy #admin/topochain prefix deep-links the same nested screens', () => {
  const ctx = loadModule();
  ctx.location.hash = '#admin/topochain/season-events/900504/new-challenge';
  ctx.Topo._readSeasonEventsDeepLink('season-events');
  assert.equal(ctx.Topo._se.detailId, 900504);
  assert.equal(ctx.Topo._ch.open, true);
  assert.equal(ctx.Topo._ch.pendingTemplateId, null, 'no template named, so nothing is applied');
});

// Found in the browser: a second template opened from the same mounted
// console landed on the FIRST one. Entering the screen renders the event
// detail twice, and the detail's own _syncHash runs before the form (and
// its picker) exist. With the previous visit's templateId still in state,
// that early sync overwrote the address currently being read, and render
// #2 then parsed its own stale value back out of it — so the deep link
// was silently ignored in favour of whatever was picked last.
test('the address, not the last visit, decides which template a deep link fills', async () => {
  const ctx = loadModule();
  ctx.makeHost('admin-topo-ch-form');
  ctx.Topo._sub = 'season-events';
  ctx.Topo._se.detailId = 900504;
  // Where the previous visit left off.
  ctx.Topo._ch.templateId = '900500';
  ctx.Topo._ch.open = true;

  ctx.location.hash = '#admin/seasons/season-events/900504/new-challenge/900501';
  ctx.Topo._readSeasonEventsDeepLink('season-events');
  assert.equal(ctx.Topo._ch.templateId, '900501',
    'reading the address adopts its template, so a stale one cannot be written back');

  // The event-detail render syncs the address BEFORE the form exists.
  // The legacy prefix self-heals to the canonical single-level address
  // (#1179), but the deep link's segments come through intact.
  ctx.Topo._syncHash();
  assert.equal(ctx.location.hash, '#admin/season-events/900504/new-challenge/900501',
    'that early sync leaves the deep link intact');

  // Render #2 re-reads it and must reach the same conclusion.
  ctx.Topo._readSeasonEventsDeepLink('season-events');
  assert.equal(ctx.Topo._ch.pendingTemplateId, '900501', 'the re-read is idempotent');
  await ctx.Topo._openChallengeForm(null, { templateId: ctx.Topo._ch.pendingTemplateId });
  assert.equal(fieldVal(ctx, 'goal'), 'Send your first testnet transaction',
    'and the form is filled from the template the address names');
  assert.equal(ctx.location.hash, '#admin/season-events/900504/new-challenge/900501');
});

// Also found in the browser, as a console error (which fails the proposal
// checks on its own): the templates request is awaited, and the detail can
// repaint while it is in flight, which detaches the div captured before it.
test('a repaint during the templates request does not strand the form in a detached node', async () => {
  const ctx = loadModule();
  ctx.makeHost('admin-topo-ch-form');
  ctx.Topo._sub = 'season-events';
  ctx.Topo._se.detailId = 900504;
  const opening = ctx.Topo._openChallengeForm(null, { templateId: '900501' });
  // The repaint: same id, brand-new element, old one orphaned.
  ctx.makeHost('admin-topo-ch-form');
  await opening;
  assert.ok(ctx.byId('admin-topo-ch-save'), 'the save button is in the live document, not the orphan');
  assert.equal(fieldVal(ctx, 'goal'), 'Send your first testnet transaction',
    'and the live form is the filled one');
});

test('a view-only admin cannot open the form, and the segment does not stick', async () => {
  const ctx = loadModule();
  ctx.makeHost('admin-topo-ch-form');
  // The real gate: AdminTopochain.canWrite() defers to AdminConsole's.
  ctx.adminConsole.canWrite = () => false;
  ctx.Topo._sub = 'season-events';
  ctx.Topo._se.detailId = 900504;
  ctx.Topo._ch.open = true;
  ctx.location.hash = '#admin/seasons/season-events/900504/new-challenge/900501';
  await ctx.Topo._openChallengeForm(null, { templateId: '900501' });
  assert.equal(ctx.byId('admin-topo-ch-f-template'), null, 'nothing is rendered');
  assert.equal(ctx.Topo._ch.open, false, 'and the /new-challenge segment is dropped');
  assert.equal(ctx.location.hash, '#admin/season-events/900504',
    'including from the address, which would otherwise promise a form that is not there');
});
