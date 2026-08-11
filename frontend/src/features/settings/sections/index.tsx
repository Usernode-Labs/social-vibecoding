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

import { Button } from '@/components/ui/button';

export function SettingsSections() {
  return (
    <>
      <div data-settings-section="api-key" className="hidden">
        <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
          Anthropic API key
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
          Bring your own Anthropic API key to keep working past the daily limit. Your platform daily allowance is used first; once it runs out, your key takes over automatically &mdash; even in the middle of a running turn &mdash; and usage bills directly to your Anthropic account.
        </p>
        <label
          className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1"
          htmlFor="settings-api-key"
        >
          Anthropic API key
        </label>
        <div
          id="settings-key-display"
          className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-300 mb-2"
        >
          sk-ant-…
          <span id="settings-key-last4">
          </span>
        </div>
        {/*
            #119 — daily spend breakdown for BYOK users. Filled by
            Settings._refreshSpend() on modal open; hidden while loading,
            on fetch failure, or when no key is saved. Rows are ordered
            limit-first to match the billing order (#212).
        */}
        <div
          id="settings-spend"
          className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-2"
        >
          <div className="font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Today's spend
          </div>
          <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
            <span>
              Platform daily limit
            </span>
            <span id="settings-spend-platform" className="font-mono">
            </span>
          </div>
          <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
            <span>
              Your key
            </span>
            <span id="settings-spend-byok" className="font-mono">
            </span>
          </div>
          <div className="text-zinc-500 dark:text-zinc-500 mt-1">
            Resets at midnight UTC.
          </div>
        </div>
        <div className="flex gap-2">
          <input
            id="settings-api-key"
            type="password"
            placeholder="sk-ant-..."
            autoComplete="off"
            spellCheck="false"
            className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 font-mono"
          />
          {/*
              THE ONE LIVE shadcn CONVERSION IN STEP 1.

              <Button>'s default variant + default size emit
              `rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2
              text-sm font-medium text-white transition-colors`, so with
              `shrink-0` passed through className this renders the exact
              DOM node the hand-written button did — same tag, same id,
              same class set. settings.js still finds it by
              getElementById and binds its click.

              It is here so that "shadcn is wired up and produces
              byte-identical output against the platform's own palette"
              is something the screenshot-parity gate actually TESTS,
              rather than something this migration merely claims.
              Every other control in this file is still raw JSX; they
              convert one screen at a time in step 2.
          */}
          <Button id="settings-save" className="shrink-0">
            Save
          </Button>
          <button
            id="settings-remove"
            className="hidden shrink-0 rounded-lg border border-red-400 dark:border-red-700 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
          >
            Remove
          </button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
          Encrypted at rest, verified against Anthropic before saving, never shown in full after save.
      The server decrypts it in memory to call Anthropic on your behalf &mdash; don't paste keys into services you don't trust with that level of access.
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener"
            className="text-violet-500 hover:text-violet-400 underline"
          >
            Set tight spend limits
          </a>
          on the key itself for defense in depth.
        </p>
        <div id="settings-status" className="text-sm mt-3 hidden">
        </div>
      </div>
      {/*
          Hosted MCP connector: connect Claude.ai / ChatGPT so their
          built-in coding agent (Claude Code on the web, Codex) can do
          the work on the user's own subscription. Also holds the
          verified GitHub account link, because that link exists only
          to serve this flow: it is IDENTITY ONLY (no OAuth scope, no
          stored token) and its whole job is attributing a submitted
          pull request to the account that verified it. The fork the
          agent pushes to is made by that agent, not by the platform.
          Rendered by Settings._renderConnectors() /
          _renderGithubLink() from GET /api/me/connectors and
          GET /api/me/github (?demo=1 passthrough in staging — mcp_tokens
          is staging:private and the link needs a real OAuth round-trip,
          so a staging clone has neither).
      */}
      <div data-settings-section="connectors" className="hidden">
        <div id="connectors-section">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Claude &amp; ChatGPT connectors
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Connect Usernode to Claude.ai or ChatGPT and you can browse apps, file requests and turn finished work into proposals from the chat you already have open &mdash; with the coding done by Claude Code or Codex on your own plan, not your Usernode daily allowance.
          </p>
          <label
            className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1"
            htmlFor="connector-url"
          >
            Connector URL
          </label>
          <div className="flex gap-2 mb-2">
            <input
              id="connector-url"
              type="text"
              readOnly={true}
              spellCheck="false"
              className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
            <button
              id="connector-url-copy"
              type="button"
              className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
            >
              Copy
            </button>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-4 leading-relaxed">
            In Claude.ai: Settings &rarr; Connectors &rarr; Add custom connector. In ChatGPT: Settings &rarr; Connectors. Paste the URL above, then approve the connection in the browser page that opens. You can disconnect here at any time.
          </p>
          <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
            Connected
          </h4>
          <div id="connectors-list" className="space-y-2">
          </div>
          <div id="connectors-status" className="text-xs mt-2 hidden">
          </div>
        </div>
        <div id="github-link-section" className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            GitHub account
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Linking GitHub proves which GitHub account is yours, so work built by your own coding agent can be submitted under your name. Usernode asks for
            <strong className="font-semibold text-zinc-600 dark:text-zinc-400">
              no access to your repositories
            </strong>
            &mdash; read-only public profile information only &mdash; and stores no GitHub token. Your coding agent (Claude Code or Codex) makes your fork of an app using its own GitHub connection.
          </p>
          <div id="github-link-body" className="space-y-2">
          </div>
          <div id="github-link-status" className="text-xs mt-2 hidden">
          </div>
        </div>
      </div>
      <div data-settings-section="openrouter" className="hidden">
        <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
          OpenRouter &amp; Codex
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
          Use Codex (via OpenRouter) as your coding agent, billed to your own OpenRouter API key. Your platform Claude allowance is not consumed for Codex turns (though the surrounding Mayor/wrap-up still use Claude credits). Your key is stored encrypted by the platform, is injected into the per-turn worker environment where the code running in your worker can see it, and is fully deleted when you remove it below &mdash; it is never persisted in the worker's warm environment or filesystem.
        </p>
        <div id="settings-openrouter-beta-gated" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400 mb-3">
          Codex/OpenRouter is being rolled out gradually and isn't available for your account yet.
        </div>
        <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1" htmlFor="settings-openrouter-key">
          OpenRouter API key
        </label>
        <div id="settings-openrouter-key-display" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-300 mb-2">
          sk-or-&hellip;<span id="settings-openrouter-key-last4"></span>
        </div>
        <div id="settings-openrouter-key-info" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-2 text-zinc-600 dark:text-zinc-400"></div>
        <div className="flex gap-2">
          <input id="settings-openrouter-key" type="password" placeholder="sk-or-..." autoComplete="off" spellCheck={false} className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 font-mono" />
          <button id="settings-openrouter-save" className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors">
            Test &amp; save
          </button>
          <button id="settings-openrouter-remove" className="hidden shrink-0 rounded-lg border border-red-400 dark:border-red-700 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">
            Remove
          </button>
        </div>
        <div id="settings-openrouter-models-wrap" className="hidden mt-4">
          <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1" htmlFor="settings-openrouter-model">
            Codex model
          </label>
          <select id="settings-openrouter-model" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"></select>
          <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mt-2 mb-1" htmlFor="settings-openrouter-reasoning">
            Reasoning effort
          </label>
          <select id="settings-openrouter-reasoning" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500">
            <option value="">Default</option>
            <option value="minimal">Minimal</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra high</option>
          </select>
          <button id="settings-openrouter-set-default" className="mt-3 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium transition-colors">
            Save as my default coding agent
          </button>
          <button id="settings-claude-set-default" className="mt-2 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
            Use Claude Code as my default instead
          </button>
        </div>
        <div id="settings-openrouter-status" className="text-sm mt-3 hidden"></div>
      </div>
      <div data-settings-section="app-ai" className="hidden">
        {/*
            App AI permissions (issue #34). Lists every app the user has
            granted access to their daily AI budget: today's spend vs the
            per-app cap, a cap editor, the BYOK spillover toggle, and
            Revoke. Rendered by Settings._renderLlmGrants() on modal open
            from GET /api/me/llm-grants (?demo=1 passthrough in staging).
        */}
        <div id="llm-grants-section">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            App AI permissions
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Apps you've allowed to use AI on your behalf. Their spend counts against your normal daily budget, plus the per-app cap you set. Revoking takes effect immediately.
          </p>
          <div id="llm-grants-list" className="space-y-2">
          </div>
          <div id="llm-grants-status" className="text-sm mt-2 hidden">
          </div>
        </div>
      </div>
      <div data-settings-section="agent-files" className="hidden">
        {/*
            Agent instructions & skills (issue #460). Per-user global files
            the coding agent loads on every build/scout run this user
            dispatches, in any app: instruction files are assembled into the
            worker's ~/.claude/CLAUDE.md, skills land in ~/.claude/skills/.
            Rendered by Settings._renderAgentFilesSection() on modal open
            from GET /api/me/agent-files (?demo=1 passthrough in staging,
            since user_agent_files is staging:private).
        */}
        <div id="agent-files-section">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Agent instructions &amp; skills
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Personal files the coding agent follows on every build or spec run you start, in any app. Markdown or plain text only, up to 10 of each kind, 48&nbsp;KB per file. Changes apply from your next run.
          </p>
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                Instructions
              </h4>
              <button
                data-agent-files-upload="instruction"
                className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Upload
              </button>
            </div>
            <div id="agent-files-instructions-list" className="space-y-1.5">
            </div>
          </div>
          <div className="mb-2">
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                Skills
              </h4>
              <button
                data-agent-files-upload="skill"
                className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Upload
              </button>
            </div>
            <div id="agent-files-skills-list" className="space-y-1.5">
            </div>
          </div>
          <input
            id="agent-files-input"
            type="file"
            accept=".md,.txt,text/markdown,text/plain"
            className="hidden"
          />
          {/*
              Pending-upload form: revealed after a file is picked so the
              user can adjust the (slugified) name and, for skills, the
              one-line description before saving.
          */}
          <div
            id="agent-files-form"
            className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 mt-2 text-xs"
          >
            <div id="agent-files-form-title" className="font-medium text-zinc-700 dark:text-zinc-300 mb-2">
            </div>
            <label className="block text-zinc-600 dark:text-zinc-400 mb-2">
              Name
              <input
                id="agent-files-name"
                type="text"
                maxLength={64}
                className="mt-1 w-full rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 font-mono text-zinc-900 dark:text-zinc-100"
              />
            </label>
            <label
              id="agent-files-desc-wrap"
              className="block text-zinc-600 dark:text-zinc-400 mb-2 hidden"
            >
              Description
              <input
                id="agent-files-desc"
                type="text"
                maxLength={200}
                placeholder="One line: what this skill does"
                className="mt-1 w-full rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-zinc-900 dark:text-zinc-100"
              />
            </label>
            <div className="flex gap-2">
              <button
                id="agent-files-save"
                className="rounded bg-violet-600 hover:bg-violet-500 px-3 py-1 font-medium text-white transition-colors"
              >
                Save
              </button>
              <button
                id="agent-files-cancel"
                className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
          <div id="agent-files-status" className="text-sm mt-2 hidden">
          </div>
        </div>
      </div>
      <div data-settings-section="password" className="hidden">
        {/*
            Change password (issue #282). Default form calls POST
            /api/me/password (current password required). In the Usernode
            native app with a linked wallet, a "Use your wallet instead"
            link switches to wallet mode (cp-wallet-mode shown, current
            password hidden) which signs a wallet-check challenge and calls
            POST /api/me/wallet-change-password — the way back for a
            logged-in user who's forgotten the password they'd need to type.
            settings.js wires the mode switch and both submit paths.
        */}
        <div id="change-password-section">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Change password
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Set a new password for web login. If an admin gave you a temporary password, enter it as your current password here.
          </p>
          <div className="space-y-2">
            <div id="cp-current-row">
              <input
                id="cp-current"
                type="password"
                autoComplete="current-password"
                placeholder="Current password"
                className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
            </div>
            <input
              id="cp-new"
              type="password"
              autoComplete="new-password"
              placeholder="New password (at least 8 characters)"
              className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
            <input
              id="cp-confirm"
              type="password"
              autoComplete="new-password"
              placeholder="Confirm new password"
              className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>
          {/* Default (password) submit */}
          <button
            id="cp-save"
            className="mt-2 w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            Change password
          </button>
          {/* Wallet (signature) submit — shown only in wallet mode */}
          <button
            id="cp-wallet-save"
            className="hidden mt-2 w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            Sign &amp; change password
          </button>
          {/*
              Mode switches. cp-wallet-mode is itself hidden unless the user
              is in the native app with a linked wallet (settings.js).
          */}
          <p id="cp-wallet-mode" className="hidden text-xs text-center mt-2">
            <a id="cp-use-wallet" href="#" className="text-violet-500 hover:text-violet-400">
              Forgot it? Use your wallet instead
            </a>
          </p>
          <p id="cp-password-mode" className="hidden text-xs text-center mt-2">
            <a id="cp-use-password" href="#" className="text-violet-500 hover:text-violet-400">
              Use current password instead
            </a>
          </p>
          <div id="cp-status" className="text-sm mt-2 hidden">
          </div>
        </div>
      </div>
      <div data-settings-section="wallet" className="hidden">
        {/* Wallet linking section */}
        <div id="wallet-section" className="hidden">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Usernode Wallet
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
            Link your on-chain identity. Scan the QR code with the Usernode mobile app.
          </p>
          {/* Unlinked: show link button */}
          <div id="wallet-unlinked" className="hidden">
            <button
              id="wallet-link-btn"
              className="w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
            >
              Link Usernode Wallet
            </button>
          </div>
          {/* Linking: show QR */}
          <div id="wallet-linking" className="hidden text-center">
            <div id="wallet-qr-canvas" className="inline-block rounded-lg bg-white p-2">
            </div>
            <p id="wallet-link-timer" className="text-xs text-zinc-500 mt-2">
            </p>
            <button
              id="wallet-link-cancel"
              className="mt-2 text-xs text-zinc-500 hover:text-zinc-300 underline"
            >
              Cancel
            </button>
          </div>
          {/* Linked: show pubkey + unlink */}
          <div id="wallet-linked" className="hidden">
            <div className="flex items-center gap-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2">
              <span className="text-xs text-emerald-500 font-bold">
                &#x2713;
              </span>
              <span
                id="wallet-pubkey-display"
                className="text-sm font-mono text-zinc-700 dark:text-zinc-300 truncate flex-1"
              >
              </span>
            </div>
            {/*
                Unlink intentionally hidden for now: unlinking only clears the
                server-side pubkey (no on-chain unlink), and wallet is the
                primary native sign-in path, so an accidental unlink is more
                footgun than feature. The DELETE /api/me/wallet-link endpoint
                and its (null-guarded) handler remain, so re-adding this button
                is all that's needed to restore the option.
            */}
          </div>
          <div id="wallet-status" className="text-sm mt-2 hidden">
          </div>
        </div>
      </div>
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
