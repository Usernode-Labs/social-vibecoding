'use strict';

import { AdminUI } from './admin-console.js';

// Read-only mobile push diagnostics (#admin/push). The server deliberately
// returns operational metadata only: this module never receives an FCM token,
// encrypted registration, token hash, APNs key or service-account value.
const AdminPush = (() => {
  let host = null;
  let generation = 0;
  let requestGeneration = 0;

  const esc = (value) => (window.AdminConsole
    ? AdminConsole.esc(value)
    : String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  function fmtTime(value) {
    if (!value) return '—';
    try { return new Date(value).toLocaleString(); } catch { return String(value); }
  }

  function badge(status) {
    switch (status) {
      case 'sent':
      case 'registration_active':
      case 'provider_accepted':
        return AdminUI.badge.success;
      case 'pending':
      case 'sending':
      case 'provider_retrying':
      case 'provider_sending':
      case 'delivery_missing':
        return AdminUI.badge.warn;
      case 'dead':
      case 'cancelled':
      case 'registration_missing':
      case 'permission_ineligible':
      case 'session_inactive':
        return AdminUI.badge.destructive;
      default:
        return AdminUI.badge.default;
    }
  }

  function diagnosticClasses(severity) {
    switch (severity) {
      case 'success':
        return 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200';
      case 'error':
        return 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200';
      case 'warning':
        return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200';
      default:
        return 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200';
    }
  }

  function renderRuntime(runtime, deployment) {
    const runtimeReady = runtime && runtime.enabled
      && runtime.environment && runtime.firebaseProjectId;
    const rows = (deployment || []).map((row) => `
      <div class="rounded-lg border border-gray-200 dark:border-gray-800 p-3 text-sm">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <code class="font-mono text-xs">${esc(row.environment)}</code>
          <span class="${row.send_enabled ? AdminUI.badge.success : AdminUI.badge.destructive}">
            ${row.send_enabled ? 'sending' : 'disabled'}
          </span>
        </div>
        <dl class="mt-2 space-y-1 text-xs">
          <div class="flex gap-2"><dt class="text-gray-500 w-28 shrink-0">Firebase project</dt><dd class="font-mono break-all">${esc(row.firebase_project_id)}</dd></div>
          <div class="flex gap-2"><dt class="text-gray-500 w-28 shrink-0">Active since</dt><dd>${esc(fmtTime(row.send_not_before))}</dd></div>
          <div class="flex gap-2"><dt class="text-gray-500 w-28 shrink-0">State updated</dt><dd>${esc(fmtTime(row.updated_at))}</dd></div>
        </dl>
      </div>`).join('');

    return `
      <section class="${AdminUI.card} p-5">
        <div class="${AdminUI.cardHeader}">
          <div>
            <h3 class="${AdminUI.cardTitle}">Sender health</h3>
            <p class="${AdminUI.cardDescription}">Runtime configuration and durable deployment state.</p>
          </div>
          <span class="${runtimeReady ? AdminUI.badge.success : AdminUI.badge.destructive}">
            ${runtimeReady ? 'configured' : 'incomplete'}
          </span>
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <div class="rounded-lg border border-gray-200 dark:border-gray-800 p-3 text-sm">
            <div class="font-medium">Running process</div>
            <dl class="mt-2 space-y-1 text-xs">
              <div class="flex gap-2"><dt class="text-gray-500 w-28 shrink-0">Sender</dt><dd>${runtime?.enabled ? 'enabled' : 'disabled'}</dd></div>
              <div class="flex gap-2"><dt class="text-gray-500 w-28 shrink-0">Environment</dt><dd class="font-mono">${esc(runtime?.environment || '—')}</dd></div>
              <div class="flex gap-2"><dt class="text-gray-500 w-28 shrink-0">Firebase project</dt><dd class="font-mono break-all">${esc(runtime?.firebaseProjectId || '—')}</dd></div>
            </dl>
          </div>
          ${rows || `<p class="${AdminUI.muted} p-3">No deployment state has been recorded.</p>`}
        </div>
      </section>`;
  }

  function renderFleet(overview) {
    const platforms = new Map((overview.registrations || []).map((row) => [row.platform, row]));
    const cards = ['ios', 'android'].map((platform) => {
      const row = platforms.get(platform) || { total: 0, eligible: 0, last_seen_at: null };
      const label = platform === 'ios' ? 'iOS' : 'Android';
      return `
        <div class="${AdminUI.card} p-4">
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium">${label}</span>
            <span class="${Number(row.eligible) > 0 ? AdminUI.badge.success : AdminUI.badge.warn}">${esc(row.eligible)} eligible</span>
          </div>
          <div class="text-2xl font-semibold mt-2">${esc(row.total)}</div>
          <div class="text-xs text-gray-500 mt-1">registrations · last seen ${esc(fmtTime(row.last_seen_at))}</div>
        </div>`;
    }).join('');

    const activity = (overview.deliveriesLast24h || []).slice(0, 12).map((row) => `
      <li class="flex items-start justify-between gap-3 border-b border-gray-100 dark:border-gray-800 py-2 last:border-0">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-medium">${esc(row.platform)}</span>
            <span class="${badge(row.status)}">${esc(row.status)}</span>
            ${row.last_error_code ? `<code class="font-mono text-xs break-all">${esc(row.last_error_code)}</code>` : ''}
          </div>
          <div class="text-xs text-gray-500 mt-1">last updated ${esc(fmtTime(row.last_updated_at))}</div>
        </div>
        <span class="text-sm font-semibold">${esc(row.total)}</span>
      </li>`).join('');

    return `
      <section>
        <h3 class="${AdminUI.sectionTitle} mb-3">Last 24 hours</h3>
        <div class="grid gap-3 sm:grid-cols-2">${cards}</div>
        <div class="${AdminUI.card} p-4 mt-3">
          <div class="font-medium mb-2">Delivery outcomes</div>
          ${activity ? `<ul>${activity}</ul>` : `<p class="${AdminUI.muted}">No delivery activity recorded.</p>`}
        </div>
      </section>`;
  }

  function renderDiagnostics(diagnostics) {
    return (diagnostics || []).map((item) => `
      <div class="rounded-lg border p-3 text-sm ${diagnosticClasses(item.severity)}">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-semibold">${esc(item.platform === 'ios' ? 'iOS' : 'Android')} · ${esc(item.area)}</span>
          <code class="font-mono text-xs">${esc(item.code)}</code>
        </div>
        <p class="mt-1">${esc(item.message)}</p>
      </div>`).join('');
  }

  function renderRegistrations(registrations) {
    if (!(registrations || []).length) {
      return `<p class="${AdminUI.muted}">No current device registrations.</p>`;
    }
    return registrations.map((row) => `
      <article class="rounded-lg border border-gray-200 dark:border-gray-800 p-4 text-sm">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div class="flex items-center gap-2">
            <span class="font-semibold">${esc(row.platform)}</span>
            <span class="${row.delivery_eligible ? AdminUI.badge.success : AdminUI.badge.destructive}">
              ${row.delivery_eligible ? 'eligible' : 'inactive'}
            </span>
            <span class="${badge(row.permission_status)}">${esc(row.permission_status)}</span>
          </div>
          <code class="font-mono text-xs">#${esc(row.id)}</code>
        </div>
        <dl class="mt-3 grid gap-1 text-xs">
          <div><dt class="inline text-gray-500">Environment: </dt><dd class="inline font-mono">${esc(row.environment)}</dd></div>
          <div><dt class="inline text-gray-500">Installation: </dt><dd class="inline font-mono break-all">${esc(row.installation_id)}</dd></div>
          <div><dt class="inline text-gray-500">Session expires: </dt><dd class="inline">${esc(fmtTime(row.session_expires_at))}</dd></div>
          <div><dt class="inline text-gray-500">Last seen: </dt><dd class="inline">${esc(fmtTime(row.last_seen_at))}</dd></div>
          <div><dt class="inline text-gray-500">Updated: </dt><dd class="inline">${esc(fmtTime(row.updated_at))}</dd></div>
        </dl>
      </article>`).join('');
  }

  function renderDelivery(delivery) {
    return `
      <div class="rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-800 p-3 text-xs">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-semibold">${esc(delivery.platform)}</span>
          <span class="${badge(delivery.status)}">${esc(delivery.status)}</span>
          <span>${esc(delivery.attempts)} attempt${Number(delivery.attempts) === 1 ? '' : 's'}</span>
          ${delivery.errorCode ? `<code class="font-mono break-all">${esc(delivery.errorCode)}</code>` : ''}
        </div>
        <div class="mt-2 grid gap-1 text-gray-500">
          <span>Environment <code class="font-mono">${esc(delivery.environment)}</code></span>
          <span>Installation <code class="font-mono break-all">${esc(delivery.installationId)}</code></span>
          <span>Created ${esc(fmtTime(delivery.createdAt))}</span>
          <span>Sent ${esc(fmtTime(delivery.sentAt))}</span>
          <span>Updated ${esc(fmtTime(delivery.updatedAt))}</span>
        </div>
      </div>`;
  }

  function renderNotifications(notifications) {
    if (!(notifications || []).length) {
      return `<p class="${AdminUI.muted}">No recent push-capable inbox notifications.</p>`;
    }
    return notifications.map((notification) => `
      <article class="${AdminUI.card} p-4">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-semibold">${esc(notification.kind)}</span>
              <span class="${notification.pushEnabled ? AdminUI.badge.success : AdminUI.badge.warn}">
                ${notification.pushEnabled ? 'push enabled' : 'push disabled'}
              </span>
              <span class="${AdminUI.badge.secondary}">${esc(notification.category)}</span>
            </div>
            <div class="text-xs text-gray-500 mt-1">Notification #${esc(notification.id)} · ${esc(fmtTime(notification.createdAt))}</div>
          </div>
          <span class="text-xs text-gray-500">${notification.readAt ? `read ${esc(fmtTime(notification.readAt))}` : 'unread'}</span>
        </div>
        <div class="grid gap-2 mt-3">
          ${notification.deliveries.length
    ? notification.deliveries.map(renderDelivery).join('')
    : '<div class="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-200">No delivery row was created for this notification.</div>'}
        </div>
      </article>`).join('');
  }

  function renderUser(data) {
    const target = document.getElementById('admin-push-user-result');
    if (!target) return;
    if (!data.lookup) {
      target.innerHTML = `<div class="${AdminUI.card} p-5 ${AdminUI.muted}">Search for an account to inspect its device registrations and recent deliveries.</div>`;
      return;
    }
    if (!data.lookup.found || !data.user) {
      target.innerHTML = `
        <div class="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-200">
          No account matched <code class="font-mono">${esc(data.lookup.query)}</code>.
        </div>`;
      return;
    }

    const preferences = (data.preferences || []).map((row) => `
      <span class="${row.enabled ? AdminUI.badge.success : AdminUI.badge.warn}">${esc(row.category)}: ${row.enabled ? 'on' : 'off'}</span>`).join(' ');
    target.innerHTML = `
      <section class="space-y-4">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 class="text-xl font-semibold text-gray-900 dark:text-gray-100">${esc(data.user.username)}</h3>
            <p class="text-sm text-gray-500">User #${esc(data.user.id)}</p>
          </div>
          <div class="flex gap-2 flex-wrap">${preferences}</div>
        </div>
        <div class="grid gap-2 md:grid-cols-2">${renderDiagnostics(data.diagnostics)}</div>
        <div>
          <h3 class="${AdminUI.sectionTitle} mb-3">Current registrations</h3>
          <div class="grid gap-3 lg:grid-cols-2">${renderRegistrations(data.registrations)}</div>
        </div>
        <div>
          <h3 class="${AdminUI.sectionTitle} mb-3">Recent push-capable inbox activity</h3>
          <div class="grid gap-3">${renderNotifications(data.notifications)}</div>
        </div>
      </section>`;
  }

  function renderData(data) {
    const global = document.getElementById('admin-push-overview');
    if (global) {
      global.innerHTML = `${renderRuntime(data.runtime, data.overview?.deployment)}${renderFleet(data.overview || {})}`;
    }
    renderUser(data);
  }

  async function load(user) {
    const mine = generation;
    const request = ++requestGeneration;
    const global = document.getElementById('admin-push-overview');
    const target = document.getElementById('admin-push-user-result');
    if (global) global.innerHTML = '<p class="text-sm text-gray-500">Loading push deployment health…</p>';
    if (target && user) target.innerHTML = '<p class="text-sm text-gray-500">Loading account diagnostics…</p>';
    const suffix = user ? `?user=${encodeURIComponent(user)}` : '';
    const { ok, data } = await AdminConsole.fetchJson(`/api/admin/mobile-push/diagnostics${suffix}`);
    if (mine !== generation || request !== requestGeneration) return;
    if (!ok || !data) {
      if (global) global.innerHTML = '<p class="text-sm text-rose-600 dark:text-rose-400">Could not load mobile push diagnostics.</p>';
      if (target) target.innerHTML = '';
      return;
    }
    renderData(data);
  }

  function submitLookup(event) {
    event.preventDefault();
    const input = document.getElementById('admin-push-user');
    const query = input?.value?.trim() || '';
    load(query || null);
  }

  return {
    render(hostEl) {
      host = hostEl;
      generation += 1;
      requestGeneration += 1;
      host.innerHTML = `
        <div class="space-y-6">
          <div>
            <h2 class="text-2xl font-semibold text-gray-900 dark:text-gray-100">Push delivery</h2>
            <p class="${AdminUI.muted} mt-1">Trace Social inbox activity from device registration through Firebase provider acceptance. Provider tokens and credentials are never shown.</p>
          </div>
          <div id="admin-push-overview" class="grid gap-4"></div>
          <section class="${AdminUI.card} p-5">
            <div class="${AdminUI.cardHeader}">
              <div>
                <h3 class="${AdminUI.cardTitle}">Account diagnostics</h3>
                <p class="${AdminUI.cardDescription}">Exact match by username, email address or numeric user ID.</p>
              </div>
            </div>
            <form id="admin-push-search" class="flex flex-col gap-2 sm:flex-row">
              <input id="admin-push-user" class="${AdminUI.input}" maxlength="255" autocomplete="off" placeholder="username, email or user ID">
              <button type="submit" class="${AdminUI.btn.primary} shrink-0">Inspect account</button>
            </form>
          </section>
          <div id="admin-push-user-result"></div>
        </div>`;
      document.getElementById('admin-push-search')?.addEventListener('submit', submitLookup);
      load(null);
    },

    destroy() {
      generation += 1;
      requestGeneration += 1;
      host = null;
    },
  };
})();

if (typeof window !== 'undefined') window.AdminPush = AdminPush;
