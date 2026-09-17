import * as React from 'react';

import { Button } from '@/components/ui/button';
import { ChevronRightIcon } from '@/components/ui/icons';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { ConnectorsList } from '../connectors-list';
import { SocialIdentity } from '../social-identity';

/**
 * Hosted MCP connector: connect Claude.ai / ChatGPT so their built-in coding
 * agent (Claude Code on the web, Codex) can do the work on the user's own
 * subscription. Also holds GitHub/X ownership proofs for the Layer-1 daily
 * credit tier. These are IDENTITY ONLY: immutable provider id + display handle
 * and verification timestamps, with no provider token retained.
 *
 * Rendered by Settings._renderConnectors() / _renderGithubLink() from
 * GET /api/me/connectors and GET /api/me/social-identities (deterministic
 * staging fixtures make every credit state reviewable without OAuth).
 */
/**
 * The read-only rules, rendered into BOTH copy blocks below: the personal
 * `~/.claude/settings.json` and the per-repo `.claude/settings.json`. One
 * constant, because the two files take identical content and differ only in
 * reach — a repo file covers one repo and travels into a fresh web container;
 * a personal file covers every repo and does not.
 *
 * Four spellings of the name, not one. A permission rule names its server
 * literally, and the name is typed by a human into another product's dialog,
 * so the capitalised form is the one near-miss worth guessing — that is the
 * `homeroom` / `Homeroom` pair. The `usernode` pair is not a guess: it is
 * what the connector was called before the rename, so it is what an account
 * that connected earlier is still registered as. Both ship until the old
 * name is gone from people's connector lists. Any spelling beyond these is
 * what #connector-name-spelling below rewrites these blocks for.
 *
 * Written out as a literal rather than built from
 * services/mcp-connect-constants.js: that module is CommonJS on the server
 * side of the repo, and pulling it into the browser bundle to render six
 * short strings would drag the connector's server constants into the shell.
 * tests/connector-permission-rules.test.js asserts this string is exactly
 * `JSON.stringify({ permissions: { allow: READ_ONLY_ALLOW_RULES } }, null, 2)`,
 * so the two cannot drift — a rule added to the constant fails the test here
 * until this block matches.
 */
const PERSONAL_ALLOW_RULES = `{
  "permissions": {
    "allow": [
      "mcp__homeroom__get_*",
      "mcp__homeroom__list_*",
      "mcp__homeroom__whoami",
      "mcp__homeroom__notify_awaiting_input",
      "mcp__homeroom__notify_input_received",
      "mcp__Homeroom__get_*",
      "mcp__Homeroom__list_*",
      "mcp__Homeroom__whoami",
      "mcp__Homeroom__notify_awaiting_input",
      "mcp__Homeroom__notify_input_received",
      "mcp__usernode__get_*",
      "mcp__usernode__list_*",
      "mcp__usernode__whoami",
      "mcp__usernode__notify_awaiting_input",
      "mcp__usernode__notify_input_received",
      "mcp__Usernode__get_*",
      "mcp__Usernode__list_*",
      "mcp__Usernode__whoami",
      "mcp__Usernode__notify_awaiting_input",
      "mcp__Usernode__notify_input_received"
    ]
  }
}`;

/**
 * #1892: the Codex CLI walkthrough ships two copyable blocks, the one-line
 * `codex mcp add` form and the `~/.codex/config.toml` form it writes. Both
 * are verified against the Codex CLI source (`codex-rs/cli/src/mcp_cmd.rs`
 * on main, 2026-09-14): `codex mcp add <NAME> --url <URL>` is the streamable
 * HTTP form, and `[mcp_servers.<name>]` with a `url` key is the file it
 * produces.
 *
 * The URL is a PLACEHOLDER here, never a host. The written steps point back
 * at #connector-url so a fork or a config change cannot stale them, and these
 * blocks follow the same rule one step further: Settings._renderConnectors()
 * swaps CODEX_URL_PLACEHOLDER for the live `${origin}/mcp` value at render
 * time (textContent, never innerHTML). The placeholder is what the
 * prerendered document shows before script runs, which is why it reads as
 * an obvious fill-in rather than a plausible-looking address someone might
 * paste as-is. tests/connector-setup-codex.test.js pins the two copies of
 * the placeholder to each other.
 */
const CODEX_URL_PLACEHOLDER = 'https://<your-homeroom-host>/mcp';
const CODEX_ADD_COMMAND = `codex mcp add homeroom --url ${CODEX_URL_PLACEHOLDER}`;
const CODEX_CONFIG_TOML = `[mcp_servers.homeroom]
url = "${CODEX_URL_PLACEHOLDER}"`;

/**
 * One numbered row of the setup walkthroughs below (#1289). A presentational
 * helper, not an island: the whole walkthrough is static prose, so it renders
 * once and nothing ever writes into it. The <ol>/<li> structure is real —
 * screen readers announce "list, N items" — with the number drawn as a badge
 * because the two products' own docs count steps the same way.
 */
function SetupStep({ n, title, children }: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 text-[0.6875rem] font-semibold leading-none text-zinc-600 dark:text-zinc-300">
        {n}
      </span>
      <span className="min-w-0 text-[0.9375rem] leading-snug text-zinc-500 dark:text-zinc-400">
        {/* The separating space lives INSIDE the <strong> — a bare {' '}
            between it and {children} would be a second adjacent text child,
            which the prerender merges and hydration then mismatches on. */}
        <strong className="font-semibold text-zinc-600 dark:text-zinc-400">{`${title} `}</strong>
        {children}
      </span>
    </li>
  );
}

/**
 * One row of a grouped card that opens in place (#2370).
 *
 * The pane used to be flat: four walkthroughs of three to seven steps, a
 * hundred words on naming and three cases of permission rules, all open, all
 * at 12px — 6,330px on a phone before the social accounts at the bottom. Every
 * one of those is reference for a reader who has picked a route, so each is a
 * row now: the summary names the route and says what it costs ("7 steps ·
 * needs Developer mode"), which is what lets someone choose WITHOUT opening
 * any of them.
 *
 * A `<details>` rather than a stateful island, on purpose. settings.js still
 * writes into these bodies by id (the case filtering, both Copy handlers, the
 * allow-rules rewrite), and AGENTS.md's ownership rule says a subtree a legacy
 * module writes to may not become React state. The platform's own disclosure
 * element needs none.
 *
 * What dapp.json can still see: `expectSelector` is `page.$()` — presence in
 * the document — so every id in a CLOSED body still resolves; only
 * `expectText` reads rendered text (capture/capture.js, assertPresence). The
 * checks on this pane therefore name a body element by selector and a summary
 * by text.
 */
function Disclosure({ id, title, hint, children }: {
  id?: string;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <details
      id={id}
      className="group [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800"
    >
      <summary className="list-none cursor-pointer active:bg-zinc-50 dark:active:bg-zinc-800">
        <ListRow
          className="py-3"
          inset="none"
          chevron={false}
          title={title}
          titleClassName="font-medium"
          subtitle={hint}
          subtitleClassName="whitespace-normal"
          trailing={(
            <ChevronRightIcon
              aria-hidden="true"
              className="h-5 w-5 shrink-0 text-zinc-300 dark:text-zinc-600 transition-transform group-open:rotate-90"
            />
          )}
        />
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}

/** The grey label a grouped card sits under, in the sheet's 15px. */
const GROUP_LABEL = 'px-4 pb-2 text-[0.9375rem] font-normal text-zinc-500 dark:text-zinc-500';
/** The one line a grouped card may carry under it. */
const GROUP_NOTE = 'px-4 pt-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400';
/** Body copy inside an open disclosure. */
const BODY = 'text-[0.9375rem] leading-snug text-zinc-500 dark:text-zinc-400';

export function ConnectorsSection() {
  return (
    <div data-settings-section="connectors" className="hidden">
      <div id="github-link-section">
        <SectionHeading title="Social accounts">
          We pay for these credits, so a connected account helps us stop one person making many.
        </SectionHeading>
        <div id="github-link-body" className="space-y-2">
          <SocialIdentity />
        </div>
        {/*
            #2370: the lead used to carry all of this as a 76-word paragraph
            ahead of the rows. It is one short line under them now — after the
            thing you came for, before the decision to authorize.

            NOT a disclosure. dapp.json asserts "no access to your
            repositories" as rendered text, which is the product stating it
            must be readable without a tap, and a scope statement you have to
            go looking for is worth little. "not proof of unique humanity" is
            the honest limit of the check: resolving a provider account id
            establishes control of that account and nothing more.

            "Either one is enough" is NOT here any more. It is only true on the
            credit ladder, so it travels with the tier (settings.js,
            _socialIdentityTierView's `note`) and is absent where credits do
            not depend on a connected account at all.
        */}
        <p id="github-link-scope" className={GROUP_NOTE}>
          Homeroom asks for
          <strong className="font-semibold text-zinc-600 dark:text-zinc-400">{' no access to your repositories '}</strong>
          and stores no provider token. Connecting confirms you control the account. It is not proof of unique humanity.
        </p>
        <StatusLine id="github-link-status" size="xs" />
      </div>
      <div id="connectors-section" className="mt-10">
        <SectionHeading title="Connectors">
          Work on your apps from a Claude or ChatGPT chat, without using your daily credits.
        </SectionHeading>
        <Label className="mb-1" htmlFor="connector-url">
          Connector URL
        </Label>
        <div className="flex gap-2 mb-2">
          {/*
              `mono` as a PROP, not className: this field writes `font-mono`
              before the focus ring, where #settings-api-key writes it after.
              Input's variant table exists to reproduce both spellings.
          */}
          <Input
            id="connector-url"
            type="text"
            readOnly={true}
            spellCheck="false"
            width="flex"
            mono
          />
          {/*
              This one KEEPS the violet fill: it is the section's primary
              action, and the two blocks below stepping down to `outline` is
              what makes that legible again (#1290). The min-heights are a
              no-op on desktop, where the button already measures ~38px.
          */}
          <Button
            id="connector-url-copy"
            type="button"
            layout="shrink"
            className="min-h-[44px] sm:min-h-[36px]"
            aria-label="Copy the connector URL"
          >
            Copy
          </Button>
        </div>
        {/*
            #1607: the walkthroughs below are six and seven steps, and the
            complaint was that reading them is the cost. These two links hand
            the same job to the assistant that is going to use the connector:
            they open a NEW chat pre-loaded with the server URL and the two
            facts people get wrong (dynamic client registration, so there is
            no client secret to hunt for; and the exact name `usernode`, per
            #1218), and ask it to walk the reader through one step at a time.

            They do not REPLACE the steps below, and the request's hope that
            they would is worth answering plainly: an assistant in a chat
            cannot click through Claude's or ChatGPT's own settings UI. What
            it can do is answer "where is that button" without the reader
            re-reading a wall of prose, which is the back-and-forth the
            request is actually about. So this is a shortcut past the reading,
            not a replacement for the reference.

            The href is built at click time from the LIVE #connector-url value
            by Settings._renderConnectors(), never hardcoded, so a fork or a
            config change cannot stale it — the same rule the prose below
            follows. Nothing secret travels: the connector URL is
            `${origin}/mcp`, a public endpoint, and auth is OAuth inside the
            product rather than anything carried in a link.
        */}
        <div className="mb-6 flex flex-wrap gap-2">
          <a
            id="connector-open-claude"
            href="https://claude.ai/new"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center rounded-full bg-white dark:bg-zinc-900 px-4 text-[0.9375rem] font-medium text-zinc-900 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            Set it up in Claude
          </a>
          <a
            id="connector-open-chatgpt"
            href="https://chatgpt.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center rounded-full bg-white dark:bg-zinc-900 px-4 text-[0.9375rem] font-medium text-zinc-900 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            Set it up in ChatGPT
          </a>
        </div>
        <h4 className={GROUP_LABEL}>Set one up</h4>
        <GroupedList className="mx-0">
        {/*
            #1289: the one-line "Settings → Connectors, paste the URL" summary
            assumed both products still bury custom MCP servers one menu deep,
            and it skipped every step a first-time user actually stalls on —
            ChatGPT's Developer mode gate, Claude's per-conversation toggle,
            the Team/Enterprise Owner requirement. So each product gets its
            own numbered walkthrough, current as of the flows the issue
            documents. Wherever the products' generic docs say "your MCP
            server URL", these steps point back at the #connector-url field
            above — that field is the dynamic, per-deployment value, so the
            copy never hardcodes a URL that a fork or a config change would
            stale. Static prose, deliberately NOT filtered by which product
            is already connected (unlike #connector-prompt-help's cases):
            these are pre-connection instructions, so the reader by
            definition hasn't told us which product they're in yet.
        */}
        <Disclosure title="Claude.ai" hint="6 steps &middot; in the browser">
            <ol className="space-y-2">
              <SetupStep n={1} title="Open connector settings.">
                Go to <strong className="font-semibold text-zinc-600 dark:text-zinc-400">Customize &rarr; Connectors</strong> in Claude (<code className="font-mono text-zinc-600 dark:text-zinc-400">claude.ai/customize/connectors</code>). This is where both directory connectors and your own custom ones live.
              </SetupStep>
              <SetupStep n={2} title="Start a custom connector.">
                Click the <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> button, then choose &ldquo;Add custom connector&rdquo;. In the dialog, put <code className="font-mono text-zinc-600 dark:text-zinc-400">homeroom</code> in the Name field, exactly that spelling (the &ldquo;Name it homeroom&rdquo; row below says why). On Team or Enterprise plans this option isn&rsquo;t there for members, so an Owner adds it first from Organization settings &rarr; Connectors (Add &rarr; hover &ldquo;Custom&rdquo; &rarr; &ldquo;Web&rdquo;).
              </SetupStep>
              <SetupStep n={3} title="Paste your MCP server URL.">
                For Homeroom that is the connector URL in the field above, a public HTTPS endpoint ending in <code className="font-mono text-zinc-600 dark:text-zinc-400">/mcp</code>. A custom server must be reachable from Anthropic&rsquo;s cloud, not just from your machine.
              </SetupStep>
              <SetupStep n={4} title="Add OAuth credentials if needed.">
                If a server requires OAuth, open &ldquo;Advanced settings&rdquo; and enter your OAuth Client ID and Client Secret. Skip this for Homeroom: it uses dynamic client registration, so there is nothing to enter.
              </SetupStep>
              <SetupStep n={5} title="Save and authenticate.">
                Click &ldquo;Add&rdquo; to finish configuring, then click &ldquo;Connect&rdquo; next to the connector. You&rsquo;ll be redirected through the OAuth flow; review the scopes it asks for before approving.
              </SetupStep>
              <SetupStep n={6} title="Enable it in a conversation.">
                In a chat, use the <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> button at the lower left, then &ldquo;Connectors&rdquo;, and toggle your connector on. Toggles are per-conversation, so you control which chats can reach it.
              </SetupStep>
            </ol>
        </Disclosure>
        <Disclosure title="ChatGPT" hint="7 steps &middot; needs Developer mode">
            <ol className="space-y-2">
              <SetupStep n={1} title="Use ChatGPT on the web.">
                Open ChatGPT in your browser. Custom MCP setup is currently a web feature.
              </SetupStep>
              <SetupStep n={2} title="Turn on Developer mode.">
                In ChatGPT, go to <strong className="font-semibold text-zinc-600 dark:text-zinc-400">Profile &rarr; Settings &rarr; Security and login &rarr; Developer mode</strong> and turn Developer mode on.
              </SetupStep>
              <SetupStep n={3} title="Open the ChatGPT Plugins page.">
                After Developer mode is enabled, open <strong className="font-semibold text-zinc-600 dark:text-zinc-400">ChatGPT Plugins</strong>.
              </SetupStep>
              <SetupStep n={4} title="Click the + button.">
                The <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> button lets you add your own MCP-backed app.
              </SetupStep>
              <SetupStep n={5} title="Enter your MCP server details.">
                Enter the URL of the remote MCP server (for Homeroom, the connector URL in the field above) and configure authentication if required. The server must be reachable by ChatGPT; one running only on <code className="font-mono text-zinc-600 dark:text-zinc-400">localhost</code> will not work directly.
              </SetupStep>
              <SetupStep n={6} title="Create the app.">
                ChatGPT connects to the MCP server and discovers the tools it exposes. Once that succeeds, save/create the app.
              </SetupStep>
              <SetupStep n={7} title="Use the MCP server in a chat.">
                Start a <strong className="font-semibold text-zinc-600 dark:text-zinc-400">new ChatGPT conversation</strong> and open the <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> / tools menu next to the message box. Select Developer mode, then select the MCP app you just created. Now ask ChatGPT to perform something that uses one of the tools, for example: <em>&ldquo;Use my MCP server to list the open support tickets.&rdquo;</em> When appropriate, ChatGPT will call the tools your MCP server exposes and use their results in the conversation.
              </SetupStep>
            </ol>
            <p className={`${BODY} mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800`}>
              <strong className="font-semibold text-zinc-600 dark:text-zinc-400">In short:</strong> Settings &rarr; Security and login &rarr; Developer mode ON &rarr; ChatGPT Plugins &rarr; <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> &rarr; Enter MCP server URL &rarr; Create &rarr; New chat &rarr; <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> &rarr; Developer mode &rarr; select your MCP app &rarr; Ask ChatGPT to use it.
            </p>
        </Disclosure>
        {/*
            #1892: only the two chat products were covered, and the feedback
            was that Codex and "other agents" had nothing. Two more blocks,
            same SetupStep idiom, same rule of pointing at #connector-url
            rather than naming a host.

            The Codex block is for the Codex CLI, whose remote-server setup
            is a config file rather than a settings screen, so it carries
            the two copyable forms (command and TOML) with the same
            header-row Copy idiom the allow-rule blocks use (#1290).

            It also says, in its own step, what the hosted platform does NOT
            accept today: Codex takes the OAuth approval on a 127.0.0.1
            callback (codex-rs/rmcp-client/src/oauth_callback.rs), and
            services/mcp-oauth.js accepts a loopback redirect only in
            local-development mode, so on the hosted platform dynamic client
            registration answers `invalid_redirect_uri`. #1893 was filed
            because the Claude instructions did not work; a Codex block that
            walks the reader up to a refused login without saying so would
            be the same complaint again. Lifting that limit is an auth-policy
            change with its own review, not a documentation change, so the
            copy states the limit instead of pretending it away.

            The generic block is what any MCP client needs to know that the
            product walkthroughs leave implicit: the transport, how auth is
            discovered, the callback rule, and the tool-name prefix the
            permission-rule section below is written around. Every value it
            names (well-known path, scopes, redirect hosts, error code) is
            pinned to the server's own constants by
            tests/connector-setup-codex.test.js, so it cannot drift from what
            /mcp actually does.
        */}
        <Disclosure id="connector-setup-codex" title="Codex" hint="3 steps &middot; in the terminal">
            <ol className="space-y-2">
              <SetupStep n={1} title="Add the server.">
                From a terminal where Codex is installed, run the command below, or add the config entry below it to <code className="font-mono text-zinc-600 dark:text-zinc-400">~/.codex/config.toml</code> by hand, which is all the command does. Keep the name <code className="font-mono text-zinc-600 dark:text-zinc-400">homeroom</code>: Codex prefixes the tools with the server name you give it, and it is the name the rest of this page assumes.
              </SetupStep>
              <SetupStep n={2} title="Sign in.">
                Run <code className="font-mono text-zinc-600 dark:text-zinc-400">codex mcp login homeroom</code>. Codex opens your browser on Homeroom&rsquo;s consent page; approve it there and Codex keeps the token itself. There is no client ID or secret to enter. <code className="font-mono text-zinc-600 dark:text-zinc-400">codex mcp list</code> then shows the server, and the tools are there in your next Codex session.
              </SetupStep>
              <SetupStep n={3} title="Know the limit today.">
                Codex takes that approval on a <code className="font-mono text-zinc-600 dark:text-zinc-400">127.0.0.1</code> callback, and the hosted Homeroom connector accepts sign-in callbacks only on Claude&rsquo;s and ChatGPT&rsquo;s own hosts, so on the hosted platform the sign-in is refused with <code className="font-mono text-zinc-600 dark:text-zinc-400">invalid_redirect_uri</code>. It works against a Homeroom you run yourself in local-development mode. A Codex session without the connector can still build a Homeroom work order: it pushes the branch, and the ChatGPT chat that holds the connector submits it.
              </SetupStep>
            </ol>
            {/*
                Below the list, not inside step 1: a <pre> is block content and
                SetupStep's text wrapper is a <span>. Same header-row Copy idiom
                as the allow-rule blocks (#1290), with the destination named in
                the row because that is what tells the two blocks apart.
            */}
            <div className="mt-3 pt-2 border-t border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500 truncate">terminal</span>
                <Button
                  id="connector-codex-add-copy"
                  type="button"
                  layout="shrink"
                  variant="outline"
                  size="xsText"
                  ink="muted"
                  className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]"
                  aria-label="Copy the Codex command that adds the Homeroom server"
                >
                  Copy
                </Button>
              </div>
              <pre id="connector-codex-add" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2 mb-3">{CODEX_ADD_COMMAND}</pre>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500 truncate">~/.codex/config.toml</span>
                <Button
                  id="connector-codex-config-copy"
                  type="button"
                  layout="shrink"
                  variant="outline"
                  size="xsText"
                  ink="muted"
                  className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]"
                  aria-label="Copy the Codex config.toml entry for the Homeroom server"
                >
                  Copy
                </Button>
              </div>
              <pre id="connector-codex-config" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2">{CODEX_CONFIG_TOML}</pre>
            </div>
        </Disclosure>
        <Disclosure id="connector-setup-generic" title="Another agent" hint="4 steps &middot; any MCP client">
            <ol className="space-y-2">
              <SetupStep n={1} title="Give it the connector URL as a Streamable HTTP server.">
                That is the URL in the field above: a public HTTPS endpoint ending in <code className="font-mono text-zinc-600 dark:text-zinc-400">/mcp</code> that takes JSON-RPC over POST. There is no SSE or stdio variant, and nothing to run on your own machine.
              </SetupStep>
              <SetupStep n={2} title="Let it discover OAuth.">
                Auth is OAuth 2.1 with PKCE and dynamic client registration. A client finds the authorization server through <code className="font-mono text-zinc-600 dark:text-zinc-400">/.well-known/oauth-protected-resource/mcp</code> on the same origin, registers itself as a public client (no client ID or secret to enter), and asks for the scopes <code className="font-mono text-zinc-600 dark:text-zinc-400">usernode:apps:read</code> and <code className="font-mono text-zinc-600 dark:text-zinc-400">usernode:proposals:write</code>. You approve those once on Homeroom&rsquo;s consent page.
              </SetupStep>
              <SetupStep n={3} title="Check where its callback goes.">
                Homeroom registers a client only if its OAuth callback is on <code className="font-mono text-zinc-600 dark:text-zinc-400">claude.ai</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">claude.com</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">chatgpt.com</code> or <code className="font-mono text-zinc-600 dark:text-zinc-400">openai.com</code> (or a host the deployment&rsquo;s operator has added). A callback on localhost, which command-line clients use, is accepted only by a Homeroom running in local-development mode. A refused registration answers <code className="font-mono text-zinc-600 dark:text-zinc-400">invalid_redirect_uri</code>, and that is a limit on the platform side rather than something to fix in the client.
              </SetupStep>
              <SetupStep n={4} title="Name it homeroom and read your tool list.">
                Tools arrive as <code className="font-mono text-zinc-600 dark:text-zinc-400">mcp__homeroom__whoami</code> in most clients, or as <code className="font-mono text-zinc-600 dark:text-zinc-400">mcp__claude_ai_homeroom__whoami</code> where the client namespaces by product. The part between the first and last <code className="font-mono text-zinc-600 dark:text-zinc-400">__</code> is the server name the permission rules are written for; if it is not one of the spellings they cover, type it into the field under &ldquo;Stop the permission prompts&rdquo;. Have the agent call <code className="font-mono text-zinc-600 dark:text-zinc-400">get_connector_guidance</code> first: it returns the connector&rsquo;s full operating charter.
              </SetupStep>
            </ol>
        </Disclosure>
        </GroupedList>
        <p className={GROUP_NOTE}>
          Whichever you use, approve the connection in the browser page that opens.
        </p>
        <h4 className={`${GROUP_LABEL} mt-6`}>Claude Code permissions</h4>
        <GroupedList className="mx-0">
        {/*
            #1218: the Name field in Claude.ai's "Add custom connector" dialog
            is where the permission-rule server segment comes from — the client
            builds tool names from what the human types, not from the server's
            own serverInfo.name. One account typed `Uesrnode`, and because a
            permission rule's server segment cannot be wildcarded, every rule
            Homeroom ships missed it SILENTLY. So the canonical name is stated
            here, at the moment the field is filled in, rather than left to
            chance. `homeroom` is exactly what serverInfo.name reports, so a
            client that derives the name and one where it was typed agree.
            The pre-rename spellings are still in the shipped block, so an
            existing connector keeps working and only a NEW one needs the
            name below.
        */}
        <Disclosure title="Name it homeroom" hint="So the ready-made rules match">
          <p className={BODY}>
            Name it exactly <code className="font-mono text-zinc-600 dark:text-zinc-400">homeroom</code>. Claude Code builds its permission rules from that name. A different spelling still works, but the read-only allowlist Homeroom ships in every app repo will not match it, and you will keep being asked to approve each call. The allowlist covers <code className="font-mono text-zinc-600 dark:text-zinc-400">Homeroom</code> as well, so the capitalised form is safe. It also still covers <code className="font-mono text-zinc-600 dark:text-zinc-400">usernode</code> and <code className="font-mono text-zinc-600 dark:text-zinc-400">Usernode</code>, the names this connector went by before, so a connector you added earlier keeps working and there is nothing to redo. Anything else needs the rules rewritten, which the field under &ldquo;Stop the permission prompts&rdquo; does for you.
          </p>
        </Disclosure>
        {/*
            #1218 follow-up: the same three rules land in two different files
            depending on where Claude Code is running, and a single block
            headed "add this to ~/.claude/settings.json" was wrong for the
            surface that needs it most. A web session's container is built
            fresh, so a file on the user's own machine is not in it; the only
            thing that travels is the repo, so the per-repo copy is the one
            that applies there. Hence three labelled cases rather than one
            block of prose: a user reads the case they are in.

            Static markup, not a stateful island: both copy buttons and the
            case filtering are wired by Settings._renderConnectors()'s sibling
            handlers, exactly like #connector-url-copy above it. The cases
            render VISIBLE and are hidden by that code, so a client name it
            cannot classify — and a page whose script has not run yet — shows
            everything rather than nothing.
        */}
        <Disclosure id="connector-prompt-help" title="Stop the permission prompts" hint="If Claude Code asks before every call">
            <p className={`${BODY} mb-3`}>
              Claude Code asks you to approve <em>every</em> connector call by default, including read-only ones like <code className="font-mono text-zinc-600 dark:text-zinc-400">whoami</code> and <code className="font-mono text-zinc-600 dark:text-zinc-400">get_app</code>. Which fix applies depends on where you run it.
            </p>
            {/*
                #1222 follow-up: the page used to present the blocks below with
                no statement of whose job it is to apply them, and a reasonable
                reader concluded Homeroom had a switch it was choosing not to
                offer. It does not — permission rules live in the user's own
                settings file or their own repo, and nothing this server sends
                can put them there. Saying so is not an apology; it is what
                turns "why is this still asking me" into a task with an owner.
            */}
            <p className={`${BODY} mb-3`}>
              Homeroom cannot switch this on for you. Permission rules live in a file on your machine or in your app&rsquo;s repo, and a connector has no way to write either, which is also what stops any other connector you add from granting itself permissions. Copying one of the blocks below is the whole fix, and it is a one-time thing.
            </p>

            <div id="connector-case-cc-local" className="mb-3">
              <h5 className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                Claude Code on your own machine
              </h5>
              <p className={`${BODY} mb-2`}>
                Add this to your own <code className="font-mono text-zinc-600 dark:text-zinc-400">~/.claude/settings.json</code>. It is the only one of the three that covers <strong className="font-semibold text-zinc-600 dark:text-zinc-400">every</strong> repo at once, including repos Homeroom never made.
              </p>
              {/*
                  #1290: Copy lives in a header row ABOVE the block, not beside
                  it. Beside it, the button was a flex sibling of a twelve-line
                  <pre> and `align-items: stretch` made it a ~210px violet slab
                  — louder than #connector-url-copy, which is the section's real
                  primary action — while taking ~80px of width off a block that
                  already scrolls sideways on a phone. The row is the idiom
                  sections/agent-files.tsx uses for its upload controls, and it
                  is also where the destination filename belongs: the two blocks
                  are byte-identical, so the file each one is for is the only
                  thing that distinguishes them.
              */}
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500 truncate">~/.claude/settings.json</span>
                <Button
                  id="connector-allow-rules-copy"
                  type="button"
                  layout="shrink"
                  variant="outline"
                  size="xsText"
                  ink="muted"
                  className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]"
                  aria-label="Copy the allow rules for your personal settings file"
                >
                  Copy
                </Button>
              </div>
              <pre id="connector-allow-rules" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2">{PERSONAL_ALLOW_RULES}</pre>
            </div>

            <div id="connector-case-cc-web" className="mb-3">
              <h5 className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                Claude Code on the web
              </h5>
              <p className={`${BODY} mb-2`}>
                A web session gets a fresh container each time, so a settings file on your own machine is not in it and last session&rsquo;s approvals are gone. What the container does carry is the repo it checks out, so commit the same block as <code className="font-mono text-zinc-600 dark:text-zinc-400">.claude/settings.json</code> in the app repo. Homeroom writes that file into every app repo it creates, imports or forks; repos that already existed before it shipped do not have one, and adding it is an ordinary commit.
              </p>
              {/* Same header row as the case above — see the note there. */}
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500 truncate">.claude/settings.json</span>
                <Button
                  id="connector-repo-allow-rules-copy"
                  type="button"
                  layout="shrink"
                  variant="outline"
                  size="xsText"
                  ink="muted"
                  className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]"
                  aria-label="Copy the allow rules to commit in your app repo"
                >
                  Copy
                </Button>
              </div>
              {/* `mb-2` was the flex row's; the trailing paragraph still needs it. */}
              <pre id="connector-repo-allow-rules" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2 mb-2">{PERSONAL_ALLOW_RULES}</pre>
              <p className={BODY}>
                Claude Code may still ask you to trust the workspace once per container before a repo-level file takes effect. Whether that dialog appears in every web session has not been settled. If you are still prompted after committing the file, that is the reason, and the case above is the fix that does not depend on it.
              </p>
            </div>

            <div id="connector-case-chat" className="mb-3">
              <h5 className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                Claude.ai chat, ChatGPT and Codex
              </h5>
              <p className={BODY}>
                Nothing to do. You approve the connector once when you connect it and it does not ask again per call. The two blocks above are Claude Code&rsquo;s file format and have no effect in those products.
              </p>
            </div>

            <p className={BODY}>
              Reads only. Anything that acts on your behalf (filing a request, opening or advancing a proposal) still asks every time, on purpose.
            </p>
            {/*
                The blocks above cover `homeroom` and `Homeroom`, plus the
                pre-rename `usernode` and `Usernode`. Any other spelling — a
                typo, a name someone chose — needs the same rules with that
                segment, and telling a user to hand-edit twenty JSON strings is
                telling them to make a twenty-first mistake. So the page does
                the edit: type what your tools are actually called, and both
                blocks above are rewritten in place. Typing a name the block
                already covers puts the shipped rules back, rather than
                narrowing them to the one spelling that was typed.

                Static markup with a sibling handler, like the copy buttons: the
                rewrite is Settings._wireConnectorNameSpelling(), which writes
                textContent (never innerHTML) into the two <pre> elements from a
                sanitised segment. It ships EMPTY so the prerendered document
                shows the canonical rules, which is the right answer for almost
                everyone and the only one that is right before script runs.
            */}
            <div className="mt-3">
              <Label className="mb-1" htmlFor="connector-name-spelling">
                Connector registered under a different name?
              </Label>
              <p className={`${BODY} mb-2`}>
                Check what your tools are called in your session, the middle part of <code className="font-mono text-zinc-600 dark:text-zinc-400">mcp__homeroom__whoami</code>. If it is not <code className="font-mono text-zinc-600 dark:text-zinc-400">homeroom</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">Homeroom</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">usernode</code> or <code className="font-mono text-zinc-600 dark:text-zinc-400">Usernode</code>, type it here and both blocks above are rewritten for it.
              </p>
              <Input
                id="connector-name-spelling"
                type="text"
                spellCheck="false"
                width="flex"
                mono
                placeholder="homeroom"
              />
            </div>
        </Disclosure>
        </GroupedList>
        {/*
            Read-only, and empty until Settings._renderConnectors() fills it:
            rendering it populated would mismatch hydration, and there is
            deliberately no control next to it that WRITES throttle state. A
            "show it again" button is a button for making the connector nag;
            opening a new chat is what arms the tip.

            #2370 moved it OUT of the permission row's body. It reports what
            the connector did in your last chat, which is news rather than
            reference, and dapp.json reads it as rendered text.
        */}
        <p id="connector-hint-status" className="hidden px-4 pt-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400"></p>
        <h4 className={`${GROUP_LABEL} mt-6`}>
          Connected
        </h4>
        <div id="connectors-list" className="space-y-2">
          <ConnectorsList />
        </div>
        <StatusLine id="connectors-status" size="xs" />
      </div>
      {/*
          "Preferred build flow" (#1049) — the escape hatch for the dev-chat
          picker's "remember my option" checkbox. Once a user ticks that box
          the picker stops rendering, so there has to be somewhere to change
          their mind; Connections is where the GitHub link and the connectors
          already live, which is exactly the machinery the external flows
          depend on.

          It was INJECTED at runtime by Settings._renderDevFlowSection until
          #1191, for a reason that had expired: the shell's body used to be a
          hand-written document pinned id-for-id against
          tests/baselines/shell-markup.json, so a new settings control had
          nowhere to go but a `document.createElement` into this pane. The
          pane is a component now and a deliberate id is a line in ADDED_IDS,
          so the block is markup and the module keeps only what it always kept
          for every other control here: the value, the save, and the two
          option gates.

          #2370 moved the social-account block to the TOP of the pane, so this
          no longer sits above it. It stays last on purpose: it is a preference
          about work you have not started yet, not something you came here for.
      */}
      <div id="dev-flow-pref-section" className="mt-10">
        <SectionHeading title="Where changes get built">
          Choose where Homeroom builds your changes, or let it ask each time.
        </SectionHeading>
        {/*
            A plain `<select>`, not `@/components/ui/select`: the primitive's
            `default` variant is the same field box but at `border-zinc-300`
            with no explicit ink, and this control writes its own
            `text-zinc-900 dark:text-zinc-100`. Adopting it is a styling
            decision with its own evidence to gather, not part of moving the
            block out of a runtime injection.

            The two hand-off options are disabled by settings.js where the
            deployment has no external flows — a deployment without them can
            still express "always build on Homeroom" vs "ask me".
        */}
        <select
          id="settings-dev-flow"
          className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
          defaultValue=""
        >
          <option value="">Ask me every time</option>
          <option value="platform">Build on Homeroom</option>
          <option value="claude-code">Claude Code (claude.ai/code)</option>
          <option value="codex">Codex (chatgpt.com/codex)</option>
        </select>
        <div id="settings-dev-flow-status" className="text-xs mt-2 hidden"></div>
      </div>
    </div>
  );
}
