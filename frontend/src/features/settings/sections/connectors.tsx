import * as React from 'react';

import { Button } from '@/components/ui/button';
import { ChevronRightIcon } from '@/components/ui/icons';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { RichMessage, useMessages } from '../../../lib/i18n/react';

import {
  ChatgptSetupSteps,
  ClaudeSetupSteps,
  CONNECTOR_BODY,
  SetupStep,
} from '../connector-setup-steps';
import { ConnectorsList } from '../connectors-list';
import { SocialIdentity } from '../social-identity';

/**
 * Hosted MCP connector: connect Claude.ai / ChatGPT so their built-in coding
 * agent (Claude Code on the web, Codex) can do the work on the user's own
 * subscription. This file also renders the part that shared that pane
 * until the settings restructure: the GitHub/X ownership proofs for the
 * Layer-1 daily credit tier (LinkedAccountsSection, IDENTITY ONLY: immutable
 * provider id + display handle and verification timestamps, with no provider
 * token retained).
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
 * The two product walkthroughs moved to ../connector-setup-steps (#2706).
 * The dev session page's hand-off launchpad now teaches the same connector
 * inline instead of sending the reader here, and a second copy of six and
 * seven steps is a second copy to keep true. `SetupStep` travelled with
 * them because the Codex and generic routes below still render rows in the
 * same idiom, and tests/connector-setup-shared.test.js pins that neither
 * screen grew a copy of its own.
 */

/**
 * One row of a grouped card that opens in place (#2370).
 *
 * The pane used to be flat: four walkthroughs of three to seven steps, a
 * hundred words on naming and three cases of permission rules, all open, all
 * at 12px — 6,330px on a phone before the social accounts at the bottom. Every
 * one of those is reference for a reader who has picked a route, so each is a
 * row now: the summary names the route and says what it costs ("6 steps ·
 * also sets up Claude Code", "4 steps · in the plugins directory"), which
 * is what lets someone choose WITHOUT
 * opening any of them.
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
function Disclosure({ id, title, hint, nested, children }: {
  id?: string;
  title: string;
  hint: string;
  /**
   * A row INSIDE another row's open body. Two things change, both literal:
   * the type steps down (a nested row must not read as a peer of the route it
   * sits in), and the chevron keys off a NAMED group — `group-open:` compiles
   * to `.group[open] .x`, which matches any open ancestor, so an unnamed inner
   * chevron would turn the moment the OUTER row opened.
   */
  nested?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      id={id}
      className={nested
        ? 'group/sub [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-700'
        : 'group [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800'}
    >
      <summary className={nested
        ? 'list-none cursor-pointer active:bg-zinc-200 dark:active:bg-zinc-700'
        : 'list-none cursor-pointer active:bg-zinc-50 dark:active:bg-zinc-800'}
      >
        <ListRow
          className={nested ? 'gap-3 px-3 py-2.5' : 'py-3'}
          inset="none"
          chevron={false}
          title={title}
          titleClassName={nested ? 'text-[0.9375rem] font-medium' : 'font-medium'}
          subtitle={hint}
          subtitleClassName={nested ? 'whitespace-normal text-[0.8125rem]' : 'whitespace-normal'}
          trailing={(
            <ChevronRightIcon
              aria-hidden="true"
              className={nested
                ? 'h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400 transition-transform group-open/sub:rotate-90'
                : 'h-5 w-5 shrink-0 text-zinc-300 dark:text-zinc-600 transition-transform group-open:rotate-90'}
            />
          )}
        />
      </summary>
      <div className={nested ? 'px-3 pb-3' : 'px-4 pb-4'}>{children}</div>
    </details>
  );
}

/**
 * "Ask <product> to guide you" — the first thing inside a route (#1607, #2370).
 *
 * These two links used to sit on the overview as "Set it up in Claude" and
 * "Set it up in ChatGPT", directly above rows called "Claude.ai" and "ChatGPT".
 * Same two products, same goal, and nothing in either label said what differed:
 * one opens a chat that TALKS you through setup, the other is the written
 * steps. A reader met the choice of HOW before the choice of WHICH, twice.
 *
 * So the overview asks one question — which app — and the route answers the
 * second: the guided chat first, because it is the shorter path, then "Or
 * follow the steps". The ids are unchanged; settings.js writes each href by id
 * from the live connector URL, and a closed <details> keeps the node in the
 * document for it to find.
 *
 * An anchor, styled as the list's tinted control (the same surface as Connect
 * on the social rows) rather than a second filled button under Copy.
 */
function GuidedSetup({ id, href, product }: { id: string; href: string; product: string }) {
  const t = useMessages('settings');
  return (
    <>
      <a
        id={id}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-[44px] w-full items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-4 text-[0.9375rem] font-semibold text-violet-700 dark:text-violet-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
      >
        {t('settings:connectors.guided.ask', { product })}
      </a>
      <p className="mt-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
        {t('settings:connectors.guided.opens', { product })}
      </p>
      <h5 className="mt-5 mb-3 text-[0.8125rem] font-normal text-zinc-500 dark:text-zinc-500">
        {t('settings:connectors.guided.orSteps')}
      </h5>
    </>
  );
}

/** The grey label a grouped card sits under, in the sheet's 15px. */
const GROUP_LABEL = 'px-4 pb-2 text-[0.9375rem] font-normal text-zinc-500 dark:text-zinc-500';
/** The one line a grouped card may carry under it. */
const GROUP_NOTE = 'px-4 pt-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400';
/** Body copy inside an open disclosure. Shared, so the two screens match. */
const BODY = CONNECTOR_BODY;
/** Inline marks the pane's sentences carry; the catalog numbers them. */
const CODE = <code className="font-mono text-zinc-600 dark:text-zinc-400" />;
const STRONG = <strong className="font-semibold text-zinc-600 dark:text-zinc-400" />;

export function ConnectorsSection() {
  // Subscribed, although settings.js writes into this pane by id (the URL
  // field, the Copy buttons' labels, the hrefs, the two <pre> blocks, the
  // hint and status lines): a new language changes only React's own text
  // nodes, and none of those is a node settings.js replaces except a Copy
  // label mid-flash, which settings.js restores itself.
  const t = useMessages('settings');
  return (
    <div data-settings-section="connectors" className="hidden">
      <div id="connectors-section">
        <SectionHeading title={t('settings:connectors.title')}>
          {t('settings:connectors.intro')}
        </SectionHeading>
        {/*
            "MCP server URL", not "Connector URL" (#2370). The second was ours
            alone. The field this gets pasted into is labelled "Remote MCP
            server URL" in Claude and "MCP Server URL" in ChatGPT, and Codex's
            command is `codex mcp add` — so the label is the words the reader
            will be hunting for on the other side.
        */}
        <Label className="mb-1" htmlFor="connector-url">
          {t('settings:connectors.url.label')}
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
            aria-label={t('settings:connectors.url.copyAria')}
          >
            {t('core:common.copy')}
          </Button>
        </div>
        {/*
            What the address IS, for the reader who has never met "MCP". Opens
            in place, like every other disclosure on this pane, and under the
            field rather than over it — so Copy stays where it was and nothing
            needs a second one.
        */}
        <details className="group/help">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1 px-1 text-[0.9375rem] font-medium text-violet-700 dark:text-violet-400">
            {t('settings:connectors.howItWorks.summary')}
            <ChevronRightIcon aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open/help:rotate-90" />
          </summary>
          <div className="space-y-2 px-1 pb-2">
            <p className={BODY}>
              {t('settings:connectors.howItWorks.address')}
            </p>
            <p className={BODY}>
              {t('settings:connectors.howItWorks.paste')}
            </p>
            <p className={BODY}>
              {t('settings:connectors.howItWorks.approve')}
            </p>
          </div>
        </details>
        <h4 className={`${GROUP_LABEL} mt-4`}>{t('settings:connectors.chooseApp')}</h4>
        <GroupedList className="mx-0">
        {/*
            #1289: the one-line "Settings → Connectors, paste the URL" summary
            assumed both products still bury custom MCP servers one menu deep,
            and it skipped every step a first-time user actually stalls on —
            ChatGPT's plugins directory at chatgpt.com/plugins (where custom
            MCP servers are created, #4431, #4433), Claude's
            per-conversation toggle, the Team/Enterprise Owner requirement. So
            each product gets its own numbered walkthrough, current as of the
            flows the issues document. Wherever the products' generic docs say
            "your MCP server URL", these steps carry the dynamic,
            per-deployment value rather than a written host: they point back
            at the #connector-url field above, and ChatGPT's step 3 renders
            the same derived origin itself — the placeholder in its markup is
            filled by Settings._loadConnectors() the way the field and the
            Codex blocks are, so a fork or a config change cannot stale the
            copy. Static prose, deliberately
            NOT filtered by which product is already connected (unlike
            #connector-prompt-help's cases): these are pre-connection
            instructions, so the reader by definition hasn't told us which
            product they're in yet.
        */}
        <Disclosure title="Claude.ai" hint={t('settings:connectors.claude.hint')}>
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
          <GuidedSetup id="connector-open-claude" href="https://claude.ai/new" product="Claude" />
            <ClaudeSetupSteps />
          {/*
              #2370, second pass: these two used to be a card of their own on the
              overview ("Claude Code permissions"). They are consequences of THIS
              route and no other — Claude Code gets the connector from the
              claude.ai account it is added to (src/services/prompts.js says so
              to the agent itself), the name typed in step 2 is what the
              permission rules match on, and ChatGPT and Codex have no per-call
              prompt to stop. So a ChatGPT reader never meets them, and a Claude
              reader finds them where the steps that cause them are.

              The route's summary says "also sets up Claude Code", because the
              connector's in-chat tip (mcp-tools.js, buildSetupHint) sends people
              who are ALREADY connected to this page for these rules, and nobody
              opens a row called "6 steps" to fix a prompt.
          */}
          <h5 className="mt-5 px-3 pb-2 text-[0.8125rem] font-normal text-zinc-500 dark:text-zinc-500">
            {t('settings:connectors.claudeCode.heading')}
          </h5>
          <div className="overflow-hidden rounded-xl bg-zinc-100 dark:bg-zinc-800">
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
          <Disclosure nested title={t('settings:connectors.naming.title')} hint={t('settings:connectors.naming.hint')}>
            <p className={BODY}>
              <RichMessage id="settings:connectors.naming.body" components={[CODE, CODE, CODE, CODE]} />
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
          <Disclosure nested id="connector-prompt-help" title={t('settings:connectors.prompts.title')} hint={t('settings:connectors.prompts.hint')}>
              <p className={`${BODY} mb-3`}>
                <RichMessage id="settings:connectors.prompts.intro" components={[<em />, CODE, CODE]} />
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
                {t('settings:connectors.prompts.ownership')}
              </p>

              <div id="connector-case-cc-local" className="mb-3">
                <h5 className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                  {t('settings:connectors.prompts.local.title')}
                </h5>
                <p className={`${BODY} mb-2`}>
                  <RichMessage id="settings:connectors.prompts.local.body" components={[CODE, STRONG]} />
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
                    aria-label={t('settings:connectors.prompts.local.copyAria')}
                  >
                    {t('core:common.copy')}
                  </Button>
                </div>
                <pre id="connector-allow-rules" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2">{PERSONAL_ALLOW_RULES}</pre>
              </div>

              <div id="connector-case-cc-web" className="mb-3">
                <h5 className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                  {t('settings:connectors.prompts.web.title')}
                </h5>
                <p className={`${BODY} mb-2`}>
                  <RichMessage id="settings:connectors.prompts.web.body" components={[CODE]} />
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
                    aria-label={t('settings:connectors.prompts.web.copyAria')}
                  >
                    {t('core:common.copy')}
                  </Button>
                </div>
                {/* `mb-2` was the flex row's; the trailing paragraph still needs it. */}
                <pre id="connector-repo-allow-rules" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2 mb-2">{PERSONAL_ALLOW_RULES}</pre>
                <p className={BODY}>
                  {t('settings:connectors.prompts.web.trust')}
                </p>
              </div>

              <div id="connector-case-chat" className="mb-3">
                <h5 className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                  {t('settings:connectors.prompts.chat.title')}
                </h5>
                <p className={BODY}>
                  {t('settings:connectors.prompts.chat.body')}
                </p>
              </div>

              <p className={BODY}>
                {t('settings:connectors.prompts.readsOnly')}
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
                  {t('settings:connectors.prompts.spelling.label')}
                </Label>
                <p className={`${BODY} mb-2`}>
                  <RichMessage id="settings:connectors.prompts.spelling.body" components={[CODE, CODE, CODE, CODE, CODE]} />
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
          </div>
        </Disclosure>
        <Disclosure title="ChatGPT" hint={t('settings:connectors.chatgpt.hint')}>
          <GuidedSetup id="connector-open-chatgpt" href="https://chatgpt.com/" product="ChatGPT" />
            <ChatgptSetupSteps />
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
        <Disclosure id="connector-setup-codex" title="Codex" hint={t('settings:connectors.codex.hint')}>
            <ol className="space-y-2">
              <SetupStep n={1} title={t('settings:connectors.codex.add.title')}>
                <RichMessage id="settings:connectors.codex.add.body" components={[CODE, CODE]} />
              </SetupStep>
              <SetupStep n={2} title={t('settings:connectors.codex.signIn.title')}>
                <RichMessage id="settings:connectors.codex.signIn.body" components={[CODE, CODE]} />
              </SetupStep>
              <SetupStep n={3} title={t('settings:connectors.codex.limit.title')}>
                <RichMessage id="settings:connectors.codex.limit.body" components={[CODE, CODE]} />
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
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500 truncate">{t('settings:connectors.codex.terminal')}</span>
                <Button
                  id="connector-codex-add-copy"
                  type="button"
                  layout="shrink"
                  variant="outline"
                  size="xsText"
                  ink="muted"
                  className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]"
                  aria-label={t('settings:connectors.codex.copyCommandAria')}
                >
                  {t('core:common.copy')}
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
                  aria-label={t('settings:connectors.codex.copyConfigAria')}
                >
                  {t('core:common.copy')}
                </Button>
              </div>
              <pre id="connector-codex-config" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2">{CODEX_CONFIG_TOML}</pre>
            </div>
        </Disclosure>
        <Disclosure id="connector-setup-generic" title={t('settings:connectors.generic.title')} hint={t('settings:connectors.generic.hint')}>
            <ol className="space-y-2">
              <SetupStep n={1} title={t('settings:connectors.generic.transport.title')}>
                <RichMessage id="settings:connectors.generic.transport.body" components={[CODE]} />
              </SetupStep>
              <SetupStep n={2} title={t('settings:connectors.generic.oauth.title')}>
                <RichMessage id="settings:connectors.generic.oauth.body" components={[CODE, CODE, CODE]} />
              </SetupStep>
              <SetupStep n={3} title={t('settings:connectors.generic.callback.title')}>
                <RichMessage id="settings:connectors.generic.callback.body" components={[CODE, CODE, CODE, CODE, CODE]} />
              </SetupStep>
              <SetupStep n={4} title={t('settings:connectors.generic.naming.title')}>
                <RichMessage id="settings:connectors.generic.naming.body" components={[CODE, CODE, CODE, CODE]} />
              </SetupStep>
            </ol>
        </Disclosure>
        </GroupedList>
        <p className={GROUP_NOTE}>
          {t('settings:connectors.approveNote')}
        </p>
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
          {t('settings:connectors.connected')}
        </h4>
        <div id="connectors-list" className="space-y-2">
          <ConnectorsList />
        </div>
        <StatusLine id="connectors-status" size="xs" />
      </div>
    </div>
  );
}

/**
 * GitHub and X ownership proofs for the Layer-1 daily credit tier — the
 * "Linked accounts" part of the Account group. It shared the connectors'
 * pane (as "Social accounts") until the settings restructure: same
 * machinery underneath, nothing in common for the person reading it.
 * Rendered by Settings._renderGithubLink() from GET /api/me/social-identities.
 */
export function LinkedAccountsSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="linked-accounts" className="hidden">
      <div id="github-link-section">
        <SectionHeading title={t('settings:linkedAccounts.title')}>
          {t('settings:linkedAccounts.intro')}
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
          {/* The spaces around the emphasised words sit INSIDE the <strong>,
              as they always have, so the catalog entry carries them there. */}
          <RichMessage id="settings:linkedAccounts.scope" components={[STRONG]} />
        </p>
        <StatusLine id="github-link-status" size="xs" />
      </div>
    </div>
  );
}
