'use strict';

// Admin before/after screenshot gallery (/gallery). Plain browser script, no
// build step, deliberately shaped like /js/debug.js: a getJSON helper, the
// keyset cursor in a module-level variable, and an up-front /api/auth/me
// admin check that shows an in-page message rather than navigating away.
//
// Tiles are rendered by AppView.visualsTilesHtml (loaded from
// /js/app-view.js) in GALLERY MODE — { preload: 'none', overlay: false } —
// so recordings are click-to-play and the SPA-only comparison overlay isn't
// wired. Reusing that renderer is deliberate: the gallery must show exactly
// what a reviewer sees on a proposal card, including the fell-back /
// no-before captions, and a second renderer would drift.

const PAGE_LIMIT = 20;

let cursor = null;      // { before, before_id } for the next older page
let loading = false;

async function getJSON(url) {
  const resp = await fetch(url, { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function showGate(message) {
  const gate = document.getElementById('gate');
  gate.textContent = message;
  gate.classList.remove('hidden');
}

function currentFilters() {
  const app = document.getElementById('f-app').value;
  const problem = document.getElementById('f-problem').value;
  const params = new URLSearchParams();
  if (app) params.set('app', app);
  if (problem) params.set('problem', problem);
  return params;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Capture-state chip. A NULL state means the proposal merged before capture
// outcomes were persisted — render it as "unknown" rather than mislabelling
// it as a success or a failure.
const CHIP = {
  captured: { label: 'Captured', cls: 'bg-emerald-500/15 text-emerald-400' },
  partial: { label: 'Partial', cls: 'bg-amber-500/15 text-amber-400' },
  console_only: { label: 'No visual change expected', cls: 'bg-zinc-500/15 text-zinc-400' },
  failed: { label: 'Capture failed', cls: 'bg-rose-500/15 text-rose-400' },
};

function chipHtml(state, reason) {
  const chip = CHIP[state] || { label: 'Outcome unknown', cls: 'bg-zinc-500/15 text-zinc-400' };
  const title = reason ? ` title="${esc(reason)}"` : '';
  return `<span class="text-[0.65rem] px-1.5 py-0.5 rounded ${chip.cls}"${title}>${chip.label}</span>`;
}

function proposalCardHtml(p) {
  const tiles = (window.AppView && p.visuals)
    ? window.AppView.visualsTilesHtml(p.visuals, { preload: 'none', overlay: false })
    : '';
  const appLabel = p.appName || p.appSlug || `app ${p.appId}`;
  const appLink = p.appSlug
    ? `<a href="/#app/${esc(p.appSlug)}/dev" class="text-violet-400 hover:text-violet-300">${esc(appLabel)}</a>`
    : esc(appLabel);
  const prLink = (p.prUrl && p.prNumber)
    ? `<a href="${esc(p.prUrl)}" target="_blank" rel="noopener" class="font-mono text-violet-400 hover:underline">PR#${esc(p.prNumber)}</a>`
    : (p.prNumber ? `<span class="font-mono text-zinc-500">PR#${esc(p.prNumber)}</span>` : '');
  const proposalLink = p.appSlug
    ? `<a href="/#app/${esc(p.appSlug)}/dev/proposals/${p.id}" class="text-violet-400 hover:text-violet-300">Open proposal &rarr;</a>`
    : '';
  const meta = [prLink, fmtDate(p.mergedAt) ? esc(fmtDate(p.mergedAt)) : '', proposalLink]
    .filter(Boolean).join(' <span class="text-zinc-600">·</span> ');
  // No tiles is a real state, not an error: console_only / failed proposals
  // legitimately stored nothing. Say which, using the persisted reason.
  const body = tiles || `<div class="text-xs text-zinc-500 dark:text-zinc-400 py-2">
    ${esc(p.captureReason || 'No screenshots were stored for this proposal.')}
  </div>`;

  return `<article class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-3 border border-zinc-200 dark:border-zinc-800">
    <div class="flex items-start justify-between gap-3 mb-1">
      <div class="min-w-0">
        <div class="text-sm font-medium truncate">${esc(p.title || `Proposal ${p.id}`)}</div>
        <div class="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">${appLink} <span class="text-zinc-600">·</span> ${meta}</div>
      </div>
      <div class="shrink-0">${chipHtml(p.captureState, p.captureReason)}</div>
    </div>
    ${body}
  </article>`;
}

function statsHtml(s) {
  if (!s || typeof s.total !== 'number') return '';
  const pct = (n) => (s.total ? Math.round((n / s.total) * 100) : 0);
  const item = (label, n, withPct) => `<span><strong class="text-zinc-700 dark:text-zinc-200">${n}</strong> ${esc(label)}${withPct && s.total ? ` (${pct(n)}%)` : ''}</span>`;
  return [
    item('matching proposals', s.total, false),
    item('complete', s.complete || 0, true),
    item('missing recording', s.missing_recording || 0, true),
    item('missing before', s.missing_before || 0, true),
    item('before fell back', s.before_fell_back || 0, true),
    item('front page only', s.root_only || 0, true),
    item('failed / skipped', s.failed_or_skipped || 0, true),
    (s.unknown_state ? item('outcome not recorded', s.unknown_state, true) : ''),
  ].filter(Boolean).join('');
}

async function loadStats() {
  const el = document.getElementById('stats');
  try {
    const { stats } = await getJSON(`/api/gallery/stats?${currentFilters().toString()}`);
    const html = statsHtml(stats);
    el.innerHTML = html;
    el.classList.toggle('hidden', !html);
    if (html) el.classList.add('flex');
  } catch {
    el.classList.add('hidden');
  }
}

async function loadPage({ append }) {
  if (loading) return;
  loading = true;
  const list = document.getElementById('proposals');
  const older = document.getElementById('load-older');
  const empty = document.getElementById('empty');
  try {
    const params = currentFilters();
    params.set('limit', String(PAGE_LIMIT));
    if (append && cursor) {
      params.set('before', cursor.before);
      params.set('before_id', String(cursor.before_id));
    }
    const data = await getJSON(`/api/gallery/proposals?${params.toString()}`);
    const html = (data.proposals || []).map(proposalCardHtml).join('');
    if (append) list.insertAdjacentHTML('beforeend', html);
    else list.innerHTML = html;
    cursor = data.nextCursor || null;
    older.classList.toggle('hidden', !data.hasMore);
    empty.classList.toggle('hidden', !!list.children.length);
  } catch (err) {
    if (!append) {
      list.innerHTML = `<div class="text-sm text-rose-400">Failed to load the gallery: ${esc(err.message)}</div>`;
    }
  } finally {
    loading = false;
  }
}

async function loadFirstPage() {
  cursor = null;
  await Promise.all([loadPage({ append: false }), loadStats()]);
}

async function loadApps() {
  try {
    const { apps } = await getJSON('/api/gallery/apps');
    const sel = document.getElementById('f-app');
    (apps || []).forEach((a) => {
      const o = document.createElement('option');
      o.value = a.slug || String(a.id);
      o.textContent = `${a.name || a.slug} (${a.proposal_count})`;
      sel.appendChild(o);
    });
  } catch { /* non-fatal — the filter just stays "All apps" */ }
}

async function init() {
  // Admin check up front. The /api/gallery/* endpoints are independently
  // enforced server-side; this is only for a clean in-page message. We do
  // NOT navigate away on failure — a transient 401 shouldn't bounce an admin
  // to /login, and it keeps the page coherent under headless checks.
  let me = null;
  try {
    me = await getJSON('/api/auth/me');
  } catch (_) {
    showGate('Sign in as an admin to view the screenshot gallery.');
    return;
  }
  if (!me.user?.isAdmin) {
    showGate('Admins only — this page shows before/after screenshots for merged proposals.');
    return;
  }
  document.getElementById('content').classList.remove('hidden');

  document.getElementById('apply').addEventListener('click', loadFirstPage);
  document.getElementById('refresh').addEventListener('click', loadFirstPage);
  document.getElementById('load-older').addEventListener('click', () => loadPage({ append: true }));

  await loadApps();
  await loadFirstPage();
}

init();
