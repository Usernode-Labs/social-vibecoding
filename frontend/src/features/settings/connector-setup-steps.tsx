import * as React from 'react';

import { Button } from '@/components/ui/button';
import { CheckIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';

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
 * Deliberately presentational and state-free: an <ol> of prose that holds no
 * state. That is what lets the dev session page nest it inside a stateful
 * React island (features/dev-chat/connector-setup-inline.tsx) while Settings
 * keeps rendering it as the static markup settings.js reads around.
 *
 * Only Settings passes `track` (#6136). With it each step's number is a tick
 * button whose `aria-pressed` settings.js owns, and ChatGPT's step 3 carries a
 * Copy settings.js wires. Without it the markup is what it always was, so the
 * hand-off and the launchpad card get no ticks, no Copy and no duplicate id.
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
export function SetupStep({ n, title, track, children }: {
  n: number;
  title: string;
  /** Settings' guide this step belongs to: draws the number as a tick (#6136). */
  track?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      {track ? <StepTick track={track} n={n} /> : (
        <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 text-[0.6875rem] font-semibold leading-none text-zinc-600 dark:text-zinc-300">
          {n}
        </span>
      )}
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
 * The number badge as a press target (#6136): a 44px button around the same
 * 20px badge, its negative margins keeping the badge and the step's text exactly
 * where the plain number keeps them. `self-start` because the row stretches its
 * items, and a stretched button would centre the badge on a long step's height.
 *
 * settings.js owns `aria-pressed`, and the done look is read off it with
 * `group-aria-pressed:` variants, so the class string is a constant and nothing
 * writes a class at runtime. React rendered `aria-pressed` once as a constant,
 * so a re-render on a language change leaves what settings.js wrote alone.
 */
function StepTick({ track, n }: { track: string; n: number }) {
  const t = useMessages('settings');
  return (
    <button
      type="button"
      data-connector-step-tick={`${track}:${n}`}
      aria-pressed="false"
      aria-label={t('settings:connectors.progress.tickAria', { n })}
      className="group -mb-3 -me-3 -ms-3 -mt-2.5 flex h-11 w-11 shrink-0 items-center justify-center self-start rounded-full"
    >
      <span
        aria-hidden="true"
        className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-100 text-[0.6875rem] font-semibold leading-none text-zinc-600 group-aria-pressed:bg-violet-600 group-aria-pressed:text-white dark:bg-zinc-800 dark:text-zinc-300"
      >
        <span className="group-aria-pressed:hidden">{n}</span>
        <CheckIcon className="hidden h-3 w-3 group-aria-pressed:block" />
      </span>
    </button>
  );
}

/** Inline marks the walkthroughs' sentences carry; the catalog numbers them. */
const STRONG = <strong className="font-semibold text-zinc-600 dark:text-zinc-400" />;
const CODE = <code className="font-mono text-zinc-600 dark:text-zinc-400" />;
const PLUGINS_LINK = <a href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer" className="font-semibold text-violet-700 dark:text-violet-400 underline underline-offset-2" />;

/** Claude.ai: six steps, and the route that also sets up Claude Code. */
export function ClaudeSetupSteps({ track }: { track?: string }) {
  const t = useMessages('settings');
  return (
    <ol className="space-y-2">
      <SetupStep n={1} title={t('settings:connectors.claudeSteps.open.title')} track={track}>
        <RichMessage id="settings:connectors.claudeSteps.open.body" components={[STRONG, CODE]} />
      </SetupStep>
      <SetupStep n={2} title={t('settings:connectors.claudeSteps.start.title')} track={track}>
        <RichMessage id="settings:connectors.claudeSteps.start.body" components={[CODE, CODE]} />
      </SetupStep>
      <SetupStep n={3} title={t('settings:connectors.claudeSteps.paste.title')} track={track}>
        <RichMessage id="settings:connectors.claudeSteps.paste.body" components={[CODE]} />
      </SetupStep>
      <SetupStep n={4} title={t('settings:connectors.claudeSteps.oauth.title')} track={track}>
        {t('settings:connectors.claudeSteps.oauth.body')}
      </SetupStep>
      <SetupStep n={5} title={t('settings:connectors.claudeSteps.save.title')} track={track}>
        {t('settings:connectors.claudeSteps.save.body')}
      </SetupStep>
      <SetupStep n={6} title={t('settings:connectors.claudeSteps.enable.title')} track={track}>
        <RichMessage id="settings:connectors.claudeSteps.enable.body" components={[CODE]} />
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

export function ChatgptSetupSteps({ url, track }: { url?: string; track?: string }) {
  const t = useMessages('settings');
  return (
    <>
      <ol className="space-y-2">
        <SetupStep n={1} title={t('settings:connectors.chatgptSteps.directory.title')} track={track}>
          <RichMessage id="settings:connectors.chatgptSteps.directory.body" components={[PLUGINS_LINK]} />
        </SetupStep>
        <SetupStep n={2} title={t('settings:connectors.chatgptSteps.create.title')} track={track}>
          <RichMessage id="settings:connectors.chatgptSteps.create.body" components={[STRONG, STRONG]} />
        </SetupStep>
        <SetupStep n={3} title={t('settings:connectors.chatgptSteps.url.title')} track={track}>
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
          {track ? (
            <Button
              id="connector-chatgpt-url-copy"
              type="button"
              layout="shrink"
              variant="outline"
              size="xsText"
              ink="muted"
              className="ms-2 inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]"
              aria-label={t('settings:connectors.url.copyAria')}
            >
              {t('core:common.copy')}
            </Button>
          ) : null}
        </SetupStep>
        <SetupStep n={4} title={t('settings:connectors.chatgptSteps.use.title')} track={track}>
          <RichMessage id="settings:connectors.chatgptSteps.use.body" components={[CODE, <em />]} />
        </SetupStep>
      </ol>
      <p className={`${CONNECTOR_BODY} mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800`}>
        <RichMessage id="settings:connectors.chatgptSteps.inShort" components={[STRONG]} />
      </p>
    </>
  );
}
