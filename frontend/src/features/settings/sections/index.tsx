/**
 * The sixteen [data-settings-section] panes of the #settings screen, in the
 * order the shell has always emitted them (#1081 chunk D).
 *
 * This file is the MARKUP half of the settings screen. Behaviour stays in
 * ./settings.js — the module binds every control below by id, ONCE, and the
 * chassis in ../index.tsx only ever toggles `hidden` on the wrappers. That
 * split is load-bearing:
 *
 *  - a pane must never be innerHTML-rebuilt, or the id-bound listeners on the
 *    controls inside it silently stop firing. React re-rendering one of these
 *    subtrees would be the same failure, so every component here is STATIC:
 *    no state, no props, no effects. They render once, at hydration, and are
 *    never reconciled again.
 *  - each wrapper ships `hidden`, exactly as the hand-written shell did, and
 *    the router unhides exactly one. That is the SECTION-ROUTING hidden.
 *  - #wallet-section, #settings-usernode-section and #settings-admin-section
 *    carry a SECOND, inner `hidden`. That one is a CAPABILITY GATE, owned by
 *    settings.js and read back by Settings._visibleSections() to decide menu
 *    membership. The two concepts are deliberately separate — collapsing them
 *    would make an ungated section unreachable the moment its wrapper hid.
 */

import { AgentFilesSection } from './agent-files';
import { ApiKeySection } from './api-key';
import { AppAiSection } from './app-ai';
import { ConnectorsSection } from './connectors';
import { OpenRouterSection } from './openrouter';
import { PasswordSection } from './password';
import { WalletSection } from './wallet';

export function SettingsSections() {
  return (
    <>
      <ApiKeySection />
      <ConnectorsSection />
      <OpenRouterSection />
      <AppAiSection />
      <AgentFilesSection />
      <PasswordSection />
      <WalletSection />
      <div data-settings-section="language" className="hidden">
        {/*
            Platform-level user language preference (issue #757). A single
            per-user BCP-47 locale apps read as their default language —
            via the iframe JWT `locale` claim and the bridge's
            usernode.getUserLocale(). "" (Auto) = unset (NULL in the DB).
            Saves on change; settings.js wires the handler to
            POST /api/me/locale and pushes a live `usernode:locale-changed`
            notification into any open app iframe.
        */}
        <div id="settings-language-section">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Language
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Apps on Usernode use this as their default language. Apps may offer their own override.
          </p>
          <select
            id="settings-locale"
            className="w-full rounded-lg bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200"
          >
            <option value="">
              Auto — use device language
            </option>
            <option value="en">
              English
            </option>
            <option value="es">
              Español
            </option>
            <option value="fr">
              Français
            </option>
            <option value="de">
              Deutsch
            </option>
            <option value="id">
              Bahasa Indonesia
            </option>
            <option value="pt-BR">
              Português (Brasil)
            </option>
            <option value="it">
              Italiano
            </option>
            <option value="nl">
              Nederlands
            </option>
            <option value="pl">
              Polski
            </option>
            <option value="tr">
              Türkçe
            </option>
            <option value="ru">
              Русский
            </option>
            <option value="uk">
              Українська
            </option>
            <option value="ar">
              العربية
            </option>
            <option value="hi">
              हिन्दी
            </option>
            <option value="vi">
              Tiếng Việt
            </option>
            <option value="th">
              ไทย
            </option>
            <option value="ja">
              日本語
            </option>
            <option value="ko">
              한국어
            </option>
            <option value="zh-CN">
              中文（简体）
            </option>
            <option value="zh-TW">
              中文（繁體）
            </option>
          </select>
          <div id="settings-locale-status" className="text-xs mt-2 hidden">
          </div>
        </div>
      </div>
      <div data-settings-section="alerts" className="hidden">
        {/*
            #138: Dev-chat sound & alerts (default ON). Client-only
            preference (localStorage key devchat_alerts_enabled); wired in
            settings.js. Plays a chime when an AI dev-chat turn finishes
            while you're in the app, or a system notification when it's in
            the background.
        */}
        <div id="settings-alerts-section">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Dev-chat sound &amp; alerts
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Get a heads-up when a dev-chat AI agent finishes and is waiting for your reply.
          </p>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input id="devchat-alerts-toggle" type="checkbox" className="un-switch" />
            <span className="text-sm text-zinc-800 dark:text-zinc-200">
              Play a sound, and notify me when the app is in the background
            </span>
          </label>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
            When you're in the app a soft chime plays; when the app is backgrounded or closed you get a system notification instead. Your browser or device may ask permission to show notifications the first time.
          </p>
          <button
            id="devchat-alerts-test"
            type="button"
            className="mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            Send a test alert
          </button>
          <p
            id="devchat-alerts-test-status"
            className="text-xs mt-2 hidden text-zinc-500 dark:text-zinc-400"
          >
          </p>

          <div
            id="settings-mobile-push-preferences"
            className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800"
          >
            <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
              Mobile push categories
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3 leading-relaxed">
              Choose which Social activity can send a phone notification. Your phone&apos;s Activity notifications switch remains the master control for that device.
            </p>
            <div className="space-y-3">
              <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="direct_interactions">
                <span>
                  <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Direct interactions</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Mentions and replies to your messages.</span>
                </span>
                <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
              </label>
              <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="invitations">
                <span>
                  <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Invitations</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Collaboration and approver invitations, including when yours are accepted.</span>
                </span>
                <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
              </label>
              <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="shared_work">
                <span>
                  <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Shared work</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Specs that someone privately shares with you.</span>
                </span>
                <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
              </label>
              <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="developer_sessions">
                <span>
                  <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Developer sessions</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Interactive and unattended coding sessions that finish while you are away.</span>
                </span>
                <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
              </label>
              <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="proposal_alerts">
                <span>
                  <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Proposal alerts</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Proposals needing attention, failed previews, and new proposals ready for voting.</span>
                </span>
                <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
              </label>
              <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="lightweight_activity">
                <span>
                  <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Lightweight activity</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Reactions and kudos on your work.</span>
                </span>
                <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
              </label>
            </div>
            <p data-mobile-push-status aria-live="polite" className="text-xs mt-3 text-zinc-500 dark:text-zinc-400">
              Loading mobile push preferences…
            </p>
          </div>
        </div>
      </div>
      <div data-settings-section="home-panels" className="hidden">
        {/*
            #911: which home-screen cards ("widgets" to the user,
            panels in the code) are shown. Every registry entry is
            on by default — users.home_panels_hidden lists only the
            ones this viewer dismissed from the card's own ⋮ menu
            ("Hide widget"), so an unticked box here is the way to
            get one back. Rows are rendered by settings.js
            _renderHomePanelsSection() from GET /api/home-panels's
            `registry` + `hidden`.
        */}
        <div id="settings-home-panels-section">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Home screen widgets
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Cards shown on your home screen below your apps. Untick one to hide it — the same as pressing the &times; on the card itself.
          </p>
          <div id="settings-home-panels-list" className="space-y-2">
          </div>
          <p id="settings-home-panels-status" className="text-xs mt-2 hidden">
          </p>
        </div>
      </div>
      <div data-settings-section="cli" className="hidden">
        {/*
            Global CLI/coding-agent credentials. The server returns only a short token
            hint and non-secret metadata; raw bearer values never enter the
            browser Settings surface.
        */}
        <div id="cli-tokens-section">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            CLI &amp; coding-agent access
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Credentials approved for the Social Vibecoding CLI, Codex, or Claude Code. Revoking an active credential takes effect immediately.
          </p>
          <div id="cli-tokens-list" className="space-y-2">
          </div>
          <button
            id="cli-tokens-more"
            type="button"
            className="hidden mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            Load more
          </button>
          <div id="cli-tokens-status" className="text-xs mt-2 hidden">
          </div>
        </div>
      </div>
      <div data-settings-section="dev-console" className="hidden">
        {/*
            Developer console visibility. The bug-icon in the header opens
            a slide-up log of forwarded console output and errors from
            the running app's iframe. By default the icon stays hidden
            until the app actually logs an error so the header doesn't
            get cluttered for users who never need it. This toggle pins
            it to always-visible whenever an iframe is on screen.
        */}
        <div id="settings-devconsole-section">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Developer console
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            The bug icon in the header opens a slide-up log of console output and errors forwarded from the running app.
          </p>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input id="dev-console-always-show" type="checkbox" className="un-switch" />
            <span className="text-sm text-zinc-800 dark:text-zinc-200">
              Always show the icon
            </span>
          </label>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
            When unchecked (the default), the icon only appears once the current app has logged at least one error.
          </p>
        </div>
      </div>
      <div data-settings-section="experimental" className="hidden">
        {/*
            Experimental: AI progress estimate (default OFF). When enabled,
            a small Haiku call skims the in-flight Claude Code progress log
            about once a minute and shows a vague "AI guess" plus a live
            countdown next to the timer on the running line in dev-chat.
            #892: the model is now given the MEASURED run-length
            distribution as prompt input (llm.js RUN_LENGTH_PRIORS) rather
            than the old "bias toward 2-10 minutes" instruction that
            flattened its output; nothing scales its answer afterwards.
            Server-gated per user; settings.js wires the change handler to
            POST /api/me/ai-progress-estimate.
        */}
        <div id="settings-experimental-section">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Experimental
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Early features we're still testing. They may change or disappear.
          </p>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input id="ai-progress-estimate" type="checkbox" className="un-switch" />
            <span className="text-sm text-zinc-800 dark:text-zinc-200">
              AI progress estimate
            </span>
          </label>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
            While the coding agent works, a small AI model skims its progress log about once a minute and guesses how far along it is and roughly how long is left. It's calibrated against how long real runs actually take, but it's still a guess and can be wrong. Adds a tiny per-run cost (billed to your own API key if you've saved one above).
          </p>
          <div id="ai-progress-estimate-status" className="text-xs mt-2 hidden">
          </div>
        </div>
        {/*
            #907 Local coding agent. Lives inside Experimental (not the
            CLI section) because it is a preview of the same feature the
            dev chat's "Run on" selector exposes, and because a lease is
            NOT a credential: revoking a CLI token is a security action,
            detaching a machine is a routing one. Painted by
            settings.js _renderLocalAgentsSection() from
            GET /api/me/local-agents; the whole block hides itself when
            no machine has ever attached, so it costs nothing for the
            overwhelming majority who never run the CLI.
        */}
        <div id="settings-local-agents-section" className="hidden mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Local coding agent
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Machines running <span className="font-mono">social-vibecoding agent run</span>. While one is attached, that session's spec and coding turns run there on your own Claude subscription instead of on Usernode. Each turn asks in your terminal before it starts; spec turns are read-only, and after a coding turn Usernode still opens the pull request, builds the preview and runs the checks. Detaching sends the next turn back to Usernode.
          </p>
          <div id="settings-local-agents-list" className="space-y-2">
          </div>
          <div id="settings-local-agents-status" className="text-xs mt-2 hidden">
          </div>
        </div>
      </div>
      <div data-settings-section="usernode" className="hidden">
        {/*
            "Usernode app" sections (profile-and-settings-to-web migration):
            the mobile app's native App Settings absorbed into this modal.
            Hidden unless the Usernode bridge reports the getSettingsState
            capability; fully rendered by settings.js
            _renderUsernodeSection() from the bridge's settings snapshot.
            Covers device permissions, node sleep, privacy & identity,
            diagnostics, about & legal (FAQ), and the app account.
        */}
        <div id="settings-usernode-section" className="hidden">
        </div>
      </div>
      <div data-settings-section="admin-preview" className="hidden">
        {/*
            Admin-only: "view as non-admin" preview. Visible only when the
            server reports the user as a real admin (settings.js gates the
            visibility based on App._realIsAdmin). Toggling reloads the
            page so all admin-gated UI (home retry/delete/lock buttons,
            app-secrets editor, etc.) re-renders against the masked
            App.user.isAdmin.
        */}
        <div id="settings-admin-section" className="hidden">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Admin preview
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Hide admin-only UI so the app looks the way it does for a regular user. Useful for spotting UX issues that only affect non-admins.
          </p>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input id="view-as-non-admin" type="checkbox" className="un-switch" />
            <span className="text-sm text-zinc-800 dark:text-zinc-200">
              View as non-admin
            </span>
          </label>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
            Purely a client-side display toggle &mdash; your server-side admin privileges are unaffected. The page will reload so the rest of the UI picks up the change.
          </p>
        </div>
      </div>
    </>
  );
}
