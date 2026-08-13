'use strict';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';

// Email delivery section of the admin console (#admin/mail).
//
// Platform outbound mail is always-200 by contract (SPEC 1667): the OTP
// request and the waitlist join tell the user "check your email" whether
// the mail was delivered, throttled, or never had a transport to go out
// on. That is deliberate — it is what stops the endpoints being account
// oracles — but it means a broken mailer is INVISIBLE from every user
// surface. This section is the compensating visibility, and it answers
// the three questions an operator actually has, in order:
//
//   1. Is mail configured, and as whom?          (status card)
//   2. Does it work RIGHT NOW?                   (send a test)
//   3. What has it been doing?                   (activity ledger)
//
// The status and activity cards deliberately mirror the ones on
// Admin → Settings (the programme settings screen), down to the copy and
// the colours: an
// operator who learned to read one should not have to learn the other.
// That card is untouched; this section reads the newer /api/admin/mail/*
// routes, which add the test send and the per-kind filter it needs.
//
// PERMISSIONS: visible to any admin (full and view-only). The two reads
// are open to both; the test send is full-admin-only, so a view-only
// admin gets an explanatory note where the form would be. The server
// enforces that independently via requireAdminWrite — the hidden form is
// a courtesy, not the control.

const AdminMail = (() => {
  let host = null;
  // Bumped on every render/destroy. An in-flight request that resolves
  // after the operator has navigated away must not write into a host that
  // now belongs to another section.
  let generation = 0;
  let sending = false;
  // Ledger id of the row the last test produced, so it can be pointed at
  // in the table below rather than described in prose.
  let highlightId = null;
  let kindFilter = null;   // null = every kind, 'admin_test' = tests only

  const esc = (s) => (window.AdminConsole
    ? AdminConsole.esc(s)
    : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  const canWrite = () => !!(window.AdminConsole && AdminConsole.canWrite());

  // Non-throwing fetch: an /api/* route that falls through to the SPA
  // shell on auth loss answers 200 + HTML, and res.json() on that throws.
  // `status: 0` means the request never got an answer at all, which the
  // result panel reports differently from a send the platform refused.
  async function fetchJson(url, opts) {
    try {
      const res = await fetch(url, { credentials: 'same-origin', ...(opts || {}) });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return { status: res.status, ok: res.ok, data: null };
      try { return { status: res.status, ok: res.ok, data: await res.json() }; } catch {
        return { status: res.status, ok: res.ok, data: null };
      }
    } catch {
      return { status: 0, ok: false, data: null };
    }
  }

  // ── status card ───────────────────────────────────────────────────

  async function loadStatus() {
    const mine = generation;
    const { ok, data } = await fetchJson('/api/admin/mail/status');
    if (mine !== generation) return;
    const el = document.getElementById('admin-mail-status');
    if (!el) return;

    if (!ok || !data) {
      el.innerHTML = '<p class="text-sm text-gray-500">Could not load the mail configuration.</p>';
      return;
    }

    // Pre-fill the test form with the admin's own address, once the
    // status answers. Never overwrite something already typed.
    const input = document.getElementById('admin-mail-to');
    if (input && !input.value && data.suggestedRecipient) input.value = data.suggestedRecipient;

    const flows = (data.affectedFlows || []).map((f) => `<li>${esc(f)}</li>`).join('');
    // The sender address is safe to render — it is in the From header of
    // every mail the platform sends. No key or endpoint is ever returned.
    const sender = `
      <div class="text-gray-500 mt-1">
        Sending as <code class="font-mono text-xs">${esc(data.from || '(unset)')}</code>${
  data.usingDefaultFrom ? ' <span class="text-gray-400">(built-in default)</span>' : ''}
      </div>`;

    // A staging preview is a clone of production data, so it can never
    // reach a real provider — say so plainly rather than letting a tester
    // read a card and wait for an inbox that will never fill.
    if (data.stagingLogOnly) {
      el.innerHTML = `
        <div class="rounded-lg border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 px-4 py-3 text-sm">
          <div class="font-semibold text-sky-800 dark:text-sky-300">
            Staging preview — email is rendered to the log, never delivered
          </div>
          <p class="text-sky-800/80 dark:text-sky-300/80 mt-1">
            This preview holds a clone of production data, so it must not mail real
            people. Login codes and links appear in the platform log
            (<code class="font-mono text-xs">platform-mail</code>) so you can complete
            a flow by hand. A test send here checks the plumbing up to the
            transport and stops there.
          </p>
          ${sender}
        </div>`;
      return;
    }

    if (data.configured) {
      el.innerHTML = `
        <div class="${AdminUI.card} px-4 py-3 text-sm">
          <span class="font-semibold text-emerald-600 dark:text-emerald-400">Email is configured</span>
          <span class="text-gray-500"> — login codes and waitlist confirmations are being sent
            via <span class="font-medium">${esc(data.provider || 'unknown')}</span>.</span>
          ${sender}
        </div>`;
      return;
    }

    // Per-provider readiness, so the card says which provider needs what
    // instead of a flat "mail is broken".
    const providers = (data.providers || []).map((p) => `
      <li>
        ${esc(p.label || p.name)} —
        ${p.configured
    ? '<span class="text-emerald-700 dark:text-emerald-400">ready</span>'
    : `needs ${(p.missing || []).map((k) => `<code class="font-mono text-xs">${esc(k)}</code>`).join(', ')}`}
      </li>`).join('');

    el.innerHTML = `
      <div class="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm">
        <div class="font-semibold text-amber-800 dark:text-amber-300">
          Email is not deliverable — no mail sender configured
        </div>
        <p class="text-amber-800/80 dark:text-amber-300/80 mt-1">
          These flows still report success to the user but deliver nothing:
        </p>
        <ul class="list-disc ml-5 mt-1 text-amber-800/80 dark:text-amber-300/80">${flows}</ul>
        <p class="text-amber-800/80 dark:text-amber-300/80 mt-2">Providers:</p>
        <ul class="list-disc ml-5 mt-1 text-amber-800/80 dark:text-amber-300/80">${providers}</ul>
        <p class="text-amber-800/80 dark:text-amber-300/80 mt-2">
          Set ${(data.missing || []).map((k) => `<code class="font-mono text-xs">${esc(k)}</code>`).join(', ')}
          in the platform&rsquo;s Platform variables panel, then redeploy. The mailbox
          behind those credentials must also be authorised to send as
          <code class="font-mono text-xs">${esc(data.from || '')}</code>.
        </p>
      </div>`;
  }

  // ── the test send ─────────────────────────────────────────────────

  // Colour per delivery status. `sent` is the only unambiguously good
  // outcome; `suppressed_rate_limit` is the throttle working, not a
  // fault, so it reads as informational rather than red.
  function statusClass(status) {
    if (status === 'sent') return 'text-emerald-700 dark:text-emerald-400';
    if (status === 'failed') return 'text-rose-700 dark:text-rose-400';
    if (status === 'suppressed_rate_limit') return 'text-amber-700 dark:text-amber-400';
    if (status === 'no_transport') return 'text-amber-700 dark:text-amber-400';
    if (status === 'skipped_staging') return 'text-sky-700 dark:text-sky-400';
    return 'text-gray-500';
  }

  // One plain-English sentence per outcome. The raw status is shown too —
  // it is the same word the ledger uses, and an operator comparing the
  // panel to the table below should see the same vocabulary in both.
  function outcomeHeadline(outcome) {
    switch (outcome.status) {
      case 'sent':
        return 'Delivered to the provider. Check the inbox.';
      case 'skipped_staging':
        return 'Rendered to the platform log — staging never delivers mail.';
      case 'failed':
        return 'The provider refused the message.';
      case 'no_transport':
        return 'Nothing was sent — no mail transport is configured.';
      case 'suppressed_rate_limit':
        return 'Held back by the outbound throttle.';
      case 'invalid_recipient':
        return 'Nothing was sent — that address could not be used.';
      default:
        return 'The send finished with an unexpected result.';
    }
  }

  function renderOutcome(outcome) {
    const el = document.getElementById('admin-mail-result');
    if (!el) return;

    const rows = [
      ['Status', `<span class="font-medium ${statusClass(outcome.status)}">${esc(outcome.status)}</span>`],
      ['Provider', esc(outcome.provider || '—')],
      ['Sent as', `<code class="font-mono text-xs">${esc(outcome.from || '(unset)')}</code>`],
      outcome.reference ? ['Reference', `<code class="font-mono text-xs">${esc(outcome.reference)}</code>`] : null,
      outcome.providerMessageId
        ? ['Provider id', `<code class="font-mono text-xs">${esc(outcome.providerMessageId)}</code>`]
        : null,
      Number.isFinite(outcome.durationMs) ? ['Took', `${esc(outcome.durationMs)} ms`] : null,
      outcome.error ? ['Detail', esc(outcome.error)] : null,
    ].filter(Boolean).map(([k, v]) => `
      <div class="flex gap-2">
        <span class="text-gray-500 w-24 shrink-0">${esc(k)}</span>
        <span class="min-w-0 break-words">${v}</span>
      </div>`).join('');

    const subject = outcome.message && outcome.message.subject;

    el.innerHTML = `
      <div class="${AdminUI.card} px-4 py-3 text-sm mt-3">
        <div class="font-semibold mb-2">${esc(outcomeHeadline(outcome))}</div>
        <div class="space-y-1">${rows}</div>
        ${subject ? `<div class="text-xs text-gray-500 mt-2">Subject: ${esc(subject)}</div>` : ''}
      </div>`;
  }

  function renderTransportError() {
    const el = document.getElementById('admin-mail-result');
    if (!el) return;
    // Distinct from every mail outcome: the platform never answered, so
    // we cannot say whether anything was attempted. Saying "failed" here
    // would be a claim about the mailer we have no evidence for.
    el.innerHTML = `
      <div class="rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-sm mt-3">
        <div class="font-semibold text-rose-800 dark:text-rose-300">
          Could not reach the platform
        </div>
        <p class="text-rose-800/80 dark:text-rose-300/80 mt-1">
          The request did not get a reply, so whether the email was attempted is
          unknown. Check the activity table below before sending again.
        </p>
      </div>`;
  }

  async function sendTest() {
    if (sending) return;
    const input = document.getElementById('admin-mail-to');
    const button = document.getElementById('admin-mail-send');
    const to = (input && input.value || '').trim();
    if (!to) {
      const el = document.getElementById('admin-mail-result');
      if (el) el.innerHTML = '<p class="text-sm text-rose-600 dark:text-rose-400 mt-3">Enter an email address first.</p>';
      return;
    }

    sending = true;
    highlightId = null;
    if (button) {
      button.disabled = true;
      button.textContent = 'Sending…';
    }
    const el = document.getElementById('admin-mail-result');
    // A send can legitimately take a while: the transports allow 8s per
    // attempt and retry once, so the honest worst case is ~17 seconds.
    // Say so, rather than letting a patient operator think it hung.
    if (el) {
      el.innerHTML = '<p class="text-sm text-gray-500 mt-3">Sending&hellip; this can take up to about 17 seconds if the provider is slow.</p>';
    }

    const mine = generation;
    const res = await fetchJson('/api/admin/mail/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (mine !== generation) return;

    sending = false;
    const btn = document.getElementById('admin-mail-send');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Send test email';
    }

    if (res.status === 0) { renderTransportError(); return; }

    if (!res.ok || !res.data) {
      const target = document.getElementById('admin-mail-result');
      const message = (res.data && res.data.error) || 'The platform refused the request.';
      if (target) {
        target.innerHTML = `<p class="text-sm text-rose-600 dark:text-rose-400 mt-3">${esc(message)}</p>`;
      }
      return;
    }

    const outcome = res.data.outcome || {};
    highlightId = outcome.deliveryId || null;
    renderOutcome(outcome);
    // The new ledger row is the durable half of the answer — pull it in
    // straight away so the panel and the table agree.
    loadActivity();
  }

  // ── activity ledger ───────────────────────────────────────────────

  async function loadActivity() {
    const mine = generation;
    const url = `/api/admin/mail/activity?limit=25${kindFilter ? `&kind=${encodeURIComponent(kindFilter)}` : ''}`;
    const { ok, data } = await fetchJson(url);
    if (mine !== generation) return;
    const el = document.getElementById('admin-mail-activity');
    if (!el) return;

    if (!ok || !data) {
      el.innerHTML = '<p class="text-sm text-gray-500">Could not load recent activity.</p>';
      return;
    }

    const deliveries = data.deliveries || [];
    const last24h = data.last24h || {};
    const totals = Object.keys(last24h).sort().map((k) => `${esc(k)} ${last24h[k]}`).join(' · ');

    const rows = deliveries.map((r) => `
      <tr class="border-t border-gray-100 dark:border-gray-800${
  highlightId && r.id === highlightId ? ' bg-indigo-50 dark:bg-indigo-950/40' : ''}">
        <td class="py-1.5 pr-3 whitespace-nowrap text-gray-500">${esc(
    r.created_at ? String(r.created_at).replace('T', ' ').slice(0, 19) : '')}</td>
        <td class="py-1.5 pr-3 whitespace-nowrap">${esc(r.kind || '')}</td>
        <td class="py-1.5 pr-3">${esc(r.recipient || '')}</td>
        <td class="py-1.5 pr-3 whitespace-nowrap text-gray-500">${esc(r.provider || '—')}</td>
        <td class="py-1.5 pr-3 whitespace-nowrap font-medium ${
  statusClass(r.status)}">${esc(r.status || '')}</td>
        <td class="py-1.5 text-gray-500">${esc(r.error || '')}</td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h3 class="text-sm font-semibold">Recent email activity</h3>
          <div class="flex items-center gap-2">
            <span class="text-xs text-gray-500">${totals ? `last 24h: ${totals}` : 'nothing in the last 24h'}</span>
            <button id="admin-mail-filter" class="rounded-lg border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs">${
  kindFilter ? 'Show all mail' : 'Test emails only'}</button>
            <button id="admin-mail-refresh" class="rounded-lg border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs">Refresh</button>
          </div>
        </div>
        ${deliveries.length ? `
        <div class="overflow-x-auto mt-2">
          <table class="w-full text-xs">
            <thead class="text-gray-500">
              <tr>
                <th class="text-left font-medium pb-1 pr-3">When</th>
                <th class="text-left font-medium pb-1 pr-3">Kind</th>
                <th class="text-left font-medium pb-1 pr-3">Recipient</th>
                <th class="text-left font-medium pb-1 pr-3">Provider</th>
                <th class="text-left font-medium pb-1 pr-3">Status</th>
                <th class="text-left font-medium pb-1">Detail</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`
    : `<p class="text-sm text-gray-500 mt-2">${
  kindFilter ? 'No test emails have been sent yet.' : 'No mail has been attempted yet.'}</p>`}
      </div>`;

    document.getElementById('admin-mail-refresh')?.addEventListener('click', () => loadActivity());
    document.getElementById('admin-mail-filter')?.addEventListener('click', () => {
      kindFilter = kindFilter ? null : 'admin_test';
      loadActivity();
    });
  }

  // ── section shell ─────────────────────────────────────────────────

  return {
    render(hostEl) {
      host = hostEl;
      generation += 1;
      sending = false;
      highlightId = null;

      const form = canWrite() ? `
        <div class="flex flex-wrap items-end gap-2">
          <label class="block text-xs grow max-w-md">
            <span class="text-gray-500">Recipient</span>
            <input id="admin-mail-to" type="email" autocomplete="off" spellcheck="false"
              placeholder="you@example.com"
              class="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-1.5 text-sm">
          </label>
          <button id="admin-mail-send"
            class="${AdminUI.btn.primary}">Send test email</button>
        </div>
        <p class="text-xs text-gray-500 mt-2">
          Sends one message through the configured provider and reports exactly what
          happened — unlike the flows this checks, which always report success. Up to
          10 per hour, and no more than one to the same address every 30 seconds.
        </p>`
        : `<p class="text-sm text-gray-500">
            Sending a test email needs full admin access. The configuration and the
            delivery history above and below are readable by any admin.
          </p>`;

      host.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 class="${AdminUI.cardTitle}">Email delivery</h2>
        </div>
        <p class="text-sm text-gray-500 mb-4">
          Login codes and waitlist mail are sent on always-200 endpoints, so a user
          is told &ldquo;check your email&rdquo; whether or not anything went out.
          This is where that becomes visible.
        </p>
        <div id="admin-mail-status" class="mb-4"><p class="text-sm text-gray-500">Loading&hellip;</p></div>
        <div class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3 mb-4">
          <h3 class="text-sm font-semibold mb-2">Send a test email</h3>
          ${form}
          <div id="admin-mail-result"></div>
        </div>
        <div id="admin-mail-activity"><p class="text-sm text-gray-500">Loading&hellip;</p></div>`;

      document.getElementById('admin-mail-send')?.addEventListener('click', () => sendTest());
      document.getElementById('admin-mail-to')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sendTest(); }
      });

      loadStatus();
      loadActivity();
    },

    destroy() {
      // No timers to clear — nothing here polls. Bumping the generation
      // is the teardown: any in-flight status/activity/test response
      // resolves into a no-op instead of writing into the next section's
      // host element.
      generation += 1;
      sending = false;
      highlightId = null;
      kindFilter = null;
      host = null;
    },
  };
})();

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') window.AdminMail = AdminMail;
