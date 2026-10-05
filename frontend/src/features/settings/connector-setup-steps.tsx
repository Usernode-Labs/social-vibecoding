import { RichMessage } from "../../lib/i18n/react";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
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
      <Localized element={<SetupStep n={1} title={catalogText("settings:open_connector_settings_b334fccc")}><RichMessage id="settings:sentence_8edd2303b5cb" components={[<strong className="font-semibold text-zinc-600 dark:text-zinc-400" />, <code className="font-mono text-zinc-600 dark:text-zinc-400">claude.ai/customize/connectors</code>]} /></SetupStep>} messages={{"title":"settings:open_connector_settings_b334fccc"}} />
      <Localized element={<SetupStep n={2} title={catalogText("settings:start_a_custom_connector_99c6955d")}><RichMessage id="settings:sentence_749f372c8ade" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">+</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">homeroom</code>]} /></SetupStep>} messages={{"title":"settings:start_a_custom_connector_99c6955d"}} />
      <Localized element={<SetupStep n={3} title={catalogText("settings:paste_your_mcp_server_url_99cf1764")}><RichMessage id="settings:sentence_2f30cf620635" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">/mcp</code>]} /></SetupStep>} messages={{"title":"settings:paste_your_mcp_server_url_99cf1764"}} />
      <Localized element={<SetupStep n={4} title={catalogText("settings:add_oauth_credentials_if_needed_a0e89f67")}><Message id="settings:if_a_server_requires_oauth_open_advanced_setting_6f6fdf73" /></SetupStep>} messages={{"title":"settings:add_oauth_credentials_if_needed_a0e89f67"}} />
      <Localized element={<SetupStep n={5} title={catalogText("settings:save_and_authenticate_25e1b137")}><Message id="settings:click_add_to_finish_configuring_then_click_conne_6b8cf6fa" /></SetupStep>} messages={{"title":"settings:save_and_authenticate_25e1b137"}} />
      <Localized element={<SetupStep n={6} title={catalogText("settings:enable_it_in_a_conversation_2824bdbd")}><RichMessage id="settings:sentence_2886bdc0f8cd" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">+</code>]} /></SetupStep>} messages={{"title":"settings:enable_it_in_a_conversation_2824bdbd"}} />
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
        <Localized element={<SetupStep n={1} title={catalogText("settings:use_chatgpt_on_the_web_64173a4f")}><Message id="settings:open_chatgpt_in_your_browser_custom_mcp_setup_is_7bdf8b45" /></SetupStep>} messages={{"title":"settings:use_chatgpt_on_the_web_64173a4f"}} />
        <Localized element={<SetupStep n={2} title={catalogText("settings:turn_on_developer_mode_3c71c2d5")}><RichMessage id="settings:sentence_76a8ea6c17eb" components={[<strong className="font-semibold text-zinc-600 dark:text-zinc-400" />]} /></SetupStep>} messages={{"title":"settings:turn_on_developer_mode_3c71c2d5"}} />
        <Localized element={<SetupStep n={3} title={catalogText("settings:open_the_chatgpt_plugins_page_1aefddc5")}><Message after={" "} id="settings:after_developer_mode_is_enabled_open_1dacb350" /><strong className="font-semibold text-zinc-600 dark:text-zinc-400"><Message id="settings:chatgpt_plugins_4b78aac7" /></strong>.
        </SetupStep>} messages={{"title":"settings:open_the_chatgpt_plugins_page_1aefddc5"}} />
        <Localized element={<SetupStep n={4} title={catalogText("settings:click_the_button_3e4873d7")}><RichMessage id="settings:sentence_adb32bd5ff48" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">+</code>]} /></SetupStep>} messages={{"title":"settings:click_the_button_3e4873d7"}} />
        <Localized element={<SetupStep n={5} title={catalogText("settings:enter_your_mcp_server_details_ee2fdbc4")}><RichMessage id="settings:sentence_6988314532c0" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">localhost</code>]} /></SetupStep>} messages={{"title":"settings:enter_your_mcp_server_details_ee2fdbc4"}} />
        <Localized element={<SetupStep n={6} title={catalogText("settings:create_the_app_863f4ba3")}><Message id="settings:chatgpt_connects_to_the_mcp_server_and_discovers_79236277" /></SetupStep>} messages={{"title":"settings:create_the_app_863f4ba3"}} />
        <Localized element={<SetupStep n={7} title={catalogText("settings:use_the_mcp_server_in_a_chat_be834331")}><RichMessage id="settings:sentence_c1ffcd628670" components={[<strong className="font-semibold text-zinc-600 dark:text-zinc-400" />, <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code>, <em />]} /></SetupStep>} messages={{"title":"settings:use_the_mcp_server_in_a_chat_be834331"}} />
      </ol>
      <p className={`${CONNECTOR_BODY} mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800`}><RichMessage id="settings:sentence_7233037f21f2" components={[<strong className="font-semibold text-zinc-600 dark:text-zinc-400" />, <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">+</code>]} /></p>
    </>
  );
}
