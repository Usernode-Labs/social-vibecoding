import * as React from 'react';

/**
 * The canonical Claude.ai and ChatGPT connector walkthroughs (#2706).
 *
 * These step lists used to sit inline in sections/connectors.tsx, which was
 * fine while Settings was the only screen that taught the connector. It is
 * not any more: the dev session page's hand-off launchpad asks for the same
 * connector, and #2706 is about teaching it THERE rather than sending the
 * reader to Settings to read it. Two screens, one set of facts — so the
 * facts live in one module and both screens render it.
 *
 * Deliberately presentational and state-free: an <ol> of prose, no props,
 * nothing written into it after it renders. That is what lets the dev
 * session page nest it inside a stateful React island
 * (features/dev-chat/connector-setup-inline.tsx) while Settings keeps
 * rendering it as the static markup settings.js reads around.
 *
 * How the connector URL is named splits by product. Claude's steps say
 * "the MCP server URL above" and point at the value each caller renders
 * above them, for the reason the connectors.tsx header gives: a host
 * written into prose goes stale on a fork or a config change. ChatGPT's
 * step 3 names the endpoint directly instead, and carries it the same way
 * rather than as a written host: the caller hands over the live
 * `${origin}/mcp` and the step renders that. Where no caller value exists
 * (Settings' prerendered interior) a fill-in placeholder stands in until
 * settings.js writes the same derived origin the #connector-url field
 * shows.
 *
 * TWO SCREENS MEANS NO CROSS-REFERENCES. A step may point at the URL each
 * caller renders above it and at nothing else: Claude's step 2 used to send
 * the reader to the "Name it homeroom" disclosure under the Settings
 * walkthrough for the reason the spelling matters, and that block exists on
 * one of the two screens. The reason is in the step now. Settings keeps the
 * disclosure, which adds what a step should not carry — the capitalised and
 * pre-rename spellings the shipped allowlist also covers.
 */

/** Body copy, shared with sections/connectors.tsx's own prose. */
export const CONNECTOR_BODY = 'text-[0.9375rem] leading-snug text-zinc-500 dark:text-zinc-400';

/**
 * One numbered row of the setup walkthroughs below (#1289). A presentational
 * helper, not an island: the whole walkthrough is static prose, so it renders
 * once and nothing ever writes into it. The <ol>/<li> structure is real —
 * screen readers announce "list, N items" — with the number drawn as a badge
 * because the two products' own docs count steps the same way.
 */
export function SetupStep({ n, title, children }: {
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

/** Claude.ai: six steps, and the route that also sets up Claude Code. */
export function ClaudeSetupSteps() {
  return (
    <ol className="space-y-2">
      <SetupStep n={1} title="Open connector settings.">
        Go to <strong className="font-semibold text-zinc-600 dark:text-zinc-400">Customize &rarr; Connectors</strong> in Claude (<code className="font-mono text-zinc-600 dark:text-zinc-400">claude.ai/customize/connectors</code>). This is where both directory connectors and your own custom ones live.
      </SetupStep>
      <SetupStep n={2} title="Start a custom connector.">
        Click the <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> button, then choose &ldquo;Add custom connector&rdquo;. In the dialog, put <code className="font-mono text-zinc-600 dark:text-zinc-400">homeroom</code> in the Name field, exactly that spelling: Claude Code builds its permission rules from what you type here, and the read-only allowlist Homeroom ships in every app repo matches only the names it knows. On Team or Enterprise plans this option isn&rsquo;t there for members, so an Owner adds it first from Organization settings &rarr; Connectors (Add &rarr; hover &ldquo;Custom&rdquo; &rarr; &ldquo;Web&rdquo;).
      </SetupStep>
      <SetupStep n={3} title="Paste your MCP server URL.">
        For Homeroom that is the MCP server URL above, a public HTTPS endpoint ending in <code className="font-mono text-zinc-600 dark:text-zinc-400">/mcp</code>. A custom server must be reachable from Anthropic&rsquo;s cloud, not just from your machine.
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
  );
}

/**
 * ChatGPT: six steps, plus the one-line recap the route has always
 * carried under them. The recap ships with the steps rather than beside
 * them because it is the same reference — a reader who has done this once
 * needs only that line, on either screen.
 *
 * Reworked for #4431: custom MCP servers are created from the plugins
 * directory now, and the old Developer-mode gate and Plugins page are gone
 * from the flow. #4433 cut the front of it again: the directory has its own
 * address, chatgpt.com/plugins, so the walkthrough opens there directly
 * instead of walking Settings &rarr; Plugins &amp; Connectors &rarr; Browse
 * plugins directory first. After the server is created it still has to be
 * switched on per chat, in the connector picker.
 *
 * The one URL the steps spell out is ChatGPT's own page — it is
 * third-party and does not move with a fork. The Homeroom endpoint in
 * step 3 is not spelled either: it renders the live value the caller
 * hands it, per the module header.
 */

/**
 * What stands where the live connector URL goes when no caller value was
 * handed in — Settings' prerendered interior, before script runs. The
 * same fill-in style as the Codex blocks in sections/connectors.tsx: it
 * reads as something to replace, not as an address someone might paste
 * as-is. settings.js fills the step unconditionally from the origin it is
 * served from, so this literal is never matched against — it only has to
 * look like a fill-in.
 */
const STEP_URL_PLACEHOLDER = 'https://<your-homeroom-host>/mcp';

export function ChatgptSetupSteps({ url }: { url?: string }) {
  return (
    <>
      <ol className="space-y-2">
        <SetupStep n={1} title="Open the plugins directory.">
          Go to <a href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer" className="font-semibold text-violet-700 dark:text-violet-400 underline underline-offset-2">chatgpt.com/plugins</a> in your browser. Plugin and MCP setup is currently a web feature.
        </SetupStep>
        <SetupStep n={2} title="Create a custom MCP server.">
          Click <strong className="font-semibold text-zinc-600 dark:text-zinc-400">&ldquo;Add plugin&rdquo;</strong>, then choose <strong className="font-semibold text-zinc-600 dark:text-zinc-400">&ldquo;Create custom MCP server&rdquo;</strong>.
        </SetupStep>
        <SetupStep n={3} title="Enter Homeroom MCP server URL.">
          {/* The step names the endpoint itself rather than pointing at the
              value rendered above it, but the URL is still never written
              into the copy: the caller hands over the live `${origin}/mcp`
              (the launchpad card and the hand-off as a prop), and Settings'
              interior ships the placeholder until settings.js fills
              `data-connector-step-url` from the same derived origin the
              #connector-url field shows. */}
          <code
            data-connector-step-url="1"
            className="break-all font-mono text-zinc-600 dark:text-zinc-400"
          >
            {url || STEP_URL_PLACEHOLDER}
          </code>
        </SetupStep>
        <SetupStep n={4} title="Turn the server on in a chat.">
          Open the <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> / connector picker next to the message box, select the server you just created, and set it as active. Now ask ChatGPT to perform something that uses one of the tools, for example: <em>&ldquo;Use my MCP server to list the open support tickets.&rdquo;</em> When appropriate, ChatGPT will call the tools your MCP server exposes and use their results in the conversation.
        </SetupStep>
      </ol>
      <p className={`${CONNECTOR_BODY} mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800`}>
        <strong className="font-semibold text-zinc-600 dark:text-zinc-400">In short:</strong> chatgpt.com/plugins &rarr; Add plugin &rarr; Create custom MCP server &rarr; enter the Homeroom MCP server URL &rarr; connector picker &rarr; set it active.
      </p>
    </>
  );
}
