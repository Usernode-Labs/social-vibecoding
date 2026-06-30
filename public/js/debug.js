// Admin merge-debug viewer. Lists merge / conflict-resolution runs from
// /api/debug/merge-runs and renders each as a collapsible per-run step
// timeline. Vanilla JS, same auth-gate + esc() pattern as dashboard.js.

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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function showGate(msg) {
  document.getElementById('content').classList.add('hidden');
  const gate = document.getElementById('gate');
  gate.textContent = msg;
  gate.classList.remove('hidden');
}

// ── Outcome badge ───────────────────────────────────────────────────────
const BADGES = {
  running:            { label: 'Running',              cls: 'bg-sky-500/20 text-sky-300', spin: true },
  merged:             { label: 'Merged',               cls: 'bg-green-500/20 text-green-300' },
  blocked:            { label: 'Blocked',              cls: 'bg-amber-500/20 text-amber-300' },
  conflict_resolving: { label: 'Conflict — resolving', cls: 'bg-sky-500/20 text-sky-300', spin: true },
  conflict_failed:    { label: 'Conflict — failed',    cls: 'bg-red-500/20 text-red-300' },
  awaiting_github:    { label: 'Awaiting GitHub',      cls: 'bg-zinc-500/20 text-zinc-300' },
  noop:               { label: 'No-op',                cls: 'bg-zinc-500/20 text-zinc-400' },
  error:              { label: 'Error',                cls: 'bg-red-500/20 text-red-300' },
};
function badge(status) {
  const b = BADGES[status] || { label: status || '—', cls: 'bg-zinc-500/20 text-zinc-300' };
  const spin = b.spin ? '<span class="inline-block w-2 h-2 mr-1 rounded-full bg-current spin align-middle"></span>' : '';
  return `<span class="text-[11px] font-semibold px-2 py-0.5 rounded ${b.cls}">${spin}${esc(b.label)}</span>`;
}
const LEVEL_DOT = {
  info:  'bg-zinc-400',
  warn:  'bg-amber-400',
  error: 'bg-red-400',
};

function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function fmtDuration(a, b) {
  if (!a) return '';
  const start = new Date(a).getTime();
  const end = b ? new Date(b).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

// ── Run card ────────────────────────────────────────────────────────────
function runCard(run) {
  const title = run.pr_title ? ` — ${esc(run.pr_title)}` : '';
  const pr = run.pr_number ? `PR #${run.pr_number}` : `session ${esc(run.session_id)}`;
  const kindLabel = run.kind === 'conflict_resolution' ? 'conflict resolution' : 'merge';
  const el = document.createElement('div');
  el.className = 'border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50 dark:bg-zinc-900 overflow-hidden';
  el.innerHTML = `
    <button class="run-head w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-zinc-100 dark:hover:bg-zinc-800/60">
      <span class="chev text-zinc-500 transition-transform">▶</span>
      <span class="flex-1 min-w-0">
        <span class="block text-sm font-medium truncate">${esc(run.app_name || run.app_slug || 'unknown app')} · ${esc(pr)}${title}</span>
        <span class="block text-xs text-zinc-500">
          ${esc(kindLabel)} · trigger: ${esc(run.trigger || '—')} · ${run.step_count != null ? run.step_count + ' steps · ' : ''}${esc(fmtTime(run.started_at))} · ${esc(fmtDuration(run.started_at, run.ended_at))}
        </span>
      </span>
      ${badge(run.status)}
    </button>
    <div class="run-body hidden border-t border-zinc-200 dark:border-zinc-800 px-4 py-3"></div>`;

  const head = el.querySelector('.run-head');
  const body = el.querySelector('.run-body');
  const chev = el.querySelector('.chev');
  let loaded = false;
  head.addEventListener('click', async () => {
    const open = !body.classList.contains('hidden');
    if (open) {
      body.classList.add('hidden');
      chev.style.transform = '';
      return;
    }
    body.classList.remove('hidden');
    chev.style.transform = 'rotate(90deg)';
    if (!loaded) {
      body.innerHTML = '<div class="text-xs text-zinc-500">Loading steps…</div>';
      try {
        const data = await getJSON(`/api/debug/merge-runs/${run.id}${qs()}`);
        body.innerHTML = stepsHtml(data.steps || []);
        wireDetailToggles(body);
        loaded = true;
      } catch (e) {
        body.innerHTML = `<div class="text-xs text-red-400">Failed to load steps: ${esc(e.message)}</div>`;
      }
    }
  });
  return el;
}

function stepsHtml(steps) {
  if (!steps.length) return '<div class="text-xs text-zinc-500">No steps recorded.</div>';
  return '<ol class="space-y-1.5">' + steps.map((s) => {
    const dot = LEVEL_DOT[s.level] || LEVEL_DOT.info;
    const hasDetail = s.detail && Object.keys(s.detail).length > 0;
    const detailJson = hasDetail ? esc(JSON.stringify(s.detail, null, 2)) : '';
    return `<li class="text-sm">
      <div class="flex items-start gap-2">
        <span class="mt-1.5 w-2 h-2 rounded-full ${dot} flex-shrink-0"></span>
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline gap-2">
            <span class="text-[10px] uppercase tracking-wide text-zinc-500 font-mono">${esc(s.phase || '')}</span>
            <span class="text-[10px] text-zinc-600">${esc(fmtTime(s.created_at))}</span>
          </div>
          <div class="${s.level === 'error' ? 'text-red-300' : s.level === 'warn' ? 'text-amber-300' : 'text-zinc-200'}">${esc(s.message || '')}</div>
          ${hasDetail ? `<button class="detail-toggle text-[11px] text-violet-400 hover:text-violet-300 mt-0.5">detail</button>
            <pre class="detail-body hidden step-detail mt-1 text-[11px] text-zinc-400 bg-zinc-100 dark:bg-zinc-950 rounded p-2 border border-zinc-200 dark:border-zinc-800">${detailJson}</pre>` : ''}
        </div>
      </div>
    </li>`;
  }).join('') + '</ol>';
}

function wireDetailToggles(root) {
  root.querySelectorAll('.detail-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pre = btn.nextElementSibling;
      if (pre) pre.classList.toggle('hidden');
    });
  });
}

// ── State + loading ─────────────────────────────────────────────────────
let cursor = null;       // { before, before_id } for the next "Load older"
let liveTimer = null;

function currentFilters() {
  return {
    app: document.getElementById('f-app').value,
    pr_number: document.getElementById('f-pr').value.trim(),
    session_id: document.getElementById('f-session').value.trim(),
    outcome: document.getElementById('f-outcome').value,
    kind: document.getElementById('f-kind').value,
  };
}

async function loadFirstPage() {
  const runsEl = document.getElementById('runs');
  try {
    const data = await getJSON('/api/debug/merge-runs' + qs(currentFilters()));
    runsEl.innerHTML = '';
    (data.runs || []).forEach((r) => runsEl.appendChild(runCard(r)));
    cursor = data.nextCursor || null;
    document.getElementById('empty').classList.toggle('hidden', (data.runs || []).length > 0);
    document.getElementById('load-older').classList.toggle('hidden', !data.hasMore);
  } catch (e) {
    runsEl.innerHTML = `<div class="text-sm text-red-400">Failed to load: ${esc(e.message)}</div>`;
  }
}

async function loadOlder() {
  if (!cursor) return;
  const runsEl = document.getElementById('runs');
  try {
    const data = await getJSON('/api/debug/merge-runs' + qs({ ...currentFilters(), ...cursor }));
    (data.runs || []).forEach((r) => runsEl.appendChild(runCard(r)));
    cursor = data.nextCursor || null;
    document.getElementById('load-older').classList.toggle('hidden', !data.hasMore);
  } catch (e) {
    console.error('Load older failed', e);
  }
}

async function loadApps() {
  try {
    const data = await getJSON('/api/debug/apps' + qs());
    const sel = document.getElementById('f-app');
    (data.apps || []).forEach((a) => {
      const o = document.createElement('option');
      o.value = a.slug;
      o.textContent = `${a.name || a.slug} (${a.run_count})`;
      sel.appendChild(o);
    });
  } catch { /* non-fatal — filter just stays "All apps" */ }
}

function setLive(on) {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (on) liveTimer = setInterval(loadFirstPage, 3000);
}

async function init() {
  // Admin check up front. The /api/debug/* endpoints are independently
  // enforced server-side; this is only for a clean in-page message. We do
  // NOT navigate away on failure — the "Merge debug" heading and page shell
  // stay rendered (a transient 401 shouldn't bounce an admin to /login, and
  // it keeps the page coherent under headless checks).
  let me = null;
  try {
    me = await getJSON('/api/auth/me');
  } catch (_) {
    showGate('Sign in as an admin to view merge logs.');
    return;
  }
  if (!me.user?.isAdmin) {
    showGate('Admins only — this page shows merge & conflict-resolution logs.');
    return;
  }
  document.getElementById('content').classList.remove('hidden');

  document.getElementById('apply').addEventListener('click', () => { setLive(false); document.getElementById('live').checked = false; loadFirstPage(); });
  document.getElementById('refresh').addEventListener('click', loadFirstPage);
  document.getElementById('load-older').addEventListener('click', loadOlder);
  document.getElementById('live').addEventListener('change', (e) => setLive(e.target.checked));

  await loadApps();
  await loadFirstPage();
}

init();
