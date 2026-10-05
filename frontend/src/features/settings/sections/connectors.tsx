import { RichMessage } from "../../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../../lib/i18n/react";
import { t as tr } from "../../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { ChevronRightIcon } from '@/components/ui/icons';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
 * subscription. This file also renders the two parts that shared that pane
 * until the settings restructure: the GitHub/X ownership proofs for the
 * Layer-1 daily credit tier (LinkedAccountsSection, IDENTITY ONLY: immutable
 * provider id + display handle and verification timestamps, with no provider
 * token retained) and the build-venue preference (BuildVenueSection).
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
  return (
    <>
      <a
        id={id}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-[44px] w-full items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-4 text-[0.9375rem] font-semibold text-violet-700 dark:text-violet-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
      >
        <LocalizedValue render={() => (tr("settings:ask_value1_to_guide_you_b132d0a2", { value1: product }))} />
      </a>
      <p className="mt-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
        <LocalizedValue render={() => (tr("settings:opens_a_new_value1_chat_with_your_connector_deta_a2cee7e2", { value1: product }))} />
      </p>
      <h5 className="mt-5 mb-3 text-[0.8125rem] font-normal text-zinc-500 dark:text-zinc-500"><Message id="settings:or_follow_the_steps_8cef3762" /></h5>
    </>
  );
}

/** The grey label a grouped card sits under, in the sheet's 15px. */
const GROUP_LABEL = 'px-4 pb-2 text-[0.9375rem] font-normal text-zinc-500 dark:text-zinc-500';
/** The one line a grouped card may carry under it. */
const GROUP_NOTE = 'px-4 pt-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400';
/** Body copy inside an open disclosure. Shared, so the two screens match. */
const BODY = CONNECTOR_BODY;

export function ConnectorsSection() {
  return (
    <div data-settings-section="connectors" className="hidden">
      <div id="connectors-section">
        <Localized element={<SectionHeading title={catalogText("settings:connectors_c3d2e79e")}><Message id="settings:work_on_your_apps_from_a_claude_or_chatgpt_chat__33b9393e" /></SectionHeading>} messages={{"title":"settings:connectors_c3d2e79e"}} />
        {/*
            "MCP server URL", not "Connector URL" (#2370). The second was ours
            alone. The field this gets pasted into is labelled "Remote MCP
            server URL" in Claude and "MCP Server URL" in ChatGPT, and Codex's
            command is `codex mcp add` — so the label is the words the reader
            will be hunting for on the other side.
        */}
        <Label className="mb-1" htmlFor="connector-url"><Message id="settings:mcp_server_url_4f5aff03" /></Label>
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
          <Localized element={<Button
            id="connector-url-copy"
            type="button"
            layout="shrink"
            className="min-h-[44px] sm:min-h-[36px]" aria-label={catalogText("settings:copy_the_mcp_server_url_c3c7a36a")}
          ><Message id="settings:copy_e21f935f" /></Button>} messages={{"aria-label":"settings:copy_the_mcp_server_url_c3c7a36a"}} />
        </div>
        {/*
            What the address IS, for the reader who has never met "MCP". Opens
            in place, like every other disclosure on this pane, and under the
            field rather than over it — so Copy stays where it was and nothing
            needs a second one.
        */}
        <details className="group/help">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1 px-1 text-[0.9375rem] font-medium text-violet-700 dark:text-violet-400"><Message id="settings:how_it_works_9c870aa6" /><ChevronRightIcon aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open/help:rotate-90" />
          </summary>
          <div className="space-y-2 px-1 pb-2">
            <p className={BODY}><Message id="settings:this_is_homeroom_s_address_for_ai_apps_mcp_is_th_2abcc49c" /></p>
            <p className={BODY}><Message id="settings:paste_it_into_claude_chatgpt_or_another_app_that_22e7a490" /></p>
            <p className={BODY}><Message id="settings:you_need_no_password_or_key_the_app_opens_a_home_cf820b9c" /></p>
          </div>
        </details>
        <h4 className={`${GROUP_LABEL} mt-4`}><Message id="settings:choose_your_app_fc4d005d" /></h4>
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
        <Localized element={<Disclosure title={catalogText("settings:claude_ai_bb601f44")} hint="6 steps &middot; also sets up Claude Code">
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
          <h5 className="mt-5 px-3 pb-2 text-[0.8125rem] font-normal text-zinc-500 dark:text-zinc-500"><Message id="settings:if_you_use_claude_code_6c26af2f" /></h5>
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
          <Localized element={<Disclosure title={catalogText("settings:name_it_homeroom_42ff8871")} nested hint="So the ready-made rules match">
            <p className={BODY}><RichMessage id="settings:sentence_cdbc93e8132c" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">homeroom</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">Homeroom</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">usernode</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">Usernode</code>]} /></p>
          </Disclosure>} messages={{"title":"settings:name_it_homeroom_42ff8871"}} />
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
          <Localized element={<Disclosure nested id="connector-prompt-help" title={catalogText("settings:stop_the_permission_prompts_19971518")} hint="If Claude Code asks before every call">
              <p className={`${BODY} mb-3`}><RichMessage id="settings:sentence_76da5837840c" components={[<em />, <code className="font-mono text-zinc-600 dark:text-zinc-400">whoami</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">get_app</code>]} /></p>
              {/*
                  #1222 follow-up: the page used to present the blocks below with
                  no statement of whose job it is to apply them, and a reasonable
                  reader concluded Homeroom had a switch it was choosing not to
                  offer. It does not — permission rules live in the user's own
                  settings file or their own repo, and nothing this server sends
                  can put them there. Saying so is not an apology; it is what
                  turns "why is this still asking me" into a task with an owner.
              */}
              <p className={`${BODY} mb-3`}><Message id="settings:homeroom_cannot_switch_this_on_for_you_permissio_d1f0171e" /></p>

              <div id="connector-case-cc-local" className="mb-3">
                <h5 className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100 mb-1"><Message id="settings:claude_code_on_your_own_machine_2a8f58a3" /></h5>
                <p className={`${BODY} mb-2`}><RichMessage id="settings:sentence_e77ef7973c26" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">~/.claude/settings.json</code>, <strong className="font-semibold text-zinc-600 dark:text-zinc-400" />]} /></p>
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
                  <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500 truncate"><Message id="settings:claude_settings_json_048ae0e8" /></span>
                  <Localized element={<Button
                    id="connector-allow-rules-copy"
                    type="button"
                    layout="shrink"
                    variant="outline"
                    size="xsText"
                    ink="muted"
                    className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]" aria-label={catalogText("settings:copy_the_allow_rules_for_your_personal_settings__fd51b3f9")}
                  ><Message id="settings:copy_e21f935f" /></Button>} messages={{"aria-label":"settings:copy_the_allow_rules_for_your_personal_settings__fd51b3f9"}} />
                </div>
                <pre id="connector-allow-rules" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2">{PERSONAL_ALLOW_RULES}</pre>
              </div>

              <div id="connector-case-cc-web" className="mb-3">
                <h5 className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100 mb-1"><Message id="settings:claude_code_on_the_web_d6d69420" /></h5>
                <p className={`${BODY} mb-2`}><RichMessage id="settings:sentence_216d4918b72b" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">.claude/settings.json</code>]} /></p>
                {/* Same header row as the case above — see the note there. */}
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500 truncate"><Message id="settings:claude_settings_json_f27ac6f3" /></span>
                  <Localized element={<Button
                    id="connector-repo-allow-rules-copy"
                    type="button"
                    layout="shrink"
                    variant="outline"
                    size="xsText"
                    ink="muted"
                    className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]" aria-label={catalogText("settings:copy_the_allow_rules_to_commit_in_your_app_repo_afed5d7b")}
                  ><Message id="settings:copy_e21f935f" /></Button>} messages={{"aria-label":"settings:copy_the_allow_rules_to_commit_in_your_app_repo_afed5d7b"}} />
                </div>
                {/* `mb-2` was the flex row's; the trailing paragraph still needs it. */}
                <pre id="connector-repo-allow-rules" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2 mb-2">{PERSONAL_ALLOW_RULES}</pre>
                <p className={BODY}><Message id="settings:claude_code_may_still_ask_you_to_trust_the_works_8e702718" /></p>
              </div>

              <div id="connector-case-chat" className="mb-3">
                <h5 className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100 mb-1"><Message id="settings:claude_ai_chat_chatgpt_and_codex_ee498996" /></h5>
                <p className={BODY}><Message id="settings:nothing_to_do_you_approve_the_connector_once_whe_0224c499" /></p>
              </div>

              <p className={BODY}><Message id="settings:reads_only_anything_that_acts_on_your_behalf_fil_110d7bca" /></p>
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
                <Label className="mb-1" htmlFor="connector-name-spelling"><Message id="settings:connector_registered_under_a_different_name_e9f4b7d3" /></Label>
                <p className={`${BODY} mb-2`}><Message after={" "} id="settings:check_what_your_tools_are_called_in_your_session_cf71ed97" /><code className="font-mono text-zinc-600 dark:text-zinc-400">mcp__homeroom__whoami</code><Message after={" "} id="settings:if_it_is_not_9ae48f5c" /><code className="font-mono text-zinc-600 dark:text-zinc-400">homeroom</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">Homeroom</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">usernode</code><Message before={" "} after={" "} id="settings:or_7175517a" /><code className="font-mono text-zinc-600 dark:text-zinc-400">Usernode</code><Message id="settings:type_it_here_and_both_blocks_above_are_rewritten_0ef764f1" /></p>
                <Localized element={<Input
                  id="connector-name-spelling"
                  type="text"
                  spellCheck="false"
                  width="flex"
                  mono placeholder={catalogText("settings:homeroom_fc537467")}
                />} messages={{"placeholder":"settings:homeroom_fc537467"}} />
              </div>
          </Disclosure>} messages={{"title":"settings:stop_the_permission_prompts_19971518"}} />
          </div>
        </Disclosure>} messages={{"title":"settings:claude_ai_bb601f44"}} />
        <Localized element={<Disclosure title={catalogText("settings:chatgpt_50a41229")} hint="7 steps &middot; needs Developer mode">
          <GuidedSetup id="connector-open-chatgpt" href="https://chatgpt.com/" product="ChatGPT" />
            <ChatgptSetupSteps />
        </Disclosure>} messages={{"title":"settings:chatgpt_50a41229"}} />
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
        <Localized element={<Disclosure id="connector-setup-codex" title={catalogText("settings:codex_616efbe9")} hint="3 steps &middot; in the terminal">
            <ol className="space-y-2">
              <Localized element={<SetupStep n={1} title={catalogText("settings:add_the_server_29c1bdc4")}><RichMessage id="settings:sentence_8cf5dfc4330f" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">~/.codex/config.toml</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">homeroom</code>]} /></SetupStep>} messages={{"title":"settings:add_the_server_29c1bdc4"}} />
              <Localized element={<SetupStep n={2} title={catalogText("settings:sign_in_6c52846f")}><RichMessage id="settings:sentence_4c3aa9a74dc8" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">codex mcp login homeroom</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">codex mcp list</code>]} /></SetupStep>} messages={{"title":"settings:sign_in_6c52846f"}} />
              <Localized element={<SetupStep n={3} title={catalogText("settings:know_the_limit_today_49a3a62c")}><RichMessage id="settings:sentence_24154f1b4aca" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">127.0.0.1</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">invalid_redirect_uri</code>]} /></SetupStep>} messages={{"title":"settings:know_the_limit_today_49a3a62c"}} />
            </ol>
            {/*
                Below the list, not inside step 1: a <pre> is block content and
                SetupStep's text wrapper is a <span>. Same header-row Copy idiom
                as the allow-rule blocks (#1290), with the destination named in
                the row because that is what tells the two blocks apart.
            */}
            <div className="mt-3 pt-2 border-t border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500 truncate"><Message id="settings:terminal_4e686af7" /></span>
                <Localized element={<Button
                  id="connector-codex-add-copy"
                  type="button"
                  layout="shrink"
                  variant="outline"
                  size="xsText"
                  ink="muted"
                  className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]" aria-label={catalogText("settings:copy_the_codex_command_that_adds_the_homeroom_se_601d0cd4")}
                ><Message id="settings:copy_e21f935f" /></Button>} messages={{"aria-label":"settings:copy_the_codex_command_that_adds_the_homeroom_se_601d0cd4"}} />
              </div>
              <pre id="connector-codex-add" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2 mb-3">{CODEX_ADD_COMMAND}</pre>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500 truncate"><Message id="settings:codex_config_toml_d49eedb3" /></span>
                <Localized element={<Button
                  id="connector-codex-config-copy"
                  type="button"
                  layout="shrink"
                  variant="outline"
                  size="xsText"
                  ink="muted"
                  className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px]" aria-label={catalogText("settings:copy_the_codex_config_toml_entry_for_the_homeroo_69d9490c")}
                ><Message id="settings:copy_e21f935f" /></Button>} messages={{"aria-label":"settings:copy_the_codex_config_toml_entry_for_the_homeroo_69d9490c"}} />
              </div>
              <pre id="connector-codex-config" className="min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2">{CODEX_CONFIG_TOML}</pre>
            </div>
        </Disclosure>} messages={{"title":"settings:codex_616efbe9"}} />
        <Localized element={<Disclosure id="connector-setup-generic" title={catalogText("settings:another_agent_aa212b60")} hint="4 steps &middot; any MCP client">
            <ol className="space-y-2">
              <Localized element={<SetupStep n={1} title={catalogText("settings:give_it_the_connector_url_as_a_streamable_http_s_e92952d7")}><RichMessage id="settings:sentence_66c2186340e3" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">/mcp</code>]} /></SetupStep>} messages={{"title":"settings:give_it_the_connector_url_as_a_streamable_http_s_e92952d7"}} />
              <Localized element={<SetupStep n={2} title={catalogText("settings:let_it_discover_oauth_5c8bd160")}><RichMessage id="settings:sentence_0c8a1a9348db" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">/.well-known/oauth-protected-resource/mcp</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">usernode:apps:read</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">usernode:proposals:write</code>]} /></SetupStep>} messages={{"title":"settings:let_it_discover_oauth_5c8bd160"}} />
              <Localized element={<SetupStep n={3} title={catalogText("settings:check_where_its_callback_goes_f4cd31ec")}><Message after={" "} id="settings:homeroom_registers_a_client_only_if_its_oauth_ca_14795c48" /><code className="font-mono text-zinc-600 dark:text-zinc-400">claude.ai</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">claude.com</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">chatgpt.com</code><Message before={" "} after={" "} id="settings:or_7175517a" /><code className="font-mono text-zinc-600 dark:text-zinc-400">openai.com</code><Message before={" "} after={" "} id="settings:or_a_host_the_deployment_s_operator_has_added_a__11f5153a" /><code className="font-mono text-zinc-600 dark:text-zinc-400">invalid_redirect_uri</code><Message id="settings:and_that_is_a_limit_on_the_platform_side_rather__629e883f" /></SetupStep>} messages={{"title":"settings:check_where_its_callback_goes_f4cd31ec"}} />
              <Localized element={<SetupStep n={4} title={catalogText("settings:name_it_homeroom_and_read_your_tool_list_3508e77e")}><RichMessage id="settings:sentence_9f46e2b2566b" components={[<code className="font-mono text-zinc-600 dark:text-zinc-400">mcp__homeroom__whoami</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">mcp__claude_ai_homeroom__whoami</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">__</code>, <code className="font-mono text-zinc-600 dark:text-zinc-400">get_connector_guidance</code>]} /></SetupStep>} messages={{"title":"settings:name_it_homeroom_and_read_your_tool_list_3508e77e"}} />
            </ol>
        </Disclosure>} messages={{"title":"settings:another_agent_aa212b60"}} />
        </GroupedList>
        <p className={GROUP_NOTE}><Message id="settings:whichever_you_use_approve_the_connection_in_the__c45d7d44" /></p>
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
        <h4 className={`${GROUP_LABEL} mt-6`}><Message id="settings:connected_22965568" /></h4>
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
  return (
    <div data-settings-section="linked-accounts" className="hidden">
      <div id="github-link-section">
        <Localized element={<SectionHeading title={catalogText("settings:linked_accounts_feda46a4")}><Message id="settings:we_pay_for_these_credits_so_a_connected_account__7c75a067" /></SectionHeading>} messages={{"title":"settings:linked_accounts_feda46a4"}} />
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
        <p id="github-link-scope" className={GROUP_NOTE}><RichMessage id="settings:sentence_6873935fe23d" components={[<strong className="font-semibold text-zinc-600 dark:text-zinc-400" />]} /></p>
        <StatusLine id="github-link-status" size="xs" />
      </div>
    </div>
  );
}

/**
 * "Where changes get built" (#1049), the part after the connectors on the
 * Connectors & CLI page. See the note inside for its history.
 */
export function BuildVenueSection() {
  return (
    <div data-settings-section="build-venue" className="hidden">
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

          The settings restructure made it a part of its own on the
          Connectors & CLI page, straight after the connectors: the two
          hand-offs it offers are what those connectors set up, and it is
          still a preference about work you have not started yet rather than
          the thing you came to the page for.
      */}
      <div id="dev-flow-pref-section">
        <Localized element={<SectionHeading title={catalogText("settings:where_changes_get_built_1664c33e")}><Message id="settings:choose_where_homeroom_builds_your_changes_or_let_5a4dd746" /></SectionHeading>} messages={{"title":"settings:where_changes_get_built_1664c33e"}} />
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
        <Localized element={<select
          id="settings-dev-flow" aria-label={catalogText("settings:where_changes_get_built_1664c33e")}
          className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
          defaultValue=""
        >
          <option value=""><Message id="settings:ask_me_every_time_9a391560" /></option>
          <option value="platform"><Message id="settings:build_on_homeroom_20450952" /></option>
          <option value="claude-code"><Message id="settings:claude_code_claude_ai_code_591748ed" /></option>
          <option value="codex"><Message id="settings:codex_chatgpt_com_codex_b4e103a2" /></option>
        </select>} messages={{"aria-label":"settings:where_changes_get_built_1664c33e"}} />
        <div id="settings-dev-flow-status" className="text-xs mt-2 hidden"></div>
      </div>
    </div>
  );
}
