import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { RichMessage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * Create-project dialog (#create-modal).
 *
 * ── Seven questions, in the order a person answers them ───────────────
 *
 * Communities, stage 3 asked who a project is FOR before anything else,
 * because that answer decides the rest. The create-dialog rework (drawn and
 * agreed as a clickable mock first) turned each question into a step of its
 * own. How to start then moved up to straight after what you are making, so
 * that what it should do is asked of everyone, and only of a project made
 * here (an import's repo already says what it is):
 *
 *   who      Just me, A private community, or A public community: the
 *            audiences services/communities.js derives (`solo`, `invited`,
 *            `open`), in the words the Workshop tab heads its sections with.
 *   invite   a private community only: who is in it, one row per person. A
 *            @username is picked from GET /api/users/search; an email
 *            address becomes a row that says "Will invite"
 *            (services/email-invites.js sends it and turns it into a project
 *            invite when that person signs up).
 *   kind     what you are making: App, with Document and Video there, dimmed,
 *            saying Soon.
 *   start    how to begin: from scratch, from a template, or from a GitHub
 *            repo. A template's four starters open under its row (#3521;
 *            services/app-templates.js); the repo's check opens under its
 *            row. The check also reads the repo's dapp.json: the name step
 *            opens on the repo's name, a notice names each earlier answer it
 *            will replace (who it is for), and the approval step says when
 *            the repo already decides it.
 *   details  the name, and for a project made here "What should it do?",
 *            required for everyone (BRIEF_MIN). It becomes the project's
 *            first request once the project runs; for somebody the Homeroom
 *            bot builds for (#3624), the bot builds that first version.
 *   about    a project made here only: the one-line "What is it?", required,
 *            suggested from what it should do on arrival
 *            (POST /api/apps/suggest-description, or its first sentence).
 *   approve  who approves changes: members vote, or people you pick (starting
 *            with you), with "at least N yes votes" as a follow-up under the
 *            second. A private or a public community only, and last.
 *
 * NOTHING IS CHOSEN FOR THE PERSON, AND NOTHING MOVES WITHOUT THEM. Every
 * answer starts empty. Pressing a row selects it; Next, beside Cancel on
 * every step, stays dimmed until the step is answered, and moves on. The
 * last step's button is Create (or Import), dimmed the same way. A collapsed
 * step's "Change" reopens it with its answer still picked.
 *
 * `POST /api/apps` takes `audience`, `invitees`, `inviteEmails`,
 * `description`, `governance`, `template` (services/create-options.js) and
 * `brief` (services/homeroom-bot-dm.js); the rule and
 * the line are written to the new repository's dapp.json, or, for an import
 * whose dapp.json does not already set them, committed into it by the bot
 * (services/import-manifest.js), so both are votable later like any other
 * line of it.
 *
 * `data-mode` controls "new" vs "import"; `data-import-state` the import
 * sub-states (idle / checking / ok / error); `data-audience`, `data-step`,
 * `data-approvers` and `data-approvals` the rest. CSS in app.css keys off
 * all of them to show and hide sections, so this component only flips
 * attributes and never juggles per-element classes.
 *
 * Markup extracted verbatim from Shell.tsx by #1078 chunk A; #1078 chunk I
 * moved the behaviour in and made it stateful. #1910 restyled it in the
 * pane language (the recipe is spelled out above the class constants
 * below). The INITIAL render still carries every id, every `hidden` and
 * every data-* attribute the shell shipped — `public/js/**` looks those up
 * and the declared dapp.json checks select on them — and
 * tests/baselines/shell-markup.json is the proof; only the class strings
 * are new.
 *
 * ── The second view, and why it costs the baseline nothing ────────────
 *
 * `POST /api/apps` returns 201 with the row still in `'creating'`; the build
 * runs async server-side. This dialog no longer closes on that 201 — it
 * swaps its card to ./create-progress.tsx and reports the four phases
 * `services/app-creator.js` broadcasts, resolving into live /
 * awaiting-secrets / failed.
 *
 * That second view is gated on `created`, which starts null. The prerender
 * pass has no user to submit the form, so it renders the form and nothing
 * else — the progress subtree contributes no ids to public/index.html and
 * therefore nothing to the shell-markup baseline, the id inventory, or
 * dapp.json's declared selectors. A separate tenth shell dialog would have
 * needed an entry in all three; this needs none, which is the whole reason
 * the progress view lives inside this card rather than beside it.
 *
 * ── What moved, and from where ────────────────────────────────────────
 *
 * `App.showCreateModal`, `.hideCreateModal`, `._createVis`,
 * `.setCreateVisibility`, `.setCreateMode`, `._setImportState`,
 * `.handleImportCheck` and `.handleCreateApp` were public/js/app.js:3775-3985;
 * the cancel, backdrop, submit, mode-pill, visibility-pill, Check-button and
 * import-url listeners were its `bindEvents`. Seven functions that read each
 * other's state out of the document are four `useState` calls here.
 *
 * `App.showCreateModal()` survives in app.js as a one-line forward: the home
 * screen's empty-state and "+" buttons (frontend/src/features/home/home.js)
 * and the deep-link handler both call it by name.
 *
 * ── The first render is the prerendered one ──────────────────────────
 *
 * Every answer starts at a constant — nothing chosen, idle, the first step —
 * and renders that, so the first client render matches public/index.html
 * exactly (a mismatch `console.error`s, which fails proposal checks). What a
 * choice changes is written as data attributes on the card and the root,
 * which app.css reads; `.active`-style classes are not rendered from state
 * at all (a row's `aria-pressed` is, and starts false).
 *
 * The text inputs stay UNCONTROLLED (refs, not `value`) for the matching
 * reason: a controlled input renders a `value` attribute in the prerender
 * pass. What the name, the line and the invite field hold is mirrored into
 * state from their input events, for the step's Next. "What should it do?"
 * is the one controlled field: a textarea's value is its text content, and
 * an empty one prerenders as nothing.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import {
  AppWindowIcon, CheckIcon, EnvelopeIcon, InfoCircleIcon, LockIcon, NewspaperIcon, PlayIcon, PlusIcon,
  SpinnerArcIcon, UserGroupIcon, UserIcon, XIcon,
} from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { returnKeyHandler } from '../../lib/return-to-next';
import { useStoreState } from '../../lib/use-store-state';
import { AppAllowance, useAppAllowance } from './app-allowance';
import { invalidateAppAllowance } from './app-allowance-store.js';
import { CreateProgress } from './create-progress';
import {
  creationProgressStore,
  fetchCreationProgress,
  outcomeOf,
  publishAppStatus,
  stopWatchingCreation,
  watchCreation,
} from './creation-progress-store.js';
import { normalizeRepositoryUrl } from './repository-url';
import { askForPingWhileBotBuilds } from './ping-ask';
import { open as openMessages } from '../messages/store';
import { useDialog } from './use-dialog';

type Mode = 'new' | 'template' | 'import';
type ImportState = 'idle' | 'checking' | 'ok' | 'error';
/** Who it is for: services/communities.js's audiences, by their internal names. */
type Audience = 'solo' | 'invited' | 'open';
type Kind = 'app';
type Approvers = 'anyone' | 'invited';
type Approvals = 'majority' | 'atLeast';
/**
 * The steps UNFOLD in one card (#1911), rather than one page of every
 * choice. `step` is the FURTHEST step reached; everything up to it is
 * showing. Every section stays in the document on every step (the declared
 * checks select on the same ids); app.css folds and unfolds them off
 * `#create-card[data-step]`. See the header for what each one asks.
 */
type Step = 'who' | 'invite' | 'kind' | 'start' | 'details' | 'about' | 'approve';

/**
 * The starters "Start from a template" offers (#3521), in the order and the
 * words the screen uses. The ids are services/app-templates.js's
 * TEMPLATE_IDS less `empty`, which is "Start from scratch";
 * tests/app-templates.test.js keeps the two lists equal.
 */
export type TemplateId = 'social-productivity' | 'multimedia-social' | 'game-2d' | 'game-3d';
export const TEMPLATES: ReadonlyArray<{ key: TemplateId; title: string; caption: string }> = [
  { key: 'social-productivity', get title() { return tr("core:social_productivity_de230580"); }, get caption() { return tr("core:shared_lists_that_members_add_tasks_to_claim_and_a1618982"); } },
  { key: 'multimedia-social', get title() { return tr("core:multimedia_social_ac0656da"); }, get caption() { return tr("core:a_feed_of_posts_with_photos_likes_and_a_way_to_r_a0fe3f6b"); } },
  { key: 'game-2d', get title() { return tr("core:2d_game_9ab71e11"); }, get caption() { return tr("core:a_canvas_game_played_with_keys_or_touch_with_a_l_8f50a2f4"); } },
  { key: 'game-3d', get title() { return tr("core:3d_game_0bce0b86"); }, get caption() { return tr("core:a_3d_scene_drawn_with_webgl_with_controls_and_a__43b5d17c"); } },
];

/** One person a private community is created with: an account, or an address. */
export type Invitee =
  | { kind: 'user'; username: string; friend?: boolean }
  | { kind: 'email'; email: string };

/** The most people a private community is created with (services/create-options.js). */
export const MAX_INVITEES = 20;

/** An address worth offering as a "Will invite" row. The server checks again. */
export const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * The steps a given set of answers walks. A private community names its
 * people; how to begin comes straight after what you are making; a project
 * made here (not an import) is described in one line on a step of its own;
 * and a private or a public community says who approves changes, last. An
 * unanswered audience counts as Just me and an unanswered start as made
 * here, so the indicator reads "Step 1 of 5" before anything is chosen.
 * Exported and pure: the indicator's "of N" and the footer's Next-or-Create
 * both read it.
 */
export function stepsFor(audience: Audience | null, mode: Mode | null = null): readonly Step[] {
  const who = audience ?? 'solo';
  return [
    'who',
    ...(who === 'invited' ? (['invite'] as const) : []),
    'kind',
    'start',
    'details',
    ...(mode !== 'import' ? (['about'] as const) : []),
    ...(who !== 'solo' ? (['approve'] as const) : []),
  ];
}

/** What a repo's dapp.json already says, as the import check reads it. */
export interface RepoManifest {
  name?: string | null;
  description?: string | null;
  visibility?: { build: 'public' | 'private' | null; view: 'public' | 'private' | null } | null;
  governance?: { approvers: Approvers; approvals: number | null } | null;
}

/** One earlier answer an import will replace, for the notice. */
export interface RepoOverride {
  key: 'name' | 'desc' | 'vis' | 'gov';
  label: string;
  repo: string;
  yours: string;
}

const WHO_WORDS: Record<Audience, string> = { get solo() { return tr("core:just_me_3a4b4df8"); }, get invited() { return tr("core:a_private_community_afc054d3"); }, get open() { return tr("core:a_public_community_9817c9cb"); } };

function ruleWords(approvers: Approvers, approvals: number | null): string {
  if (approvers === 'anyone') return tr("core:members_vote_1af60d02");
  return approvals ? tr("core:people_i_pick_at_least_value1_yes_fbdab3e0", { value1: approvals }) : tr("core:people_i_pick_a_majority_of_them_7a23074b");
}

/**
 * Every repository is public on GitHub, whoever may open the project, so a
 * line that keeps people out also says the code stays public.
 */
const CODE_PUBLIC = () => tr("workshop:code_stays_public_on_github_95b48766");

function visibilityWords(v: NonNullable<RepoManifest['visibility']>): string {
  if (v.build === 'public' && v.view === 'public') return tr("core:anyone_can_find_it_join_and_build_b60d71a1");
  if (v.build === 'private' && v.view === 'public') return tr("core:anyone_can_see_it_only_people_invited_can_build__968769db", { value1: CODE_PUBLIC() });
  if (v.build === 'public') return tr("core:anyone_can_build_it_db3c6b97");
  return tr("core:private_to_the_people_invited_value1_babd0c40", { value1: CODE_PUBLIC() });
}

/**
 * The answers a repo's dapp.json will replace on the first deploy (the
 * name, visibility and governance reconciles in services/app-manifest.js,
 * and the description every surface reads). Only real differences, and only
 * answers actually given: the check comes before the name step now, which
 * opens on the repo's own name, and before the approval step, so a blank
 * name, a blank line or an approval rule not chosen yet is nothing to
 * replace. A repo that keeps a project private does not clash with "A
 * private community". Exported and pure for tests/create-app-steps.test.js.
 */
export function repoOverrides(manifest: RepoManifest | null, answers: {
  name: string;
  description: string;
  audience: Audience | null;
  approvers: Approvers | null;
  approvals: Approvals | null;
  approvalsN?: number;
}): RepoOverride[] {
  if (!manifest) return [];
  const out: RepoOverride[] = [];
  const name = answers.name.trim();
  if (manifest.name && name && manifest.name !== name) {
    out.push({ key: 'name', get label() { return tr("core:name_dcd1d522"); }, repo: manifest.name, yours: name });
  }
  const description = answers.description.replace(/\s+/g, ' ').trim();
  if (manifest.description && description && manifest.description !== description) {
    out.push({ key: 'desc', get label() { return tr("core:what_it_is_1f36becc"); }, repo: manifest.description, yours: description });
  }
  // An audience is a pair of visibilities (communities.visibilityForAudience):
  // a public community is public to see and to build, Just me and a private
  // community private.
  // A repo that sets either axis the other way changes who it is for.
  const v = manifest.visibility;
  if (v && answers.audience) {
    const expected = answers.audience === 'open' ? 'public' : 'private';
    const clash = (v.build != null && v.build !== expected) || (v.view != null && v.view !== expected);
    if (clash) out.push({ key: 'vis', get label() { return tr("core:who_it_s_for_71ef524a"); }, repo: visibilityWords(v), yours: WHO_WORDS[answers.audience] });
  }
  const g = manifest.governance;
  if (g && answers.audience && answers.audience !== 'solo' && answers.approvers) {
    const n = Math.round(Number(answers.approvalsN));
    const mine = ruleWords(
      answers.approvers,
      answers.approvers === 'invited' && answers.approvals === 'atLeast' && n >= 1 ? n : null,
    );
    const theirs = ruleWords(g.approvers, g.approvals);
    if (mine !== theirs) out.push({ key: 'gov', get label() { return tr("core:who_approves_changes_e1eac72b"); }, repo: theirs, yours: mine });
  }
  return out;
}

/**
 * The approval rule an import's repo already sets, in the approval step's
 * words, or null when it sets none (or there is nobody else to approve
 * anything). The step then says so instead of asking. Exported and pure.
 */
export function repoRule(manifest: RepoManifest | null, audience: Audience | null): string | null {
  const g = manifest?.governance;
  if (!g || !audience || audience === 'solo') return null;
  return ruleWords(g.approvers, g.approvals);
}

/**
 * A line's first sentence, cut at a word to fit `max`: what the short
 * description falls back to when no suggestion comes back. The same rule as
 * services/homeroom-bot-dm.js's firstSentence, which the server falls back
 * to when its helper model is unavailable.
 */
export function firstSentence(text: string, max = DESCRIPTION_MAX): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = (flat.match(/^.+?[.!?](?=\s|$)/) || [flat])[0].replace(/[.!?]+$/, '');
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, '')}…`;
}

/**
 * The `POST /api/apps` body for a set of answers. Exported and pure so the
 * wire shape is pinned without a browser (tests/create-app-steps.test.js).
 * An import sends the description and the rule only where its repo's
 * dapp.json does not already set them: those the bot commits into it.
 */
export function createBody(answers: {
  name: string;
  /**
   * "What is it?": one line. The dialog asks it of a project made here and
   * not of an import; the API keeps it optional.
   */
  description?: string;
  mode: Mode;
  repoUrl?: string;
  audience: Audience;
  invitees?: readonly Invitee[];
  approvers: Approvers | null;
  approvals: Approvals | null;
  approvalsN?: number;
  /** An import's dapp.json, as the check read it. */
  repo?: RepoManifest | null;
  /** The starter picked under "Start from a template". */
  template?: TemplateId | null;
  /**
   * "What should it do?": filed as the project's first request once it runs,
   * and built by the Homeroom bot for somebody it builds for (#3624). Never
   * sent with an import.
   */
  brief?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { name: answers.name, audience: answers.audience };
  const importing = answers.mode === 'import';
  if (importing && answers.repoUrl) body.repoUrl = answers.repoUrl;
  // From scratch sends nothing: the server's default is the empty starter.
  if (answers.mode === 'template' && answers.template) body.template = answers.template;
  const brief = (answers.brief || '').trim();
  if (!importing && brief.length >= BRIEF_MIN) body.brief = brief.slice(0, BRIEF_MAX);
  const description = (answers.description || '').replace(/\s+/g, ' ').trim();
  if (description && !(importing && answers.repo?.description)) body.description = description;
  if (answers.audience === 'invited') {
    const people = answers.invitees || [];
    const usernames = people.flatMap((p) => (p.kind === 'user' ? [p.username] : []));
    const emails = people.flatMap((p) => (p.kind === 'email' ? [p.email] : []));
    if (usernames.length) body.invitees = usernames;
    if (emails.length) body.inviteEmails = emails;
  }
  if (answers.audience !== 'solo' && answers.approvers === 'invited' && !(importing && answers.repo?.governance)) {
    const n = Math.round(Number(answers.approvalsN));
    body.governance = {
      approvers: 'invited',
      approvals: answers.approvals === 'atLeast' && n >= 1 && n <= 50 ? { atLeast: n } : 'default',
    };
  }
  return body;
}

/**
 * POST /api/apps and say what came back. Three failures read differently: a
 * fetch that throws never reached Homeroom (a network error); a JSON reply
 * carries the server's own `error`; and a reply that is not JSON at all is an
 * error page from in front of the server (a deploy, a proxy), so it names
 * the status rather than blaming the network. Never throws.
 */
export async function postCreateApp(
  body: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch('/api/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, get error() { return tr("core:network_error_try_again_052b478f"); } };
  }
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    /* not JSON: reported through the status below */
  }
  if (res.ok) return { ok: true, data: data || {} };
  if (data && typeof data.error === 'string' && data.error) return { ok: false, error: data.error };
  return { ok: false, get error() { return tr("core:homeroom_couldn_t_create_the_project_value1_try__5c63f4a2", { value1: res.status }); } };
}

/** The inline row under the repo URL: spinner, green tick, or red error. */
interface ImportStatus {
  tone: 'none' | 'ok' | 'err';
  text: string;
  spinner?: boolean;
}

const IDLE_STATUS: ImportStatus = { tone: 'none', text: '' };

/** The answers a `?shot=` link opens on. */
interface ShotState {
  step: Step;
  audience: Audience | null;
  kind: Kind | null;
  mode: Mode | null;
  approvers: Approvers | null;
  name: string;
  brief: string;
  description: string;
}

/**
 * The state a `?shot=` link opens on, so a URL can reach each step for the
 * declared checks and for screenshots. Display only, read once on open, and
 * never on the prerender pass (no `location` there).
 *
 *   create-group    A private community chosen, on the invite step
 *   create-start    A public community, on how to start, nothing picked yet
 *   create-template how to start, from a template, none picked yet
 *   create-import   how to start, importing
 *   create-details  Just me, an app from scratch, on the name step
 *   create-about    Just me, from scratch, described, on the one-line step
 *   create-approve  A public community, described, on the approval step
 *
 * `create-access`, an older link, lands on `create-approve`.
 */
function shotState(): ShotState {
  const open: ShotState = {
    step: 'who', audience: null, kind: null, mode: null, approvers: null, name: '', brief: '', description: '',
  };
  try {
    const shot = new URLSearchParams(location.search).get('shot');
    const app = { ...open, kind: 'app' as Kind };
    const described = {
      ...app,
      mode: 'new' as Mode,
      get name() { return tr("core:seed_swap_42a9d04f"); },
      get brief() { return tr("core:neighbours_list_the_seeds_they_have_spare_and_as_bd4eaf65"); },
      get description() { return tr("core:swap_spare_seeds_with_your_neighbours_8ffbde85"); },
    };
    if (shot === 'create-group') return { ...open, step: 'invite', audience: 'invited' };
    if (shot === 'create-start') return { ...app, step: 'start', audience: 'open' };
    if (shot === 'create-template') return { ...app, step: 'start', audience: 'solo', mode: 'template' };
    if (shot === 'create-import') return { ...app, step: 'start', audience: 'solo', mode: 'import' };
    if (shot === 'create-details') return { ...open, step: 'details', audience: 'solo', kind: 'app', mode: 'new' };
    if (shot === 'create-about') return { ...described, step: 'about', audience: 'solo' };
    if (shot === 'create-approve' || shot === 'create-access') return { ...described, step: 'approve', audience: 'open' };
    return open;
  } catch {
    return open;
  }
}

/**
 * How often the progress view re-asks the server while a creation is
 * still pending. The WS broadcasts do the real work; this only has to be
 * often enough that a dropped socket is noticed, and rare enough that a
 * dialog left open costs the API almost nothing.
 */
const POLL_INTERVAL_MS = 4000;

function statusClass(status: ImportStatus): string {
  if (status.tone === 'ok') return 'px-1 text-sm mt-2 import-status--ok';
  if (status.tone === 'err') return 'px-1 text-sm mt-2 import-status--err';
  return 'px-1 text-sm mt-2';
}

/*
 * ── The pane recipe (#1910) ───────────────────────────────────────────
 *
 * The dialog is drawn in the widget language the shell's panes wear: a grey
 * pane ground, white cards floating on it with no border, and one
 * high-contrast state for "selected" — the accent, the fill the dialog's own
 * Create button wears (#2566). The selection colours live in app.css, keyed
 * off the card's data attributes.
 *
 *   PANE     the card's own ground (`--dc-strip`); inside the kit's modal
 *            shell the same ground comes from the shell instead.
 *   CARD/ROW the auth screens' field card: rounded-2xl, white, one row.
 *   FIELD    the borderless input that sits in such a row.
 *   RAIL/SEGMENT  a segmented control: a raised white track and
 *            full-width segments.
 *   PILL_SECONDARY  the white pill for a secondary action; the primary is
 *            <Button variant="pillAccent">.
 */
const PANE = 'bg-[color:var(--dc-strip)] dark:bg-[color:var(--dc-strip)] rounded-3xl';
const CARD = 'rounded-2xl bg-white dark:bg-zinc-800 overflow-hidden';
const ROW = 'px-4 pt-3 pb-2';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const CAPTION = 'px-1 text-xs text-zinc-500 dark:text-zinc-400';
const FIELD = { box: 'card', hint: 'dim', ring: 'bare' } as const;
const RAIL = 'flex items-center gap-0.5 rounded-full bg-white dark:bg-zinc-800 p-0.5 text-sm font-semibold';
const SEGMENT = 'flex-1 min-h-8 rounded-full px-3 py-1 leading-tight transition-colors';
const PILL_SECONDARY = 'flex-1 h-11 rounded-full bg-white text-[15px] font-semibold text-zinc-900 shadow-sm '
  + 'hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 transition-colors';
/*
 * A choice row: one white card each, full width, a title and a one-line
 * caption, and on a question's rows a selection marker at the trailing edge
 * (ChoiceMarker below). The selection colours stay in app.css, keyed off the
 * card's data attribute for that question.
 */
const CHOICE_BASE = 'w-full text-left ' + CARD + ' px-4 py-3 flex items-center gap-3 transition-colors';
const CHOICE = 'create-mode-pill ' + CHOICE_BASE;
const WHO_CHOICE = 'create-who-pill ' + CHOICE_BASE;
const APPROVER_CHOICE = 'create-approver-pill ' + CHOICE_BASE;
const CHOICE_TITLE = 'block text-[15px] font-semibold';
const CHOICE_CAPTION = 'create-choice-caption block text-xs mt-0.5';
// Shown in place of the marker once the step has collapsed to the chosen
// row: pressing the row then reopens the choice.
const CHOICE_CHANGE = 'create-choice-change text-xs font-medium shrink-0';
/*
 * The selection marker (#24, D8). Pressing a row selects it and Next moves
 * on, so the row is a choice, and a chevron at its edge promised a jump that
 * never came. A ring in its place, like a radio's; the chosen row's ring
 * fills (app.css, off the row's aria-pressed) and carries the shell's check.
 */
const CHOICE_MARKER = 'create-choice-marker flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-[1.5px] ring-inset ring-current opacity-60';

function ChoiceMarker({ chosen }: { chosen: boolean }) {
  return (
    <span className={CHOICE_MARKER} aria-hidden="true">
      {chosen ? <CheckIcon className="h-3.5 w-3.5" strokeWidth="3" /> : null}
    </span>
  );
}
/* The small numbered heading each unfolded step opens with. */
const STEP_HEADING = 'text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 mb-2';
/* A row that is there but cannot be pressed yet: dimmed, saying Soon. */
const SOON = 'create-soon-row w-full text-left ' + CARD + ' px-4 py-3 flex items-center gap-3 text-zinc-500 dark:text-zinc-400';
const SOON_TAG = 'shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400';
/* A starter under "Start from a template": a choice row, smaller, inset. */
const TEMPLATE_CHOICE = 'create-template-pill w-full text-left ' + CARD + ' px-4 py-2.5 flex items-center gap-3 transition-colors';

/*
 * "What is it?" (#3572). DESCRIPTION_MAX is the server's limit
 * (services/create-options.js, which says why it is 90: two lines of the
 * project's hub hero on a phone), mirrored here for the field's maxLength;
 * tests/create-description-limit.test.js keeps the two equal. The field counts
 * down only for its last DESCRIPTION_COUNT_FROM characters. A count from the
 * first keystroke would have the person writing to a number rather than
 * saying what the project is; near the end it tells them how much is left
 * before the field stops taking letters.
 */
export const DESCRIPTION_MAX = 90;
/*
 * "What should it do?", asked of everyone making a project here: it becomes
 * the project's first request, which the Homeroom bot builds for somebody it
 * builds for (#3624; services/homeroom-bot-dm.js, whose MIN_BRIEF_CHARS and
 * MAX_BRIEF_CHARS these mirror). The field grows with its text up to
 * max-h-60 (15rem) and scrolls after that; a fixed four rows on a phone
 * scrolled its first line half under the label.
 */
export const BRIEF_MIN = 10;
export const BRIEF_MAX = 4000;
const BRIEF_FIELD = 'resize-none overflow-y-auto max-h-60 leading-[22px]';
/** The one caption under "What should it do?": who builds from it. */
export function briefCaption(botBuild: boolean): string {
  return botBuild ? tr("core:homeroom_bot_builds_the_first_version_from_this_e9bd77f4") : tr("core:this_becomes_the_project_s_first_request_2db8af57");
}
const DESCRIPTION_COUNT_FROM = 20;
const DESCRIPTION_LEFT = 'absolute right-4 top-3 text-[13px] tabular-nums';

/** "12 characters left" once the line is near the limit, '' before then. */
export function descriptionLeft(length: number): string {
  const left = Math.max(0, DESCRIPTION_MAX - length);
  if (left > DESCRIPTION_COUNT_FROM) return '';
  return tr("core:count_characters_left_e744cd3b", { count: left });
}

/** The three audiences, in the order and the words the screen uses. */
const WHO: ReadonlyArray<{ key: Audience; title: string; caption: string }> = [
  { key: 'solo', get title() { return tr("core:just_me_3a4b4df8"); }, get caption() { return tr("core:only_you_can_open_it_its_code_is_public_on_githu_38c54066"); } },
  { key: 'invited', get title() { return tr("core:a_private_community_afc054d3"); }, get caption() { return tr("core:only_you_and_the_people_you_invite_can_open_it_i_f475d200"); } },
  { key: 'open', get title() { return tr("core:a_public_community_9817c9cb"); }, get caption() { return tr("core:anyone_can_find_it_join_and_build_965fb20c"); } },
];

function WhoGlyph({ audience }: { audience: Audience }) {
  const cls = 'w-5 h-5 shrink-0 opacity-80';
  if (audience === 'solo') return <UserIcon className={cls} aria-hidden="true" />;
  if (audience === 'invited') return <LockIcon className={cls} aria-hidden="true" />;
  return <UserGroupIcon className={cls} aria-hidden="true" />;
}

/* ── The invite step's rows ────────────────────────────────────────────── */

interface Suggestion { username: string; friend?: boolean }

/** Up to five handles for what is typed, friends first (the Messages scope). */
async function searchUsers(q: string): Promise<Suggestion[]> {
  const res = await fetch(`/api/users/search?scope=messages&q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
  if (!res.ok) return [];
  const data = (await res.json()) as { users?: Suggestion[] };
  return (data.users || []).slice(0, 5);
}

const P_ROW = 'flex items-center gap-3 min-h-[52px] py-2.5 pl-4 pr-3';
const AVATAR = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-sm font-[650] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200';
const P_TITLE = 'block truncate text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100';
const P_SUB = 'block text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400';
const REMOVE = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-700';

/**
 * #create-invite-block: one row per person, a typing row, and "Add another
 * person". The typing field (#create-invitees) stays uncontrolled, like the
 * dialog's other text fields; what is typed is mirrored into state for the
 * suggestions. Nothing outside React writes into this block.
 */
function InviteRows({ people, setPeople, inputRef }: {
  people: Invitee[];
  setPeople: (next: Invitee[]) => void;
  inputRef: { current: HTMLInputElement | null };
}) {
  useUiLanguage();
  const [typing, setTyping] = useState(true);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searched, setSearched] = useState('');
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const open = typing || people.length === 0;
  const full = people.length >= MAX_INVITEES;

  // Suggestions follow what is typed, a beat behind, and a late answer to an
  // older query never replaces a newer one.
  useEffect(() => {
    const q = text.trim().replace(/^@/, '');
    if (!q || (text.includes('@') && !text.trim().startsWith('@'))) {
      setSuggestions([]); setSearched(q); return undefined;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      searchUsers(q).then((found) => {
        if (mine !== seq.current) return;
        const taken = new Set(people.flatMap((p) => (p.kind === 'user' ? [p.username.toLowerCase()] : [])));
        setSuggestions(found.filter((u) => !taken.has(u.username.toLowerCase())));
        setSearched(q);
        setActive(0);
      }).catch(() => { if (mine === seq.current) { setSuggestions([]); setSearched(q); } });
    }, 150);
    return () => clearTimeout(timer);
  }, [text, people]);

  function clearTyping(close: boolean) {
    if (inputRef.current) inputRef.current.value = '';
    setText(''); setError(''); setSuggestions([]); setActive(0);
    if (close) setTyping(false);
  }

  function add(person: Invitee) {
    setPeople([...people, person]);
    clearTyping(true);
  }

  function commit() {
    const typed = text.trim();
    if (!typed) return;
    if (EMAIL_RE.test(typed)) {
      if (people.some((p) => p.kind === 'email' && p.email.toLowerCase() === typed.toLowerCase())) {
        setError(tr("core:that_email_is_already_on_the_list_5d8caecd"));
        return;
      }
      add({ kind: 'email', email: typed });
      return;
    }
    const name = typed.replace(/^@/, '');
    if (suggestions.length) {
      const pick = suggestions[Math.min(active, suggestions.length - 1)];
      add({ kind: 'user', username: pick.username, friend: pick.friend });
      return;
    }
    if (searched !== name) return; // still looking; Enter again once the list arrives
    if (people.some((p) => p.kind === 'user' && p.username.toLowerCase() === name.toLowerCase())) {
      setError(tr("core:value1_is_already_on_the_list_ea586395", { value1: name }));
      return;
    }
    setError(typed.includes('@') && !typed.startsWith('@')
      ? tr("core:that_doesn_t_look_like_an_email_address_ee587fc4")
      : tr("core:no_one_on_homeroom_is_called_value1_check_the_sp_0a4f2b02", { value1: name }));
  }

  return (
    <div id="create-invite-block" className={CARD + ' create-invite-list'}>
      {people.map((p, i) => (
        <div key={p.kind === 'user' ? `u:${p.username}` : `e:${p.email}`} className={P_ROW + ' create-invitee-row'} data-invitee={p.kind}>
          {p.kind === 'user' ? (
            <>
              <span className={AVATAR} aria-hidden="true">{p.username.charAt(0).toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className={P_TITLE}>{'@' + p.username}</span>
                {p.friend ? <span className={P_SUB}><Message id="core:friend_acd8f664" /></span> : null}
              </span>
            </>
          ) : (
            <>
              <span className={AVATAR} aria-hidden="true"><EnvelopeIcon className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1">
                {/* A break offered after the @, so a long address wraps
                    between its two halves rather than mid-word. */}
                <span className={P_TITLE + ' create-invitee-email'}>
                  {p.email.slice(0, p.email.indexOf('@') + 1)}<wbr />{p.email.slice(p.email.indexOf('@') + 1)}
                </span>
              </span>
              <span className="create-will-invite shrink-0 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"><Message id="core:will_invite_a11e66b0" /></span>
            </>
          )}
          <LocalizedDynamic element={<button
            type="button"
            className={REMOVE}
            aria-label={tr("core:remove_value1_d2f6b9b7", { value1: p.kind === 'user' ? '@' + p.username : p.email })}
            onClick={() => {
              const next = people.filter((_, j) => j !== i);
              setPeople(next);
              if (!next.length) setTyping(true);
            }}
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>} resolve={() => ({ get "aria-label"() { return tr("core:remove_value1_d2f6b9b7", { value1: p.kind === 'user' ? '@' + p.username : p.email }); } })} />
        </div>
      ))}
      {open ? (
        <div className="create-invitee-typing">
          <div className="px-4 py-2">
            <Localized element={<Input
              id="create-invitees"
              ref={inputRef}
              name="invitees"
              type="text"
              autoComplete="off"
              spellCheck="false"
              {...FIELD} placeholder={catalogText("core:username_or_email_afdb4cac")} aria-label={catalogText("core:add_a_person_by_username_or_email_70d5c35c")}
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-controls="create-invitee-suggestions"
              onInput={(e) => { setText(e.currentTarget.value); setError(''); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); setActive((active + 1) % suggestions.length); }
                else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); setActive((active - 1 + suggestions.length) % suggestions.length); }
                else if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); e.stopPropagation(); commit(); }
                else if (e.key === 'Escape' && people.length) { e.preventDefault(); clearTyping(true); }
              }}
              onBlur={() => {
                // Leaving the field keeps a whole address as a row; an empty
                // field folds back to "Add another person".
                const typed = (inputRef.current?.value || '').trim();
                if (EMAIL_RE.test(typed)) commit();
                else if (!typed && people.length) setTyping(false);
              }}
            />} messages={{"placeholder":"core:username_or_email_afdb4cac","aria-label":"core:add_a_person_by_username_or_email_70d5c35c"}} />
          </div>
          {error ? <p className="px-4 pb-2.5 -mt-0.5 text-[13px] leading-[18px] text-red-700 dark:text-red-400" role="alert">{error}</p> : null}
          {suggestions.length ? (
            <div id="create-invitee-suggestions" role="listbox">
              {suggestions.map((u, i) => (
                <button
                  key={u.username}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-zinc-100 aria-selected:bg-zinc-100 dark:hover:bg-zinc-700 dark:aria-selected:bg-zinc-700"
                  // Taken on mousedown, before the field's blur can fold it away.
                  onMouseDown={(e) => { e.preventDefault(); add({ kind: 'user', username: u.username, friend: u.friend }); }}
                >
                  <span className={AVATAR.replace('h-8 w-8', 'h-7 w-7')} aria-hidden="true">{u.username.charAt(0).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className={P_TITLE.replace('font-[650]', 'font-semibold')}>{'@' + u.username}</span>
                    {u.friend ? <span className={P_SUB}><Message id="core:friend_acd8f664" /></span> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          className="create-invitee-add flex w-full min-h-[52px] items-center gap-3 px-4 py-2.5 text-left text-[15px] font-semibold text-violet-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-violet-400"
          disabled={full}
          onClick={() => { setTyping(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-[1.5px] ring-inset ring-current" aria-hidden="true">
            <PlusIcon className="h-4 w-4" />
          </span>
          <LocalizedValue render={() => (full ? tr("core:value1_is_the_most_for_now_e3a3d2e6", { value1: MAX_INVITEES }) : tr("core:add_another_person_13080fc3"))} />
        </button>
      )}
    </div>
  );
}

/* ── The repo notice, under an import's check ──────────────────────────── */

function RepoNotice({ overrides, unread }: { overrides: RepoOverride[]; unread: boolean }) {
  if (unread) {
    return (
      <p id="create-repo-notice" className={CAPTION} data-overrides="unread"><Message id="core:couldn_t_read_this_repo_s_dapp_json_anything_it__eddf958e" /></p>
    );
  }
  if (!overrides.length) {
    return (
      <p id="create-repo-notice" className={CAPTION} data-overrides="0"><Message id="core:nothing_in_this_repo_s_dapp_json_changes_your_an_1dc1644b" /></p>
    );
  }
  return (
    <div id="create-repo-notice" className={CARD + ' px-4 pt-3 pb-3.5 ring-[1.5px] ring-inset ring-violet-600'} data-overrides={String(overrides.length)} role="status">
      <div className="flex items-center gap-2 text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">
        <InfoCircleIcon className="h-[18px] w-[18px] shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
        <span><Message id="core:this_repo_already_sets_some_of_this_1a99631a" /></span>
      </div>
      <p className="mt-1.5 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
        <LocalizedValue render={() => (tr("core:its_dapp_json_decides_value1_so_importing_uses_t_933a7426", { value1: overrides.length === 1 ? tr("core:message_5be1b402d626") : tr("core:message_89673524d2ee", { count: overrides.length }) }))} />
      </p>
      <ul className="mt-2.5 flex flex-col gap-2.5">
        {overrides.map((o) => (
          <li key={o.key} className="flex flex-col gap-px" data-override={o.key}>
            <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{o.label}</span>
            <span className="text-[15px] leading-5 text-zinc-900 dark:text-zinc-100">{o.repo}</span>
            <span className="text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400"><LocalizedValue render={() => (tr("core:you_chose_value1_1aaffd87", { value1: o.yours }))} /></span>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-xs text-zinc-500 dark:text-zinc-400"><Message id="core:your_other_answers_are_written_into_the_repo_any_6b9b67c0" /></p>
    </div>
  );
}

export function CreateAppDialog() {
  useUiLanguage();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const describeRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const inviteesRef = useRef<HTMLInputElement>(null);
  const approvalsNRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // Every answer starts empty: nothing in this dialog is chosen for the
  // person (request #3160 and the rework after it).
  const [audience, setAudience] = useState<Audience | null>(null);
  const [people, setPeople] = useState<Invitee[]>([]);
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState('');
  const [describe, setDescribe] = useState('');
  const describeLeftText = descriptionLeft(describe.length);
  // #3624: whether the Homeroom bot builds this person's projects from what
  // they say it should do (an admin's list; GET /api/auth/me says). Only the
  // caption under that field reads it; the progress card's button follows
  // the server's answer (`botChat`). False on the prerender and until the
  // dialog opens, so the first render is the shell's.
  const [botBuild, setBotBuild] = useState(false);
  // "What should it do?", required of a project made here.
  const [brief, setBrief] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState('');
  // The short description is suggested from `brief` on arriving at its
  // step, and again only when `brief` changed since the last suggestion and
  // the person has not written the line themselves. A late answer to an
  // older suggestion (or one that lands after a close) is dropped by `seq`.
  const suggestion = useRef({ from: '', edited: false, seq: 0 });
  // The bot's DM, once a project it builds has been created.
  const [botChat, setBotChat] = useState<number | null>(null);
  const [approvers, setApprovers] = useState<Approvers | null>(null);
  const [approvals, setApprovals] = useState<Approvals | null>(null);
  const [approvalsN, setApprovalsN] = useState(1);
  const [mode, setMode] = useState<Mode | null>(null);
  const [template, setTemplate] = useState<TemplateId | null>(null);
  const [step, setStep] = useState<Step>('who');
  const [importState, setImportState] = useState<ImportState>('idle');
  const [repo, setRepo] = useState<RepoManifest | null>(null);
  const [repoUnread, setRepoUnread] = useState(false);
  const [status, setStatus] = useState<ImportStatus>(IDLE_STATUS);
  const [error, setError] = useState('');
  // QA 2026-09-24 Q5: a double-click on Create sent two POSTs and made two
  // apps, each taking a slot. `submitting` drives the button's disabled and
  // busy look; the ref is the handler's own guard, because a second click can
  // be dispatched before React has re-rendered the button as disabled (and
  // Enter in the name field never goes through the button at all).
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const { blocked: quotaBlocksCreation } = useAppAllowance();
  // The app this dialog is now reporting on. Null until a POST succeeds,
  // which is what keeps the FIRST render byte-identical to the
  // prerendered shell — the progress subtree exists only after a user
  // action, so it never reaches public/index.html.
  const [created, setCreated] = useState<{ slug: string; name: string } | null>(null);
  const progress = useStoreState(creationProgressStore);

  const steps = stepsFor(audience, mode);
  const last = steps[steps.length - 1];
  const isLast = step === last;
  const importing = mode === 'import';
  const checked = importing && importState === 'ok';
  // An import whose repo already sets who approves: the approval step says
  // so instead of asking.
  const repoGov = checked ? repoRule(repo, audience) : null;

  /** Whether a step has its answer, which is what turns its button on. */
  function answered(which: Step): boolean {
    switch (which) {
      case 'who': return audience != null;
      case 'invite': return people.length > 0;
      case 'kind': return kind != null;
      case 'start': return mode != null && (mode !== 'import' || importState === 'ok') && (mode !== 'template' || template != null);
      case 'details': return name.trim().length > 0 && (importing || brief.trim().length >= BRIEF_MIN);
      case 'about': return describe.trim().length > 0;
      case 'approve': return repoGov != null || (approvers != null && (approvers !== 'invited' || approvals != null));
      default: return false;
    }
  }
  const stepAnswered = answered(step);
  const overrides = checked
    ? repoOverrides(repo, { name, description: '', audience, approvers, approvals, approvalsN })
    : [];
  // What the repo decides, for app.css to dim and tag: each answer it
  // replaces, and the approval rule it sets whether or not one was chosen.
  const repoSets = [...overrides.map((o) => o.key), ...(repoGov && !overrides.some((o) => o.key === 'gov') ? ['gov'] : [])];

  // "What should it do?" grows with its text. Measured only while its step
  // is showing: a folded field measures 0, and pinning that would collapse
  // it. Written imperatively, after mount, so the prerendered markup carries
  // no `style`.
  useIsomorphicLayoutEffect(() => {
    const el = briefRef.current;
    if (!el || step !== 'details') return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [brief, step]);

  const dialog = useDialog('create', {
    onOpen: () => {
      // A real open starts on the first step with nothing chosen; the shot
      // links land on the state they name. Focus follows: nothing on a
      // question step wants the keyboard, the name step's field does.
      const initial = shotState();
      setAudience(initial.audience);
      setKind(initial.kind);
      applyMode(initial.mode);
      setApprovers(initial.approvers);
      setStep(initial.step);
      if (nameRef.current) nameRef.current.value = initial.name;
      setName(initial.name);
      setBotBuild(!!(window.App?.user as { homeroomBotDm?: boolean } | undefined)?.homeroomBotDm);
      setBrief(initial.brief);
      if (describeRef.current) describeRef.current.value = initial.description;
      setDescribe(initial.description);
      suggestion.current = { from: initial.brief.trim(), edited: false, seq: suggestion.current.seq + 1 };
      setSuggesting(false);
      setSuggestNote('');
      setBotChat(null);
      void invalidateAppAllowance();
      if (initial.step === 'details') setTimeout(() => nameRef.current?.focus(), 0);
    },
    // Reset the form, clear the error, and put every answer back to empty
    // so the next open never inherits the last one's half-finished import
    // or private community's invitees.
    onClose: () => {
      formRef.current?.reset();
      setError('');
      applyMode(null);
      setAudience(null);
      setPeople([]);
      setKind(null);
      setName('');
      setDescribe('');
      setBrief('');
      suggestion.current = { from: '', edited: false, seq: suggestion.current.seq + 1 };
      setSuggesting(false);
      setSuggestNote('');
      setBotChat(null);
      setStep('who');
      setApprovers(null);
      setApprovals(null);
      setApprovalsN(1);
      setTemplate(null);
      // Drop the progress view too, so the next open lands on the form.
      // The build carries on server-side either way — closing this is
      // dismissing a report, not cancelling anything.
      setCreated(null);
      stopWatchingCreation();
    },
  });

  useHiddenClass(errorRef, !error);
  useIsomorphicLayoutEffect(() => {
    if (nameRef.current) nameRef.current.required = true;
  }, []);

  // Progress arrives on the WS `app_status` channel, which public/js/app.js
  // forwards into the store. That is the fast path and it is not the only
  // one it can be: a socket that drops right before the terminal event
  // would leave a step spinning forever. So while the outcome is still
  // pending, also ASK — GET /api/apps/:slug serves the same phase from the
  // server-side store, plus the status, so one poll recovers everything a
  // missed broadcast would have carried.
  const creatingSlug = created && outcomeOf(progress.status) === 'pending' ? created.slug : null;
  useEffect(() => {
    if (!creatingSlug) return undefined;
    let stopped = false;
    const poll = () => {
      if (stopped) return;
      void fetchCreationProgress(creatingSlug, (url) => fetch(url));
    };
    // Immediately, not only on the interval: the first phase broadcast
    // may already have been sent before this dialog started listening,
    // and four seconds of four idle steps reads as nothing happening.
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [creatingSlug]);

  /**
   * Bring a step that just unfolded into view with the footer under it, so
   * the button that moves on is on screen too. A step taller than the screen
   * shows its top instead.
   */
  function reveal(which: Step) {
    setTimeout(() => {
      const form = formRef.current;
      const section = form?.querySelector(`[data-create-step="${which}"]`);
      const footer = form?.querySelector('#create-cancel')?.parentElement;
      if (!section) return;
      const fits = footer && section.getBoundingClientRect().height + footer.getBoundingClientRect().height + 32 <= window.innerHeight;
      (fits ? footer : section).scrollIntoView({ block: fits ? 'end' : 'start', behavior: 'smooth' });
    }, 0);
  }

  /** Pressing a collapsed row reopens its step, answers kept; on its own step, a row selects. */
  function chooseAudience(next: Audience) {
    setError('');
    if (step !== 'who') { setStep('who'); return; }
    setAudience(next);
  }

  function chooseKind(next: Kind) {
    setError('');
    if (step !== 'kind') { setStep('kind'); return; }
    setKind(next);
  }

  function chooseStart(next: Mode) {
    setError('');
    if (step !== 'start') { setStep('start'); return; }
    if (next === mode) return;
    applyMode(next);
    if (next === 'import') setTimeout(() => urlRef.current?.focus(), 0);
    if (next === 'template') reveal('start');
  }

  function chooseTemplate(next: TemplateId) {
    setError('');
    if (step !== 'start') { setStep('start'); return; }
    setTemplate(next);
  }

  /** Move one step along, once this one is answered. */
  function next() {
    if (!stepAnswered) {
      if (step === 'details') {
        if (!name.trim()) {
          setError(tr("core:give_your_project_a_name_c9380487"));
          nameRef.current?.focus();
        } else if (!importing) {
          setError(tr("core:say_what_it_should_do_in_a_sentence_or_two_c0d1cec0"));
          briefRef.current?.focus();
        }
      }
      return;
    }
    const to = steps[steps.indexOf(step) + 1];
    if (!to) return;
    setError('');
    setStep(to);
    if (to === 'invite') setTimeout(() => inviteesRef.current?.focus(), 0);
    if (to === 'details') setTimeout(() => nameRef.current?.focus(), 0);
    if (to === 'about') void suggestDescription(false);
    if (to === 'start' || to === 'about' || to === 'approve') reveal(to);
  }

  /** One entry point keeps every mirror of the mode in sync. */
  function applyMode(next: Mode | null) {
    setMode(next);
    setError('');
    // A new answer here starts the check over: no stale banner, no stale read.
    setImportState('idle');
    setStatus(IDLE_STATUS);
    setRepo(null);
  }

  // The import check.
  //
  //   idle ─┬─ Check click ─→ checking ─┬─ ok    (the repo's dapp.json is
  //         │                           │        read, the notice shows,
  //         │                           │        Next enables)
  //         │                           └─ error (inline message, retry)
  //         └─ user edits URL after a successful check → back to idle
  //
  // Why explicit Check and not a debounced auto-check? Two reasons: (1) "I
  // just invited the bot, click here" is a clear action that pairs with the
  // inline error text from the server, vs. a debounced surprise; (2)
  // verifyBotAccess can mutate state by accepting a pending invitation, and we
  // don't want that firing on every keystroke.
  function normalizeRepositoryUrlInput(): string {
    const input = urlRef.current;
    const normalized = normalizeRepositoryUrl(input?.value || '');
    if (input) input.value = normalized;
    return normalized;
  }

  async function check() {
    const url = normalizeRepositoryUrlInput();
    const fail = (text: string) => {
      setImportState('error');
      setStatus({ tone: 'err', text });
    };
    if (!url) return fail(tr("core:paste_a_github_repo_url_first_764e077b"));

    setImportState('checking');
    setRepo(null);
    setStatus({ tone: 'none', get text() { return tr("core:checking_bot_access_72a5e391"); }, spinner: true });

    let res: Response;
    try {
      res = await fetch(`/api/github/verify-access?url=${encodeURIComponent(url)}`);
    } catch {
      return fail(tr("core:network_error_try_again_052b478f"));
    }

    let data: Record<string, unknown> = {};
    try {
      data = await res.json();
    } catch {
      /* a non-JSON body is reported through the HTTP status below */
    }
    if (!res.ok) return fail((data.error as string) || tr("core:check_failed_http_value1_92be4e2c", { value1: res.status }));

    const fullName = (data.fullName as string) || `${data.owner}/${data.repo}`;
    // {} when the repo has no dapp.json; null when the server could not read it.
    const manifest = data.manifest as RepoManifest | null | undefined;
    setRepo(manifest && typeof manifest === 'object' ? manifest : {});
    setRepoUnread(manifest === null);
    setImportState('ok');
    setStatus({ tone: 'ok', get text() { return tr("core:usernode_bot_has_write_access_to_value1_0c77d9b7", { value1: fullName }); } });
    // The name step comes next and opens on the repo's own name, unless one
    // was already typed (a later edit is named in the notice).
    const repoName = manifest && typeof manifest === 'object' && typeof manifest.name === 'string' ? manifest.name : '';
    if (repoName && !(nameRef.current?.value || '').trim()) {
      if (nameRef.current) nameRef.current.value = repoName;
      setName(repoName);
    }
    reveal('start');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Enter before the last step advances; only the last step creates.
    if (!isLast) {
      next();
      return;
    }
    const trimmed = (nameRef.current?.value || '').trim();
    setError('');
    if (!trimmed) {
      setError(tr("core:give_your_project_a_name_c9380487"));
      return;
    }
    if (!mode) {
      setError(tr("core:choose_how_you_want_to_start_0d875d0e"));
      return;
    }
    if (mode === 'template' && !template) {
      setError(tr("core:choose_a_template_b02f1422"));
      return;
    }
    const description = importing ? '' : (describeRef.current?.value || '');
    if (!importing) {
      if (brief.trim().length < BRIEF_MIN) return setError(tr("core:say_what_it_should_do_in_a_sentence_or_two_c0d1cec0"));
      if (!description.trim()) return setError(tr("core:say_what_it_is_in_one_line_e435361d"));
    }
    const repoUrl = mode === 'import' ? normalizeRepositoryUrlInput() : '';
    // Guard: an import is gated behind a successful check. The server runs
    // the pre-flight again on POST anyway.
    if (importing) {
      if (!repoUrl) return setError(tr("core:paste_a_github_repo_url_first_764e077b"));
      if (importState !== 'ok') return setError(tr("core:click_check_to_verify_bot_access_first_7770c41f"));
    }

    const body = createBody({
      name: trimmed,
      brief,
      description,
      mode,
      repoUrl,
      audience: audience ?? 'solo',
      invitees: people,
      approvers,
      approvals,
      approvalsN,
      repo,
      template,
    });

    // One request at a time (QA 2026-09-24 Q5). Claimed synchronously, before
    // the first await, so a second click in the same frame finds it taken.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const reply = await postCreateApp(body);
      void invalidateAppAllowance();
      if (!reply.ok) return setError(reply.error);
      const data = reply.data as { app?: { slug?: string; name?: string }; homeroomBot?: { conversationId?: number } };
      // #3624: the bot is building it, and says so in its DM.
      const chat = Number(data.homeroomBot?.conversationId);
      setBotChat(Number.isInteger(chat) && chat > 0 ? chat : null);
      // #12 (D10): it messages when it is ready, so offer the ping now.
      if (Number.isInteger(chat) && chat > 0) askForPingWhileBotBuilds();
      // The POST returns 201 with the row still in 'creating' — the build
      // runs async server-side. The dialog STAYS OPEN and reports the phases
      // app-creator broadcasts.
      const slug = data.app?.slug;
      if (!slug) {
        // A 201 we cannot follow. Nothing to report progress on, so fall
        // back to closing with a toast rather than an empty progress view.
        dialog.close();
        window.PlatformUI?.toast?.(
          importing
            ? tr("core:your_app_is_being_imported_it_will_appear_in_you_ddc2b198")
            : tr("core:your_app_is_being_created_it_will_appear_in_your_98425060"),
        );
        (window.Home?.load as (() => void) | undefined)?.();
        return;
      }
      watchCreation(slug);
      setCreated({ slug, name: data.app?.name || trimmed });
      // Refresh the grid behind the dialog so the new tile is already
      // there when the user closes it.
      (window.Home?.load as (() => void) | undefined)?.();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /**
   * The one-line "What is it?", suggested from "What should it do?" and
   * written into its field for the person to keep or change: the helper
   * model's line (POST /api/apps/suggest-description), or, when that does
   * not answer, the description's own first sentence. On arriving at the
   * step (`force` false) it is offered only when the description changed
   * since the last suggestion and the line is not the person's own;
   * "Suggest again" (`force` true) always asks. Either way a line typed
   * while the suggestion was on its way wins.
   */
  async function suggestDescription(force: boolean) {
    const text = brief.trim();
    const mine = suggestion.current;
    if (text.length < BRIEF_MIN) return;
    if (!force && (mine.edited || mine.from === text)) return;
    const seq = mine.seq + 1;
    suggestion.current = { from: text, edited: false, seq };
    setSuggesting(true);
    setSuggestNote('');
    let line = '';
    try {
      const res = await fetch('/api/apps/suggest-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: (nameRef.current?.value || '').trim(), brief: text }),
      });
      const data = (await res.json().catch(() => ({}))) as { description?: unknown };
      if (res.ok && typeof data.description === 'string') line = data.description.trim();
    } catch {
      /* the first sentence below */
    }
    if (suggestion.current.seq !== seq) return;
    setSuggesting(false);
    if (suggestion.current.edited) return;
    line = (line || firstSentence(text, DESCRIPTION_MAX)).slice(0, DESCRIPTION_MAX);
    if (describeRef.current) describeRef.current.value = line;
    setDescribe(line);
    setSuggestNote(tr("core:suggested_from_what_it_should_do_change_it_if_yo_bd259833"));
  }

  const stepIndex = Math.max(0, steps.indexOf(step)) + 1;
  // A step's number follows the answers so far: a private community has one
  // more, and an import one fewer (it is not described here).
  const numberOf = (which: Step) => stepsFor(audience ?? 'open', mode).indexOf(which) + 1;
  // The card and the root carry every answer, like data-mode always has:
  // the kit lifts the card out of the root while presented, so CSS keyed on
  // the root alone would stop matching. Each is empty until answered, so no
  // row wears the fill on arrival.
  const answers = {
    'data-mode': mode ?? '',
    'data-import-state': importState,
    'data-step': step,
    'data-audience': audience ?? '',
    'data-kind': kind ?? '',
    'data-approvers': approvers ?? '',
    'data-approvals': approvals ?? '',
    'data-final': isLast ? 'true' : 'false',
    // What an import's dapp.json decides: the answers it replaces, and the
    // approval rule it sets (app.css dims and tags them).
    'data-repo-sets': repoSets.join(' '),
  };

  return (
    <DialogRoot
      id="create-modal"
      ref={dialog.rootRef}
      {...answers}
      {...dialog.backdropProps}
    >
      <DialogCard
        size="sm"
        id="create-card"
        {...answers}
        className={PANE}
      >
        {created ? (
          <CreateProgress
            appName={created.name}
            mode={mode === 'import' ? 'import' : 'new'}
            surface="pane"
            progress={progress}
            // #13, #14: who builds from the description, and who approves,
            // decide what the view says comes next.
            builder={botChat ? 'bot' : (mode !== 'import' ? 'request' : null)}
            audience={audience ?? 'solo'}
            openLabel={botChat ? tr("core:open_chat_0600175a") : tr("core:open_project_5e5eba7f")}
            onOpenApp={() => {
              // Both destinations write an address right after the close,
              // so the close must not spend its back-press record: a queued
              // history.back() lands after that address and undoes it, and
              // the button did nothing (#3683).
              //
              // #3624: the Homeroom bot is building this one, and its DM is
              // where it asks and tells.
              if (botChat) {
                const chat = botChat;
                dialog.closeForNavigation();
                openMessages(chat);
                return;
              }
              // Stage 3: the new project's own page (its Workshop, which
              // opens on who it is for), not the running app. That is where
              // the first change is started.
              const slug = created.slug;
              dialog.closeForNavigation();
              (window.App?.navigateToApp as ((s: string, v: string) => void) | undefined)?.(slug, 'dev');
            }}
            onViewApp={() => {
              // #13: the app's own page, which says the bot is building its
              // first version (#15) rather than showing the starter.
              const slug = created.slug;
              dialog.closeForNavigation();
              (window.App?.navigateToApp as ((s: string, v: string) => void) | undefined)?.(slug, 'app');
            }}
            onSetSecrets={() => {
              const slug = created.slug;
              // The secrets dialog pushes its own back-button record as it
              // opens, and a plain close's queued history.back() would land
              // on that record and close it again (#3683).
              dialog.closeForNavigation();
              // Published by features/app-secrets — a bare global read is
              // what broke the last cross-surface jump, so guard it and
              // leave the tile's own "fix secrets" path as the fallback.
              (window.Secrets?.open as ((s: string) => void) | undefined)?.(slug);
            }}
            onRetry={() => {
              const slug = created.slug;
              // Put the view back into its pending state immediately —
              // the retry re-enters createApp server-side and will start
              // broadcasting phases again.
              watchCreation(slug);
              void fetch(`/api/apps/${encodeURIComponent(slug)}/retry`, { method: 'POST' })
                .then(() => (window.Home?.load as (() => void) | undefined)?.())
                .catch(() => {
                  publishAppStatus({
                    slug,
                    status: 'error',
                    get errorReason() { return tr("core:couldn_t_reach_the_server_to_retry_try_again_fro_388a6864"); },
                  });
                });
            }}
            onClose={() => dialog.close()}
          />
        ) : (
        <>
        <h2 id="create-title" className="text-[17px] font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
          <LocalizedValue render={() => (importing ? tr("core:import_a_project_be2bda4b") : tr("core:new_project_a41eb2bf"))} />
        </h2>
        {/*
            How far the flow has unfolded, and how far it goes for the
            answers so far: five steps for Just me, six for a public
            community, seven for a private one, and one fewer for an
            import. The index is also on the attribute for the declared
            checks.
        */}
        <p
          id="create-step-indicator"
          data-step-index={String(stepIndex)}
          className="text-xs text-zinc-500 dark:text-zinc-400 mb-3"
        >
          <LocalizedValue render={() => (tr("core:step_value1_of_value2_015e2b60", { value1: stepIndex, value2: steps.length }))} />
        </p>
        {/*
            Quiet (#23): only when the allowance bears on what happens next,
            not "0 of 2 app slots used" above every step.
        */}
        <AppAllowance id="create-app-quota" surface="pane" quiet />
        <form id="create-form" ref={formRef} className="space-y-4" onSubmit={submit}>
          {/*
              STEP 1: who it is for. The rows are the Workshop's three
              sections, in its words. Pressing one selects it; Next moves on,
              and the step collapses to the chosen row, whose "Change"
              reopens it.
          */}
          <div data-create-step="who" className="space-y-2">
            <p className={STEP_HEADING}><RichMessage id="core:sentence_6a258f8d9f04" components={[<span className="create-repo-sets-tag" data-repo-tag="vis" />]} /></p>
            {WHO.map((choice) => (
              <button
                key={choice.key}
                type="button"
                data-audience-pill={choice.key}
                aria-pressed={audience === choice.key}
                className={WHO_CHOICE}
                onClick={() => chooseAudience(choice.key)}
              >
                <WhoGlyph audience={choice.key} />
                <span className="min-w-0 flex-1">
                  <span className={CHOICE_TITLE}>{choice.title}</span>
                  <span className={CHOICE_CAPTION}>{choice.caption}</span>
                </span>
                <ChoiceMarker chosen={audience === choice.key} />
                <span className={CHOICE_CHANGE}><Message id="core:change_c0bf75bd" /></span>
              </button>
            ))}
          </div>
          {/*
              STEP 2, a private community only: who is in it, one row per
              person. The rows stay on screen, still editable, as the later
              steps open.
          */}
          <div data-create-step="invite" className="space-y-2">
            <p className={STEP_HEADING}><LocalizedValue render={() => (tr("core:value1_who_do_you_want_to_invite_a5b5d48f", { value1: numberOf('invite') }))} /></p>
            <InviteRows people={people} setPeople={setPeople} inputRef={inviteesRef} />
            <p className={CAPTION + ' mt-1.5'}><Message id="core:add_people_on_homeroom_by_username_or_type_an_em_8d608591" /></p>
          </div>
          {/*
              What it is: an App, the one kind there is today; Document and
              Video are there, dimmed, saying Soon, because the question is
              the one the screen will keep asking.
          */}
          <div data-create-step="kind" className="space-y-2">
            <p className={STEP_HEADING}><LocalizedValue render={() => (tr("core:value1_what_are_you_making_05c10c9c", { value1: numberOf('kind') }))} /></p>
            <button
              type="button"
              data-kind-pill="app"
              aria-pressed={kind === 'app'}
              className={'create-kind-row ' + CHOICE_BASE}
              onClick={() => chooseKind('app')}
            >
              <AppWindowIcon className="w-5 h-5 shrink-0 opacity-80" aria-hidden="true" />
              <span className="min-w-0 flex-1"><RichMessage id="core:sentence_652c3fa17b28" components={[<span className={CHOICE_TITLE} />, <span className={CHOICE_CAPTION} />]} /></span>
              <ChoiceMarker chosen={kind === 'app'} />
              <span className={CHOICE_CHANGE}><Message id="core:change_c0bf75bd" /></span>
            </button>
            <div className={SOON + ' create-kind-soon'} data-kind-pill="doc" aria-disabled="true">
              <NewspaperIcon className="w-5 h-5 shrink-0 opacity-50" aria-hidden="true" />
              <span className="min-w-0 flex-1"><RichMessage id="core:sentence_61ba83283424" components={[<span className={CHOICE_TITLE} />, <span className={CHOICE_CAPTION} />]} /></span>
              <span className={SOON_TAG}><Message id="core:soon_cf0ee354" /></span>
            </div>
            <div className={SOON + ' create-kind-soon'} data-kind-pill="video" aria-disabled="true">
              <PlayIcon className="w-5 h-5 shrink-0 opacity-50" aria-hidden="true" />
              <span className="min-w-0 flex-1"><RichMessage id="core:sentence_d0259739afdb" components={[<span className={CHOICE_TITLE} />, <span className={CHOICE_CAPTION} />]} /></span>
              <span className={SOON_TAG}><Message id="core:soon_cf0ee354" /></span>
            </div>
          </div>
          {/*
              How to begin, straight after what you are making. From
              scratch; from a template, whose four starters open under its
              row; or from a GitHub repo, whose URL and Check open under its
              row. The check also reads the repo's dapp.json, and the notice
              under it names each earlier answer the repo replaces. Once the
              card moves on, the step collapses to the chosen row (and the
              chosen starter, or the repo), whose "Change" reopens it.
          */}
          <div data-create-step="start" className="space-y-2">
            <p className={STEP_HEADING}><LocalizedValue render={() => (tr("core:value1_how_do_you_want_to_start_a7e6930e", { value1: numberOf('start') }))} /></p>
            <button
              type="button"
              data-mode-pill="new"
              aria-pressed={mode === 'new'}
              className={CHOICE}
              onClick={() => chooseStart('new')}
            ><RichMessage id="core:sentence_9c64d5efab96" components={[<span className="min-w-0 flex-1" />, <span className={CHOICE_TITLE} />, <span className={CHOICE_CAPTION} />, <span className={CHOICE_CHANGE} />]} /></button>
            <button
              type="button"
              data-mode-pill="template"
              aria-pressed={mode === 'template'}
              className={CHOICE}
              onClick={() => chooseStart('template')}
            ><RichMessage id="core:sentence_906fedde4236" components={[<span className="min-w-0 flex-1" />, <span className={CHOICE_TITLE} />, <span className={CHOICE_CAPTION} />, <span className={CHOICE_CHANGE} />]} /></button>
            {/*
                The starters (#3521), only once "Start from a template" is
                chosen: rendered behind that state, like the progress view,
                so nothing here is in the prerendered document. Nothing is
                picked on arrival; Next stays dimmed until one is.
            */}
            {mode === 'template' ? (
              <Localized element={<div id="create-template-block" role="group" aria-label={catalogText("core:templates_56b564b7")} className="space-y-2 pl-3">
                {TEMPLATES.map((choice) => (
                  <button
                    key={choice.key}
                    type="button"
                    data-template-pill={choice.key}
                    aria-pressed={template === choice.key}
                    className={TEMPLATE_CHOICE}
                    onClick={() => chooseTemplate(choice.key)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={CHOICE_TITLE}>{choice.title}</span>
                      <span className={CHOICE_CAPTION}>{choice.caption}</span>
                    </span>
                  </button>
                ))}
              </div>} messages={{"aria-label":"core:templates_56b564b7"}} />
            ) : null}
            <button
              type="button"
              data-mode-pill="import"
              aria-pressed={mode === 'import'}
              className={CHOICE}
              onClick={() => chooseStart('import')}
            ><RichMessage id="core:sentence_e804948a1b6c" components={[<span className="min-w-0 flex-1" />, <span className={CHOICE_TITLE} />, <span className={CHOICE_CAPTION} />, <span className={CHOICE_CHANGE} />]} /></button>
            <div id="create-import-block" className="create-import-block">
              <div className={CARD}>
                <div className={ROW}>
                  <label htmlFor="import-url" className={LABEL}><Message id="core:github_repo_url_602cdae8" /></label>
                  <div className="flex items-center gap-2">
                    <Localized element={<Input
                      id="import-url"
                      ref={urlRef}
                      name="repoUrl"
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck="false"
                      width="flex"
                      {...FIELD}
                      className="font-mono text-[15px]" placeholder={catalogText("core:github_com_owner_repo_620c3a93")}
                      onBlur={() => {
                        normalizeRepositoryUrlInput();
                      }}
                      onInput={() => {
                        // Any edit invalidates the previous check; the user must
                        // click again. Without this they could verify repo A, edit
                        // the URL to point at repo B, then submit — the route's own
                        // pre-flight catches it, but the UI shouldn't claim
                        // "verified" for a URL that hasn't been verified.
                        setImportState('idle');
                        setStatus(IDLE_STATUS);
                        setRepo(null);
                      }}
                    />} messages={{"placeholder":"core:github_com_owner_repo_620c3a93"}} />
                    <Button
                      type="button"
                      id="import-check"
                      variant="pillNeutral"
                      size="sm"
                      ink="neutral"
                      layout="shrink"
                      disabledStyle="block"
                      // The pill sits INSIDE a white card, so its neutral fill
                      // has to be one step off the card in both themes.
                      className="whitespace-nowrap dark:bg-zinc-700 dark:hover:bg-zinc-600"
                      disabled={importState === 'checking'}
                      onClick={check}
                    >
                      <LocalizedValue render={() => (importState === 'ok' ? tr("core:re_check_24fcca00") : tr("core:check_9d60841e"))} />
                    </Button>
                  </div>
                </div>
              </div>
              {/*
                  ONE text node on each side of the <code>. `Invite{' '}` is two
                  adjacent text children, and renderToStaticMarkup emits no
                  separator comment between them, so the browser sees one node
                  where hydration expects two and React reports #418 — a
                  console error, which fails proposal checks.
              */}
              <p className={CAPTION + ' create-import-hint mt-1.5'}><RichMessage id="core:sentence_7514fbd343db" components={[<code className="font-mono text-xs">
                  usernode-bot
                </code>]} /></p>
              {/*
                  Inline status row: spinner while checking, green check on
                  ok, red error text on failure. Hidden in idle.
              */}
              <div id="import-status" className={statusClass(status)}>
                {status.spinner ? <span className="import-spinner"></span> : null}
                {status.text}
              </div>
              <div className="mt-2">
                {importState === 'ok' ? (
                  <RepoNotice overrides={overrides} unread={repoUnread} />
                ) : (
                  <p className={CAPTION}><Message id="core:check_the_repo_to_see_what_its_dapp_json_already_4578e667" /></p>
                )}
              </div>
            </div>
          </div>
          {/*
              The name, and for a project made here what it should do:
              required, and filed as the project's first request once it
              runs (for somebody the Homeroom bot builds for, the bot builds
              it). An import is named here and nothing more: its repo says
              what it is, and app.css folds the second row away for it.
          */}
          <div data-create-step="details" className="space-y-4">
            <p className={STEP_HEADING}>
              {`${numberOf('details')}. ${importing ? tr("core:what_to_call_it_55325bff") : tr("core:what_to_call_it_and_what_it_should_do_5b93bb5c")}`}
              <span className="create-repo-sets-tag" data-repo-tag="details"><Message id="core:the_repo_sets_this_4961d9e2" /></span>
            </p>
            {/* Return in the name goes on to what it should do (#3907), where
                it is a new line. Before, it submitted the form, and `next()`
                refused and focused the brief with an error. An import has no
                brief (app.css folds the row away), so there the name is the
                last field and Return submits the form as it always did. */}
            <div id="create-name-block" className={CARD} onKeyDown={returnKeyHandler()}>
              <div className={ROW + ' create-name-row'}>
                <label htmlFor="app-name" className={LABEL}><Message id="core:project_name_25498193" /></label>
                <Localized element={<Input
                  id="app-name"
                  ref={nameRef}
                  name="name"
                  type="text"
                  autoComplete="off"
                  enterKeyHint="next"
                  {...FIELD} placeholder={catalogText("core:my_cool_app_60eee939")}
                  onInput={(e) => { setName(e.currentTarget.value); setError(''); }}
                />} messages={{"placeholder":"core:my_cool_app_60eee939"}} />
              </div>
              {/* What it should do. It grows with its text (the layout
                  effect above), so its first line never sits under the
                  label, and one caption under it says who builds from it. */}
              <div className={ROW + ' create-brief-row shadow-[inset_0_1px_0_var(--app-sheet-line)]'} data-create-brief="">
                <label htmlFor="app-brief" className={LABEL}><Message id="core:what_should_it_do_1970bec5" /></label>
                <Localized element={<Textarea
                  id="app-brief"
                  ref={briefRef}
                  name="brief"
                  rows={3}
                  maxLength={BRIEF_MAX}
                  {...FIELD}
                  className={BRIEF_FIELD} placeholder={catalogText("core:a_shared_shopping_list_for_our_house_anyone_can__a674982e")}
                  value={brief}
                  onChange={(e) => { setBrief(e.currentTarget.value); setError(''); }}
                />} messages={{"placeholder":"core:a_shared_shopping_list_for_our_house_anyone_can__a674982e"}} />
                <p className="create-brief-caption pb-1 text-xs text-zinc-500 dark:text-zinc-400">{briefCaption(botBuild)}</p>
              </div>
            </div>
          </div>
          {/*
              What it is, in one line: required for a project made here, and
              suggested from what it should do on arrival (suggestDescription).
              Written into the new repository's dapp.json, where people read
              it on the join screen, in Discover and on its page. #3572: at
              most DESCRIPTION_MAX characters, counted down on the label's
              line for the last few. The count is rendered only once it says
              something, so the prerendered row is the one the shell shipped.
              An import skips the step: its repo describes it.
          */}
          <div data-create-step="about" className="space-y-2">
            <p className={STEP_HEADING}><LocalizedValue render={() => (tr("core:value1_short_description_b99a3495", { value1: numberOf('about') }))} /></p>
            <div className={CARD}>
              <div className={ROW + ' create-describe-row relative'}>
                <label htmlFor="app-description" className={LABEL}><Message id="core:what_is_it_bbff7b98" /></label>
                {describeLeftText ? (
                  <span
                    id="app-description-left"
                    aria-live="polite"
                    className={`${DESCRIPTION_LEFT} ${describe.length >= DESCRIPTION_MAX - 5
                      ? 'text-amber-800 dark:text-amber-300'
                      : 'text-zinc-500 dark:text-zinc-400'}`}
                  >
                    {describeLeftText}
                  </span>
                ) : null}
                <LocalizedDynamic element={<Input
                  id="app-description"
                  ref={describeRef}
                  name="description"
                  type="text"
                  autoComplete="off"
                  maxLength={DESCRIPTION_MAX}
                  aria-describedby={describeLeftText ? 'app-description-left' : undefined}
                  {...FIELD}
                  placeholder={suggesting ? tr("core:suggesting_9612c60d") : tr("core:shared_shopping_list_d48f3553")}
                  onInput={(e) => {
                    const value = e.currentTarget.value;
                    suggestion.current.edited = value.trim() !== '';
                    setDescribe(value);
                    setSuggestNote('');
                    setError('');
                  }}
                />} resolve={() => ({ "placeholder": suggesting ? tr("core:suggesting_9612c60d") : tr("core:shared_shopping_list_d48f3553") })} />
              </div>
            </div>
            <div className="flex items-start justify-between gap-3 px-1">
              <p className="create-describe-note text-xs text-zinc-500 dark:text-zinc-400" role="status">
                <LocalizedValue render={() => (suggesting ? tr("core:suggesting_9612c60d") : (suggestNote || tr("core:one_line_people_see_on_its_page_and_in_discover_5ace347d")))} />
              </p>
              <button
                type="button"
                className="create-suggest-again shrink-0 text-xs font-medium text-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-violet-300"
                disabled={suggesting}
                onClick={() => { void suggestDescription(true); }}
              ><Message id="core:suggest_again_bba9f46c" /></button>
            </div>
          </div>
          {/*
              LAST, for a private or a public community: who approves
              changes. Members vote is the platform's default rule; People I
              pick starts with just the creator as approver, and under it "at
              least N yes votes" is the follow-up. Written into the new
              repository's dapp.json, so it can be voted on later like any
              other rule there. Nothing is picked on arrival, and neither is
              the follow-up once it shows. An import whose repo already sets
              the rule is told so here, and is not asked.
          */}
          <div data-create-step="approve" className="space-y-2">
            <p className={STEP_HEADING}>
              <LocalizedValue render={() => (tr("core:value1_who_approves_changes_033157a1", { value1: numberOf('approve') }))} />
              <span className="create-repo-sets-tag" data-repo-tag="gov"><Message id="core:the_repo_sets_this_4961d9e2" /></span>
            </p>
            {repoGov ? (
              <p className={CAPTION} data-repo-rule=""><LocalizedValue render={() => (tr("core:this_repo_s_dapp_json_already_sets_it_value1_09a0863a", { value1: repoGov }))} /></p>
            ) : null}
            <div id="create-approve-block" className="space-y-2">
              <button
                type="button"
                data-approver-pill="anyone"
                aria-pressed={approvers === 'anyone'}
                className={APPROVER_CHOICE}
                onClick={() => setApprovers('anyone')}
              ><RichMessage id="core:sentence_dad38c347639" components={[<span className="min-w-0 flex-1" />, <span className={CHOICE_TITLE} />, <span className={CHOICE_CAPTION} />]} /></button>
              <button
                type="button"
                data-approver-pill="invited"
                aria-pressed={approvers === 'invited'}
                className={APPROVER_CHOICE}
                onClick={() => setApprovers('invited')}
              ><RichMessage id="core:sentence_559add0ce030" components={[<span className="min-w-0 flex-1" />, <span className={CHOICE_TITLE} />, <span className={CHOICE_CAPTION} />]} /></button>
              <div className="create-approvals-block space-y-2 pt-1">
                <p className={LABEL}><Message id="core:how_many_of_them_must_say_yes_5b48a93e" /></p>
                <div className={RAIL}>
                  <button
                    type="button"
                    data-approvals-pill="majority"
                    aria-pressed={approvals === 'majority'}
                    className={'create-approvals-pill ' + SEGMENT}
                    onClick={() => setApprovals('majority')}
                  ><Message id="core:a_majority_2a0acf0f" /></button>
                  <button
                    type="button"
                    data-approvals-pill="atLeast"
                    aria-pressed={approvals === 'atLeast'}
                    className={'create-approvals-pill ' + SEGMENT}
                    onClick={() => {
                      setApprovals('atLeast');
                      setTimeout(() => approvalsNRef.current?.focus(), 0);
                    }}
                  ><Message id="core:at_least_a_number_bad1b3dd" /></button>
                </div>
                <div className={CARD + ' create-approvals-n-block'}>
                  <div className={ROW + ' flex items-center gap-3'}>
                    <label htmlFor="create-approvals-n" className={LABEL + ' flex-1'}><Message id="core:yes_votes_needed_a5e39498" /></label>
                    <Input
                      id="create-approvals-n"
                      ref={approvalsNRef}
                      name="approvalsN"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={50}
                      defaultValue="1"
                      {...FIELD}
                      className="w-16 text-right"
                      onInput={(e) => setApprovalsN(Number(e.currentTarget.value) || 0)}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div id="create-error" ref={errorRef} className="px-1 text-red-700 dark:text-red-400 text-sm hidden">
            {error}
          </div>
          {/*
              The footer follows how far the card has unfolded, through CSS
              on #create-card[data-final] rather than by mounting and
              unmounting (every id ships on every step). Cancel is always
              there; Next beside it until the last step, then Create /
              Import. Either one stays dimmed until its step is answered
              (`stepAnswered`). No Back: the earlier steps are still on
              screen, and each collapsed row's "Change" reopens its choice.
          */}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              id="create-cancel"
              className={PILL_SECONDARY}
              onClick={() => dialog.close()}
            ><Message id="core:cancel_19766ed6" /></button>
            <Button
              type="button"
              id="create-next"
              variant="pillAccent"
              size="pill"
              layout="flex"
              disabledStyle="block"
              disabled={quotaBlocksCreation || !stepAnswered}
              onClick={next}
            ><Message id="core:next_1ff57a29" /></Button>
            {/*
                QA 2026-09-24 Q5: disabled with a spinner while the POST is
                in flight. `submitting` starts false, so the first render is
                still the prerendered button: no aria-busy, no spinner.
            */}
            <Button
              type="submit"
              id="create-submit"
              variant="pillAccent"
              size="pill"
              layout="flex"
              disabledStyle="block"
              disabled={quotaBlocksCreation || submitting || !stepAnswered}
              aria-busy={submitting || undefined}
            >
              {submitting ? <SpinnerArcIcon className="inline-block h-4 w-4 mr-2 -mt-0.5 align-middle animate-spin" aria-hidden="true" /> : null}
              <LocalizedValue render={() => (submitting
                ? (importing ? tr("core:importing_c01c4324") : tr("core:creating_c79ed949"))
                : (importing ? tr("core:import_2cff9baa") : tr("core:create_4759498a")))} />
            </Button>
          </div>
        </form>
        </>
        )}
      </DialogCard>
    </DialogRoot>
  );
}
