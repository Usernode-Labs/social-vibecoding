// The admin console's workspace model (#6456): the open-section tabs, the
// section search and the home page's pinned shortcuts, as plain functions
// over plain data.
//
// Pure on purpose. admin-console.js draws the top bar, the tab strip and the
// search dialog (it owns #admin-nav-desktop, an innerHTML host), and
// admin-overview.tsx draws the home page; both read the decisions from here,
// so the rules are written once and tests/admin-workspace.test.js can run
// them without a DOM. Nothing here touches the document, storage or the
// AdminUI registry, which also keeps this module free of an import cycle with
// admin-console.js.

// The tab list is kept per browser under one versioned key. It stores the
// opened section keys in the order they were opened; Home (overview) is never
// stored, because it is always the first tab and cannot be closed.
export const TABS_KEY = 'admin_open_tabs_v1';

// How many section tabs the strip holds beside Home. Opening a ninth drops
// the oldest one that is not the section on screen.
export const MAX_TABS = 8;

// The home page's shortcuts to the sections admins open most, in this order.
// A viewer sees only the ones visible to them.
export const PINNED_KEYS = Object.freeze(['support', 'users', 'reports', 'status', 'model-costs', 'mail']);

// Other words people use for a section, for the search dialog. A query term
// matches a section when it starts a word of the label, starts one of these,
// or one of these starts it ("bounces" finds Email delivery through "bounce").
export const SEARCH_SYNONYMS = Object.freeze({
  'model-costs': ['spend', 'llm', 'budget', 'cost', 'costs', 'money', 'tokens', 'pricing'],
  mail: ['mail', 'email', 'bounce', 'smtp', 'deliverability'],
  'email-templates': ['mail', 'email', 'template', 'copy'],
  incidents: ['errors', 'error', 'exceptions', 'incidents', 'bugs'],
  reports: ['reports', 'report', 'abuse', 'flag', 'flagged', 'moderation'],
  'db-export': ['backup', 'dump', 'export', 'database', 'db'],
  status: ['health', 'uptime', 'docker', 'cpu', 'load'],
  node: ['chain', 'blocks', 'node'],
  users: ['accounts', 'people', 'roles', 'quota'],
  support: ['help', 'participant', 'points', 'kudos'],
  limits: ['spend', 'caps', 'quota', 'llm'],
  push: ['notifications', 'push'],
  sms: ['text', 'phone'],
  'sign-in': ['login', 'apple', 'google', 'auth'],
  'sql-console': ['sql', 'query', 'database'],
  analytics: ['metrics', 'stats', 'charts'],
  journey: ['north star', 'funnel', 'retention'],
  'homeroom-bot': ['bot', 'ai', 'agent'],
  workflows: ['jobs', 'queue'],
  campaigns: ['maintenance', 'migration'],
  waitlist: ['invites', 'queue'],
});

// ── Tabs ────────────────────────────────────────────────────────────────

/**
 * The stored list, cleaned: only strings, legacy keys resolved, unknown keys
 * and Home dropped, no duplicates, at most MAX_TABS. Anything that is not a
 * JSON array of strings yields an empty list rather than a throw.
 */
export function parseStoredTabs(raw, knownKeys, canonical) {
  let arr;
  try { arr = raw ? JSON.parse(raw) : []; } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const known = new Set(knownKeys);
  const out = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const key = canonical ? canonical(item) : item;
    if (key === 'overview' || !known.has(key) || out.includes(key)) continue;
    out.push(key);
  }
  return out.slice(-MAX_TABS);
}

/**
 * The list after `key` is opened: appended when new, left where it is when it
 * is already open. Past MAX_TABS the oldest tab that is not `key` (the one
 * now on screen) is dropped. Home is never added.
 */
export function addTab(tabs, key, max = MAX_TABS) {
  if (!key || key === 'overview') return tabs.slice();
  const out = tabs.includes(key) ? tabs.slice() : [...tabs, key];
  while (out.length > max) {
    const drop = out.findIndex((k) => k !== key);
    if (drop < 0) break;
    out.splice(drop, 1);
  }
  return out;
}

/**
 * Close `key`. Returns the new list and, when the closed tab was the active
 * one, the section to open in its place: the tab to its right, else the one
 * to its left, else Home. `next` is null when the active tab stays.
 */
export function closeTab(tabs, key, active) {
  const i = tabs.indexOf(key);
  if (i < 0) return { tabs: tabs.slice(), next: null };
  const out = tabs.slice(0, i).concat(tabs.slice(i + 1));
  if (key !== active) return { tabs: out, next: null };
  return { tabs: out, next: out[i] || out[i - 1] || 'overview' };
}

// ── Search ──────────────────────────────────────────────────────────────

const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// How well one query term fits a section, lower is better; -1 is no match.
function termScore(term, section) {
  const label = String(section.label).toLowerCase();
  if (label.startsWith(term)) return 0;
  if (words(section.label).some((w) => w.startsWith(term))) return 1;
  const syn = SEARCH_SYNONYMS[section.key] || [];
  if (syn.some((w) => w.startsWith(term) || (term.length >= 3 && term.startsWith(w)))) return 2;
  if (term.length >= 3 && label.includes(term)) return 3;
  if (words(section.group || '').some((w) => w.startsWith(term))) return 4;
  return -1;
}

/**
 * The sections a query finds, best first; every section in its own order for
 * an empty query. Each term of the query has to match (label, synonym or
 * group), and a section's score is its worst term's. Ties keep menu order.
 */
export function searchSections(sections, query) {
  const terms = words(query);
  if (!terms.length) return sections.slice();
  const scored = [];
  sections.forEach((s, i) => {
    let worst = 0;
    for (const t of terms) {
      const sc = termScore(t, s);
      if (sc < 0) return;
      worst = Math.max(worst, sc);
    }
    scored.push({ s, worst, i });
  });
  scored.sort((a, b) => (a.worst - b.worst) || (a.i - b.i));
  return scored.map((x) => x.s);
}

// ── Home ────────────────────────────────────────────────────────────────

/**
 * The home page's one-line status from /api/admin/overview: the stuck apps
 * and orphan workers are what need a person. Null until the data is in.
 */
export function needsYouSentence(data, dashboard) {
  if (!data || typeof data !== 'object') return null;
  // #7081: an open moderation case needs somebody too, once the dashboard's
  // read is in. Without it the sentence counts what the overview knows.
  const cases = dashboard && dashboard.moderation ? Number(dashboard.moderation.open) || 0 : 0;
  const n = (Array.isArray(data.stuckApps) ? data.stuckApps.length : 0)
    + (Array.isArray(data.orphanWorkers) ? data.orphanWorkers.length : 0) + cases;
  if (n === 0) return 'Nothing needs you right now';
  return n === 1 ? '1 thing needs you' : `${n} things need you`;
}

/** The pinned sections this viewer can open, in PINNED_KEYS order. */
export function pinnedSections(visible) {
  return PINNED_KEYS
    .map((k) => visible.find((s) => s.key === k))
    .filter(Boolean);
}

// ── Dashboard (#7081) ───────────────────────────────────────────────────
//
// The home page's figures come from GET /api/admin/dashboard
// (src/services/admin-dashboard.js): counts for a period, each beside the
// count for the period before it. The rules for reading them are here, so
// the page states nothing a test cannot check.

/** The periods the dashboard offers, in days, and the one it opens on. */
export const DASHBOARD_PERIODS = Object.freeze([7, 30, 90]);
export const DASHBOARD_DEFAULT_DAYS = 30;

/**
 * How a count moved against the period before it. `dir` is 'up', 'down' or
 * 'flat'; `text` is the words beside the figure. With nothing before there
 * is no percentage to state, so the words say that instead of inventing one.
 */
export function deltaOf(now, before) {
  const a = Number(now) || 0;
  const b = Number(before) || 0;
  if (a === b) return { dir: 'flat', text: b === 0 ? 'None before either' : 'Same as before' };
  if (b === 0) return { dir: 'up', text: 'None the period before' };
  const pct = Math.round(Math.abs(a - b) / b * 100);
  const shown = pct === 0 ? 'under 1%' : `${pct}%`;
  return a > b ? { dir: 'up', text: `Up ${shown}` } : { dir: 'down', text: `Down ${shown}` };
}

/** "the 30 days before", for the line under a figure. */
export function beforeWords(days) {
  return `vs the ${Number(days) || DASHBOARD_DEFAULT_DAYS} days before`;
}

/**
 * What needs an admin, most pressing first, from the two reads the home page
 * makes: the overview (stuck apps, orphan workers) and the dashboard (open
 * moderation cases). Each names the section that deals with it. Empty when
 * nothing does; null while neither read is in.
 */
export function attentionItems(overview, dashboard) {
  if (!overview && !dashboard) return null;
  const out = [];
  const open = dashboard && dashboard.moderation ? Number(dashboard.moderation.open) || 0 : 0;
  if (open > 0) {
    out.push({ key: 'moderation', section: 'reports', tone: 'warn', text: open === 1 ? '1 moderation case is open' : `${open} moderation cases are open` });
  }
  const stuck = overview && Array.isArray(overview.stuckApps) ? overview.stuckApps.length : 0;
  if (stuck > 0) {
    out.push({ key: 'stuck', section: 'status', tone: 'bad', text: stuck === 1 ? '1 project is stuck being made' : `${stuck} projects are stuck being made` });
  }
  const orphans = overview && Array.isArray(overview.orphanWorkers) ? overview.orphanWorkers.length : 0;
  if (orphans > 0) {
    out.push({ key: 'orphans', section: 'status', tone: 'warn', text: orphans === 1 ? '1 worker has no session' : `${orphans} workers have no session` });
  }
  return out;
}

/** "3 hours ago" for a queue row; '' for a date that cannot be read. */
export function agoWords(iso, nowMs = Date.now()) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((nowMs - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

// What a moderation case is about and why it was reported, in words. The
// keys are the server's own (moderation_cases.target_type, the report
// reasons); an unknown one is shown as it is rather than hidden.
const TARGET_WORDS = Object.freeze({ app: 'Project', user: 'Person', app_message: 'Project message', conversation_message: 'Message' });
export function targetWords(type) {
  return TARGET_WORDS[type] || String(type || '').replace(/_/g, ' ');
}
export function reasonWords(reason) {
  const s = String(reason || '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** The sections the home page offers as quick actions, the visible ones, in this order. */
export const QUICK_KEYS = Object.freeze(['reports', 'users', 'waitlist', 'approvals', 'status', 'support']);
export function quickSections(visible) {
  return QUICK_KEYS.map((k) => visible.find((s) => s.key === k)).filter(Boolean);
}
