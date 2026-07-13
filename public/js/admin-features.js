// Admin cross-app "submitted features" viewer. Lists kind='general' issues
// from every app via GET /api/admin/submitted-features, ranked by up-votes,
// with a status filter (open / closed / all) and a "Download CSV" export
// that pulls the ENTIRE filtered set (looping the offset param) rather than
// just the visible page. Vanilla JS, same auth-gate + esc() + getJSON()
// pattern as debug.js / dashboard.js. Auth rides the same-origin session
// cookie — no explicit token header (that is the iframe child-app pattern,
// not the platform shell).

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const qs = (extra) => {
  const p = new URLSearchParams();
  if (DEMO) p.set('demo', '1');
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null && v !== '') p.set(k, v);
  }
  const s = p.toString();
  return s ? '?' + s : '';
};

// The endpoint caps limit at 200; use that as the CSV paging page size.
const PAGE = 200;

// All fields the endpoint returns, in a stable column order for the CSV.
const CSV_FIELDS = [
  'id', 'app_id', 'app_slug', 'app_name', 'title', 'description',
  'kind', 'status', 'github_issue_number', 'created_at',
  'created_by', 'created_by_username', 'up_count', 'down_count',
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}

function showGate(msg) {
  document.getElementById('content').classList.add('hidden');
  const gate = document.getElementById('gate');
  gate.textContent = msg;
  gate.classList.remove('hidden');
}

function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function currentStatus() {
  // Default matches the page's default-selected <option> ('all') so an
  // admin lands on the full cross-app list rather than a possibly-empty
  // "open" view — shipped features carry status='completed', which is
  // invisible under both open and closed (see #565).
  return document.getElementById('f-status').value || 'all';
}

// ── Row rendering ─────────────────────────────────────────────────────
const STATUS_BADGE = {
  open:      { label: 'Open',    cls: 'bg-green-500/20 text-green-300' },
  closed:    { label: 'Closed',  cls: 'bg-zinc-500/20 text-zinc-300' },
  // Shipped features flip to status='completed' when their PR merges; give
  // them their own violet "Shipped" badge distinct from open/closed (#565).
  completed: { label: 'Shipped', cls: 'bg-violet-500/20 text-violet-300' },
};
function statusBadge(status) {
  const b = STATUS_BADGE[status] || { label: status || '—', cls: 'bg-zinc-500/20 text-zinc-300' };
  return `<span class="text-[11px] font-semibold px-2 py-0.5 rounded ${b.cls}">${esc(b.label)}</span>`;
}

function featureCard(f, rank) {
  const el = document.createElement('div');
  el.className = 'feature-row border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50 dark:bg-zinc-900 p-4';
  const gh = f.github_issue_number
    ? `<span class="text-xs text-zinc-500">GitHub #${esc(f.github_issue_number)}</span>` : '';
  const submitter = f.created_by_username ? esc(f.created_by_username) : '—';
  el.innerHTML = `
    <div class="flex items-start gap-3">
      <div class="text-zinc-400 font-mono text-sm pt-0.5 w-8 shrink-0">#${rank}</div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-semibold">${esc(f.title)}</span>
          ${statusBadge(f.status)}
        </div>
        ${f.description ? `<div class="feat-desc text-sm text-zinc-500 mt-1">${esc(f.description)}</div>` : ''}
        <div class="text-xs text-zinc-500 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="text-violet-400">${esc(f.app_name)}</span>
          <span class="text-zinc-500">${esc(f.app_slug)}</span>
          <span>by ${submitter}</span>
          <span>${esc(fmtTime(f.created_at))}</span>
          ${gh}
        </div>
      </div>
      <div class="text-right text-sm shrink-0">
        <div class="text-green-400 font-semibold">▲ ${esc(f.up_count)}</div>
        <div class="text-zinc-400">▼ ${esc(f.down_count)}</div>
      </div>
    </div>`;
  return el;
}

// ── Load + render the on-screen list ──────────────────────────────────
async function load() {
  const status = currentStatus();
  const container = document.getElementById('features');
  const empty = document.getElementById('empty');
  const summary = document.getElementById('summary');
  container.innerHTML = '';
  empty.classList.add('hidden');
  summary.textContent = 'Loading…';

  let data;
  try {
    data = await getJSON('/api/admin/submitted-features'
      + qs({ status, limit: PAGE, offset: 0 }));
  } catch (err) {
    if (err.status === 403) { showGate('Admin access required.'); return; }
    // Load failure is distinct from an empty list: keep the empty hint
    // hidden and surface a retry-able error in the summary line.
    empty.classList.add('hidden');
    summary.textContent = 'Couldn’t load submitted features — try Refresh.';
    return;
  }

  const features = data.features || [];
  const total = typeof data.total === 'number' ? data.total : features.length;

  if (!features.length) {
    summary.textContent = '';
    // Genuinely-empty result. Nudge toward the widest filter unless the
    // admin is already on it, so "nothing here" reads as a filter choice
    // rather than a broken page.
    empty.textContent = status === 'all'
      ? 'No submitted features yet.'
      : 'No submitted features match this filter — try the “All” status.';
    empty.classList.remove('hidden');
    return;
  }

  features.forEach((f, i) => container.appendChild(featureCard(f, i + 1)));

  summary.textContent = total > features.length
    ? `Showing the top ${features.length} of ${total} — use Download CSV for the full list.`
    : `${total} feature${total === 1 ? '' : 's'}.`;
}

// ── CSV export (entire filtered set) ──────────────────────────────────
function csvCell(v) {
  // Quote every cell and double embedded quotes so commas / newlines /
  // quotes inside titles and descriptions survive.
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

function toCsv(rows) {
  const lines = [CSV_FIELDS.map(csvCell).join(',')];
  for (const r of rows) lines.push(CSV_FIELDS.map((k) => csvCell(r[k])).join(','));
  // Leading CRLF-friendly join; Excel is happy with \n too.
  return lines.join('\r\n');
}

async function fetchAll(status) {
  const all = [];
  let offset = 0;
  let total = Infinity;
  // Hard cap on iterations as a belt-and-suspenders guard against an
  // endpoint that never advances (e.g. a page that keeps returning rows).
  for (let guard = 0; guard < 10000 && all.length < total; guard++) {
    const data = await getJSON('/api/admin/submitted-features'
      + qs({ status, limit: PAGE, offset }));
    const batch = data.features || [];
    if (typeof data.total === 'number') total = data.total;
    if (!batch.length) break; // nothing more to fetch — stop cleanly
    all.push(...batch);
    offset += PAGE;
    if (batch.length < PAGE) break; // last (short) page
  }
  return all;
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function downloadCsv() {
  const btn = document.getElementById('download-csv');
  const status = currentStatus();
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const rows = await fetchAll(status);
    download(`submitted-features-${status}.csv`, toCsv(rows));
  } catch (err) {
    if (err.status === 403) { showGate('Admin access required.'); return; }
    // Non-fatal: surface in the summary line rather than crashing the page.
    document.getElementById('summary').textContent = 'CSV export failed — try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────
async function init() {
  // Admin check up front. The /api/admin/* endpoint is independently
  // enforced server-side; this is only for a clean in-page message. We do
  // NOT navigate away on failure — the heading and shell stay rendered so a
  // transient 401 doesn't bounce an admin to /login and the page stays
  // coherent under headless checks.
  let me = null;
  try {
    me = await getJSON('/api/auth/me');
  } catch (_) {
    showGate('Sign in as an admin to view submitted features.');
    return;
  }
  if (!me.user?.isAdmin) {
    showGate('Admins only — this page lists submitted features across all apps.');
    return;
  }
  document.getElementById('content').classList.remove('hidden');

  document.getElementById('f-status').addEventListener('change', load);
  document.getElementById('refresh').addEventListener('click', load);
  document.getElementById('download-csv').addEventListener('click', downloadCsv);

  await load();
}

init();
