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
 * The URL is named as "the MCP server URL above" rather than spelled out,
 * on both screens, for the reason the connectors.tsx header gives: a host
 * written into prose goes stale on a fork or a config change. Each caller
 * puts the live `${origin}/mcp` value on screen next to these steps.
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
 * ChatGPT: seven steps, plus the one-line recap the route has always
 * carried under them. The recap ships with the steps rather than beside
 * them because it is the same reference — a reader who has done this once
 * needs only that line, on either screen.
 */
export function ChatgptSetupSteps() {
  return (
    <>
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
          Enter the URL of the remote MCP server (for Homeroom, the MCP server URL above) and configure authentication if required. The server must be reachable by ChatGPT; one running only on <code className="font-mono text-zinc-600 dark:text-zinc-400">localhost</code> will not work directly.
        </SetupStep>
        <SetupStep n={6} title="Create the app.">
          ChatGPT connects to the MCP server and discovers the tools it exposes. Once that succeeds, save/create the app.
        </SetupStep>
        <SetupStep n={7} title="Use the MCP server in a chat.">
          Start a <strong className="font-semibold text-zinc-600 dark:text-zinc-400">new ChatGPT conversation</strong> and open the <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> / tools menu next to the message box. Select Developer mode, then select the MCP app you just created. Now ask ChatGPT to perform something that uses one of the tools, for example: <em>&ldquo;Use my MCP server to list the open support tickets.&rdquo;</em> When appropriate, ChatGPT will call the tools your MCP server exposes and use their results in the conversation.
        </SetupStep>
      </ol>
      <p className={`${CONNECTOR_BODY} mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800`}>
        <strong className="font-semibold text-zinc-600 dark:text-zinc-400">In short:</strong> Settings &rarr; Security and login &rarr; Developer mode ON &rarr; ChatGPT Plugins &rarr; <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> &rarr; Enter MCP server URL &rarr; Create &rarr; New chat &rarr; <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code> &rarr; Developer mode &rarr; select your MCP app &rarr; Ask ChatGPT to use it.
      </p>
    </>
  );
}
