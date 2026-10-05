// BuildLog — the "View build log" panel for failed app deploys (#416).
//
// Shared by the home-card "…" menu and the app-tab error screen so the
// two entry points render the identical panel. Always fetches fresh
// detail from GET /api/apps/:slug on open: the `lastFailure` field only
// rides that payload for the app's creator / collaborators / admins
// (the server strips it for everyone else), so authorization lives
// server-side — this panel just renders what it's given, or an honest
// "no detail recorded" fallback.
//
// `lastFailure` shape: { stage, reason, log, at, sha } — see
// src/services/deploy-failure.js.
const BuildLog = {
  _el: null,
  _keyHandler: null,

  // Human labels for the pipeline step that failed.
  stageLabel(stage) {
    switch (stage) {
      case 'clone': return globalThis.PlatformI18n.t("core:cloning_the_repository_10658ff8");
      case 'build': return globalThis.PlatformI18n.t("core:building_the_docker_image_560eebbf");
      case 'start': return globalThis.PlatformI18n.t("core:starting_the_container_620c3de1");
      case 'healthcheck': return globalThis.PlatformI18n.t("core:waiting_for_the_health_check_3cb362ec");
      case 'timeout': return globalThis.PlatformI18n.t("core:timed_out_9718cc76");
      default: return globalThis.PlatformI18n.t("core:deploying_4338bdb0");
    }
  },

  async open(slug) {
    BuildLog.close();
    let app = null;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}`);
      if (res.ok) app = (await res.json()).app || null;
    } catch {
      // Render the panel anyway — the empty state explains itself.
    }
    BuildLog._render(slug, app);
  },

  _render(slug, app) {
    const failure = app && app.lastFailure && typeof app.lastFailure === 'object'
      ? app.lastFailure : null;
    const canRetry = !!(app && app.status === 'error'
      && (window.App?.user?.canAdminWrite || window.App?.user?.id === app.created_by));

    let bodyHtml;
    if (!failure) {
      bodyHtml = `
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          ${globalThis.PlatformI18n.htmlText("core:no_build_failure_detail_is_recorded_for_this_app_d3afd898")}
        </p>`;
    } else {
      const when = failure.at ? new Date(failure.at) : null;
      const whenAbs = when && !Number.isNaN(when.getTime()) ? when.toLocaleString(globalThis.PlatformI18n.getLanguage()) : null;
      const whenRel = whenAbs ? blRelTime(failure.at) : null;
      const metaBits = [];
      metaBits.push(`<span class="font-medium text-zinc-700 dark:text-zinc-200">${globalThis.PlatformI18n.htmlText("core:failed_step_0ed199f7")}</span> ${blEscape(BuildLog.stageLabel(failure.stage))}`);
      if (whenAbs) {
        metaBits.push(`<span class="font-medium text-zinc-700 dark:text-zinc-200">${globalThis.PlatformI18n.htmlText("core:when_4bff21fc")}</span> ${blEscape(whenRel ? `${whenRel} (${whenAbs})` : whenAbs)}`);
      }
      if (failure.sha) {
        metaBits.push(`<span class="font-medium text-zinc-700 dark:text-zinc-200">${globalThis.PlatformI18n.htmlText("core:commit_84da95ea")}</span> <span class="font-mono">${blEscape(String(failure.sha).slice(0, 7))}</span>`);
      }
      const logText = String(failure.log || '').trim();
      bodyHtml = `
        <div class="text-xs text-zinc-500 dark:text-zinc-400 space-y-1">
          ${metaBits.map((m) => `<div>${m}</div>`).join('')}
        </div>
        <p class="mt-2 text-sm font-mono text-red-700 break-words dark:text-red-400">${blEscape(String(failure.reason || '').slice(0, 280))}</p>
        ${logText
          ? `<pre id="build-log-pre" class="mt-3 max-h-72 overflow-auto rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 p-3 text-[0.7rem] leading-relaxed font-mono whitespace-pre-wrap break-words select-text text-zinc-700 dark:text-zinc-300">${blEscape(logText)}</pre>`
          : `<p class="mt-3 text-xs text-zinc-500 dark:text-zinc-400">${globalThis.PlatformI18n.htmlText("core:no_log_output_was_captured_for_this_failure_f3d70ce9")}</p>`}
      `;
    }

    const overlay = document.createElement('div');
    overlay.id = 'build-log-overlay';
    overlay.className = 'fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4';
    overlay.innerHTML = `
      <div class="w-full max-w-2xl rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl flex flex-col max-h-[85vh]">
        <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold text-zinc-800 dark:text-zinc-100 truncate">${globalThis.PlatformI18n.htmlText("core:build_log_91d9414a")}</h2>
            <p class="text-xs text-zinc-500 dark:text-zinc-400 font-mono truncate">${blEscape(slug)}</p>
          </div>
          <button id="build-log-close" class="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-zinc-500/10" aria-label="${globalThis.PlatformI18n.htmlText("core:close_7d9eb7ac")}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="px-4 py-3 overflow-y-auto">${bodyHtml}</div>
        <div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">
          ${failure && String(failure.log || '').trim()
            ? `<button id="build-log-copy" class="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-500/10">${globalThis.PlatformI18n.htmlText("core:copy_log_99d7297a")}</button>`
            : ''}
          ${canRetry
            ? `<button id="build-log-retry" class="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white">${globalThis.PlatformI18n.htmlText("core:retry_deploy_19f848b7")}</button>`
            : ''}
        </div>
      </div>`;

    const panel = overlay.firstElementChild;
    if (PlatformUI.hasKit()) {
      // Kit path: the card presents with the kit's modal motion —
      // fade + scale-settle, backdrop tap / Escape dismiss. The
      // hand-rolled overlay wrapper is never mounted. The kit shell
      // draws the card chrome, so the panel's own is neutralized
      // (platform-modal-card) and the shell hugs the panel's width.
      panel.classList.add('platform-modal-card');
      BuildLog._modal = PlatformUI.modal({
        contentEl: panel,
        onDismiss: () => {
          if (BuildLog._modal) {
            BuildLog._modal = null;
            BuildLog.close();
          }
        },
      });
      if (BuildLog._modal && BuildLog._modal.el) {
        BuildLog._modal.el.style.width = 'min(672px, calc(100vw - 32px))';
      }
    } else {
      overlay.addEventListener('pointerdown', (e) => {
        if (e.target === overlay) BuildLog.close();
      });
      document.body.appendChild(overlay);
      BuildLog._el = overlay;
      BuildLog._keyHandler = (e) => { if (e.key === 'Escape') BuildLog.close(); };
      document.addEventListener('keydown', BuildLog._keyHandler);
    }

    panel.querySelector('#build-log-close')?.addEventListener('click', () => BuildLog.close());

    const copyBtn = panel.querySelector('#build-log-copy');
    if (copyBtn && failure) {
      copyBtn.addEventListener('click', async () => {
        const text = [
          `Build failure for ${slug}`,
          `Stage: ${BuildLog.stageLabel(failure.stage)}`,
          failure.at ? `At: ${failure.at}` : null,
          failure.sha ? `Commit: ${failure.sha}` : null,
          `Reason: ${failure.reason || ''}`,
          '',
          String(failure.log || ''),
        ].filter((l) => l !== null).join('\n');
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = globalThis.PlatformI18n.t("core:copied_ea61bc15");
        } catch {
          copyBtn.textContent = globalThis.PlatformI18n.t("core:copy_failed_5b50e7a6");
        }
        setTimeout(() => { copyBtn.textContent = globalThis.PlatformI18n.t("core:copy_log_99d7297a"); }, 1500);
      });
    }

    const retryBtn = panel.querySelector('#build-log-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true;
        retryBtn.textContent = globalThis.PlatformI18n.t("core:retrying_a16c8b1c");
        try {
          const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/retry`, { method: 'POST' });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            PlatformUI.toast(data.error || globalThis.PlatformI18n.t("core:retry_failed_http_value1_877e8360", { value1: res.status }));
            retryBtn.disabled = false;
            retryBtn.textContent = globalThis.PlatformI18n.t("core:retry_deploy_19f848b7");
            return;
          }
        } catch {
          retryBtn.disabled = false;
          retryBtn.textContent = globalThis.PlatformI18n.t("core:retry_deploy_19f848b7");
          return;
        }
        BuildLog.close();
        // The retry flips the card back to 'creating'; the WS
        // app_status broadcast drives the rest of the UI update.
        if (typeof Home !== 'undefined' && App._isScreenVisible('home-screen')) {
          Home.load();
        }
      });
    }
  },

  close() {
    if (BuildLog._modal) {
      const m = BuildLog._modal;
      BuildLog._modal = null;
      m.dismiss();
    }
    if (BuildLog._keyHandler) {
      document.removeEventListener('keydown', BuildLog._keyHandler);
      BuildLog._keyHandler = null;
    }
    if (BuildLog._el) {
      BuildLog._el.remove();
      BuildLog._el = null;
    }
  },
};

// Quote-safe escaper local to this file (matches the per-file helper
// convention used across public/js).
function blEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Compact relative-time formatter (same buckets as home.js's
// formatRelativeTime; kept local so load order doesn't matter).
function blRelTime(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const seconds = Math.floor((Date.now() - t.getTime()) / 1000);
  if (seconds < 60) return globalThis.PlatformI18n.t("core:just_now_7ddb44d8");
  if (seconds < 3600) return globalThis.PlatformI18n.t("core:value1_m_ago_28f5747c", { value1: Math.floor(seconds / 60) });
  if (seconds < 86400) return globalThis.PlatformI18n.t("core:value1_h_ago_51452941", { value1: Math.floor(seconds / 3600) });
  if (seconds < 86400 * 30) return globalThis.PlatformI18n.t("core:value1_d_ago_0dc906ea", { value1: Math.floor(seconds / 86400) });
  return globalThis.PlatformI18n.t("core:value1_mo_ago_9a0a3ce4", { value1: Math.floor(seconds / (86400 * 30)) });
}

window.BuildLog = BuildLog;
