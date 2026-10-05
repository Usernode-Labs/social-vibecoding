import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * Right after "Make it" (./make.tsx): something to give, and one thing to
 * do with it.
 *
 *   what      The project, being built: its tile and name, Homeroom bot's
 *             step from GET /api/apps/:slug (`app.first_version`, "Step 2 of
 *             7: Read the description"), read again every ten seconds,
 *             past the service worker's cache (madeAppOf, madeAppUrl).
 *   plan      B6: once the bot has read the description it waits for its
 *             plan's Build it (`first_version.plan`) and builds nothing
 *             until then. The plan itself is answered in the chat with
 *             Homeroom bot, where Build it and Change something are: this
 *             screen draws a small "Needs you" card under the project, "Homeroom
 *             bot has a plan for <name>", whose Go to chat opens that chat
 *             (PlanWaitsCard). It used to draw the whole plan, with Build it,
 *             above the sketch, and it arrived there at whatever moment the
 *             plan did (Evan, 5 October 2026).
 *   invite    "Invite people to <name>": Share invite opens a short sheet
 *             (InviteSheet below). Once something has gone out, the line
 *             says so and "Invite people later" becomes "Go to the
 *             Homeroom app". Either starts the tour (./index.tsx). While
 *             it is out, the project's community is read again, and the
 *             line says who has joined (joinedLine).
 *
 * Nothing under the two buttons. A quiet "While you wait, look around Home
 * and other apps" used to sit there; "Invite people later" is already the
 * way on without inviting anyone, so it was a third way off one screen
 * (Evan, 5 October 2026).
 *
 * The sheet is the first invite, not the project's full invite pane
 * (features/app-context/invite-pane.tsx, with live links, their limits, an
 * invite by username and the project's joining rule, which stays where it
 * is): what they'll get, "<maker> is making <name>" while its first version
 * is not live, with the note edited in place, then Share link. Nothing else:
 * somebody brand new knows nobody on Homeroom to invite by username yet, and
 * the joining rule is the project's business later (both taken out after
 * Evan's run-through, 5 October 2026). The link it makes works until it is
 * turned off, for anyone it reaches (WP-D): the project is the gift, so the
 * link should outlive a week. The first note shared is also the maker's
 * first message in the group's chat (the sheet says so), so the people it
 * brings find it waiting there. The note is kept per project on this device
 * (noteKey), else read back from the maker's own newest link.
 *
 *   sketch    A featured card of the idea (./sketch-card.tsx,
 *             services/app-sketch.js): its emoji, now the project's icon, a
 *             tagline and what it will do, made from the description in a
 *             few seconds, with the build's step under it. The same frame
 *             stands while it is sketched. Without one (a project with no
 *             sketch, or one that never came) the card shows the build alone.
 *
 * Every line says what is true for this project: when Homeroom bot builds
 * it (`made.conversationId`, its DM), its step and "messages you"; when it
 * does not, the description is the project's first request, for whoever
 * builds it. Nothing says how long a first version takes (buildNote).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { askForPingWhileBotBuilds } from '../dialogs/ping-ask';
import type { HomeroomBotPlanQuestion } from '../messages/types';

import type { Made } from './make';
import { SketchCard, showsCard, useSketch } from './sketch-card';

/** B6: the plan Homeroom bot waits on before it builds anything. */
export type WaitingPlan = {
  bullets: string[];
  questions: HomeroomBotPlanQuestion[];
  actionId: number;
  messageId: number | null;
  conversationId: number | null;
};

type FirstVersion = {
  step?: number; of?: number; stepName?: string | null; ready?: boolean;
  /** B6: the plan waiting for Build it, for its creator (GET /api/apps/:slug). */
  plan?: Partial<WaitingPlan> | null;
} | null;

/**
 * The project's record as GET /api/apps/:slug answers it, which is `{ app }`:
 * its first version (null while the bot builds nothing) and its status. Null
 * for an answer without a record. Page Turners, 5 October 2026: the made
 * screen read `first_version` off the answer itself, never found one, and
 * so never drew the plan its maker waited 18 minutes on.
 */
export function madeAppOf(body: unknown): { firstVersion: FirstVersion; status: string | null } | null {
  const app = body && typeof body === 'object' ? (body as { app?: unknown }).app : null;
  if (!app || typeof app !== 'object') return null;
  const { first_version: firstVersion, status } = app as { first_version?: FirstVersion; status?: unknown };
  return { firstVersion: firstVersion || null, status: typeof status === 'string' ? status : null };
}

/**
 * The made screen's read of the project, every ten seconds. Tagged and
 * no-store, as the App tab's recheck is (AppView._recheckFirstVersion): the
 * service worker answers a plain GET /api/apps/:slug from its boot cache
 * first, and a poll is asking what is true now.
 */
export function madeAppUrl(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}?status_recheck=1&manifest=summary`;
}

/**
 * The plan waiting for Build it, or null: read the way the App tab's
 * being-built screen reads it (AppView._firstVersionView), so the two agree
 * on when there is one.
 */
export function waitingPlan(fv: FirstVersion): WaitingPlan | null {
  const plan = fv && !fv.ready ? fv.plan : null;
  if (!plan || !Array.isArray(plan.bullets) || !plan.bullets.length || !Number.isInteger(plan.actionId)) return null;
  return {
    bullets: plan.bullets,
    questions: Array.isArray(plan.questions) ? plan.questions : [],
    actionId: Number(plan.actionId),
    messageId: Number.isInteger(plan.messageId) ? Number(plan.messageId) : null,
    conversationId: Number.isInteger(plan.conversationId) ? Number(plan.conversationId) : null,
  };
}

/** Over the plan's card: it is the one thing on the screen that waits on them. */
export const PLAN_LABEL = () => tr("workshop:needs_you_74b6abdf");

/** The plan's card: that there is one, never what to tap in it (that is the chat's). */
export function planWaitsLine(name: string): string {
  return tr("auth:homeroom_bot_has_a_plan_for_name_bd8c3872", { name });
}

/** "Step 2 of 7: Read the description", or what to say without a build. */
export function buildLine(fv: FirstVersion, appStatus: string | null, botBuilds = true): string {
  if (fv && fv.ready) return tr("auth:version_one_is_ready_to_try_bbe53bf2");
  if (fv && fv.step && fv.of) return tr("auth:step_value1_of_value2_value3_8acfce48", { value1: fv.step, value2: fv.of, value3: fv.stepName ? `: ${fv.stepName}` : '' });
  if (appStatus === 'creating') return tr("auth:setting_it_up_a5a8341a");
  return botBuilds ? tr("auth:homeroom_bot_builds_it_from_your_description_594b8440") : tr("auth:your_description_is_its_first_request_e08683bb");
}

/**
 * The line under the build's: who tells them, or who builds it. B6: while
 * its plan waits, that nothing happens until they say so.
 *
 * It says nothing about how long. It used to promise "usually in about 10
 * minutes", an ordinary request's typical build (WP-E, homeroom-bot-dm.js
 * typicalMinutes), and a first version plans first and waits on its maker's
 * answer: Page Turners, 5 October 2026, sent its plan 11 minutes after Make
 * it and was ready to try 50 minutes after it. No average stands in for it
 * (Evan, the same day).
 *
 * Nor does it explain the plan any more. Until the plan was sent it said
 * "Homeroom bot plans it first, and asks you to approve the plan", and after
 * it only that it messages you. Evan, 5 October 2026: one plain line, the
 * same before and after the plan, that says it asks when it has questions.
 * The plan, when it comes, has its own card under the project
 * (PlanWaitsCard), and while it waits this line says so instead.
 */
export function buildNote(botBuilds: boolean, planWaits = false): string {
  if (!botBuilds) return tr("auth:you_or_anyone_you_invite_can_build_it_from_there_f3222583");
  if (planWaits) return tr("auth:homeroom_bot_is_waiting_for_your_go_ahead_7e902372");
  return tr("auth:homeroom_bot_messages_you_when_the_first_version_0ad61e04");
}

/**
 * "alex is making Page Turners" while its first version is not live, and
 * "alex made Page Turners" once it is: what they'll get, in the invite sheet
 * and the title of what it shares.
 */
export function makerLine(me: string, name: string, making: boolean): string {
  if (!me) return making ? tr("auth:being_made_name_5f764e40", { name }) : tr("auth:made_name_915a1e9c", { name });
  return making ? tr("auth:me_is_making_name_98a84d21", { me, name }) : tr("auth:me_made_name_73957b27", { me, name });
}

const NOTE_DEFAULT = () => tr("workshop:come_try_it_with_me_6fb15c1a");
// WP-D: the link works until it is turned off, for anyone it is sent to (0 is
// no limit, services/community-invites.js NO_LIMIT): the project is the gift.
const LINK_DAYS = 0;
const LINK_USES = 0;

/** The note, posted once per project as the maker's first chat message. */
const postedKey = (slug: string) => `usernode:first-session:note-posted:${slug}`;

/** The maker's last note for a project, kept on this device. */
export const noteKey = (slug: string) => `usernode:first-session:note:${slug}`;

/** The note they last wrote for `slug`, or null when there is none kept. */
export function keptNote(slug: string): string | null {
  try { return localStorage.getItem(noteKey(slug)); } catch { return null; }
}

function keepNote(slug: string, note: string): void {
  try { localStorage.setItem(noteKey(slug), note); } catch { /* kept for this sheet only */ }
}

/** The note the sheet opens with: the one kept, else the example's, else the default. */
export function openingNote(slug: string, example: string | null | undefined): string {
  const kept = keptNote(slug);
  return kept !== null ? kept : (example || NOTE_DEFAULT());
}

/** The newest note on the maker's own live links (GET .../invite-links `links`), or null. */
export function linkNote(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  const mine = links.find((l) => l && typeof l === 'object' && (l as { mine?: boolean }).mine
    && typeof (l as { note?: unknown }).note === 'string' && (l as { note: string }).note);
  return mine ? (mine as { note: string }).note : null;
}

export function InviteSheet({ made, me, making = true, onClose, onSent }: {
  made: Made;
  me: string;
  /** Its first version is not live yet: "<me> is making <name>" (makerLine). */
  making?: boolean;
  onClose: () => void;
  /** The link went out (shared or copied). */
  onSent: () => void;
}) {
  useUiLanguage();
  const [note, setNote] = useState(() => openingNote(made.slug, made.example?.note));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const linkRef = useRef<string | null>(null);
  // Whether the note in the box is theirs from this device (kept, or typed
  // here); until it is, a note on one of their own links replaces it.
  const ownNote = useRef(keptNote(made.slug) !== null);
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  // The maker's own newest note, when this device kept none.
  useEffect(() => {
    if (ownNote.current) return undefined;
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(made.slug)}/invite-links`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const fromLink = live && !ownNote.current ? linkNote(data?.links) : null;
        if (fromLink) setNote(fromLink);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [made.slug]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The maker's note, as their first message in the group's chat, once.
  const postNote = useCallback(async () => {
    const text = note.trim();
    if (!text) return;
    try { if (localStorage.getItem(postedKey(made.slug))) return; } catch { /* post it */ }
    const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ content: text }),
    }).catch(() => null);
    if (res && res.ok) { try { localStorage.setItem(postedKey(made.slug), '1'); } catch { /* once is best effort */ } }
  }, [note, made.slug]);

  const link = useCallback(async (): Promise<string | null> => {
    if (linkRef.current) return linkRef.current;
    const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ days: LINK_DAYS, maxUses: LINK_USES, note: note.trim() || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.link) { setError(data.error || tr("auth:could_not_make_a_link_try_again_0fc01e0c")); return null; }
    linkRef.current = `${location.origin}${data.link.path}`;
    return linkRef.current;
  }, [made.slug, note]);

  const shareLink = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null); setStatus(null);
    try {
      const url = await link();
      if (!url) return;
      const title = makerLine(me, made.name, making);
      const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      let shared = false;
      if (typeof nav.share === 'function') {
        try { await nav.share({ title, text: note.trim() || undefined, url }); shared = true; } catch (err) {
          if ((err as Error)?.name === 'AbortError') return;
        }
      }
      if (!shared) {
        await navigator.clipboard.writeText(note.trim() ? `${note.trim()} ${url}` : url);
        setStatus(tr("auth:link_copied_paste_it_in_your_group_chat_ff1ea727"));
      }
      keepNote(made.slug, note);
      await postNote();
      onSent();
    } catch {
      setError(tr("auth:could_not_share_the_link_try_again_4954e198"));
    } finally {
      setBusy(false);
    }
  }, [busy, link, me, made.name, making, note, postNote, onSent]);

  const tile = made.emoji || made.name.slice(0, 1);
  return (
    <div className="fixed inset-0 z-[9001]" data-first-session-invite="">
      <div aria-hidden="true" onClick={onClose} className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-session-invite-title"
        className={`absolute inset-x-0 bottom-0 max-h-[92%] overflow-y-auto rounded-t-[20px] bg-zinc-100 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))] transition-transform duration-200 ease-out dark:bg-zinc-900 md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:rounded-[20px] md:pb-6 ${shown ? 'translate-y-0 md:-translate-x-1/2 md:-translate-y-1/2' : 'translate-y-full md:-translate-x-1/2 md:-translate-y-1/2'}`}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 md:hidden" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="first-session-invite-title" className="min-w-0 flex-1 text-[17px] font-semibold"><LocalizedValue render={() => (tr("auth:invite_people_to_value1_847cd1ff", { value1: made.name }))} /></h2>
          <Localized element={<button type="button" onClick={onClose} aria-label={catalogText("auth:close_7d9eb7ac")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>} messages={{"aria-label":"auth:close_7d9eb7ac"}} />
        </div>
        <p className="mt-4 pb-1.5 text-[13px] text-zinc-500 dark:text-zinc-400"><Message id="auth:what_they_ll_get_f625566f" /></p>
        <div className="overflow-hidden rounded-2xl bg-white dark:bg-zinc-800">
          <div className="flex items-center gap-3 p-3">
            <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{tile}</span>
            <div className="min-w-0">
              <p data-first-session-invite-maker="" className="text-[15px] font-semibold leading-snug">{makerLine(me, made.name, making)}</p>
              <p className="text-[13px] text-zinc-500 dark:text-zinc-400"><Message id="auth:a_link_to_see_it_and_join_the_chat_7f4e836c" /></p>
            </div>
          </div>
          <div className="px-3 pb-2 pt-2.5 shadow-[inset_0_1px_0_var(--app-sheet-line)]">
            {/* Named on screen, in the label style of "What they'll get" above
                and the make screen's fields (make.tsx LABEL): unlabelled, the
                note read as part of the card rather than something to write. */}
            <label htmlFor="first-session-note" className="block pb-1 text-[13px] text-zinc-500 dark:text-zinc-400"><Message id="core:note_d8da2c49" /></label>
            <Localized element={<textarea
              id="first-session-note"
              rows={2}
              maxLength={280}
              value={note}
              onChange={(e) => { ownNote.current = true; setNote(e.target.value); keepNote(made.slug, e.target.value); }}
              placeholder={catalogText("auth:add_a_note_optional_6bb0c6b3")}
              className="w-full resize-none border-0 bg-transparent p-0 text-[16px] leading-snug placeholder-zinc-500 focus:outline-none"
            />} messages={{"placeholder":"auth:add_a_note_optional_6bb0c6b3"}} />
          </div>
        </div>
        <p className="mt-2 text-[13px] text-zinc-500 dark:text-zinc-400"><Message id="auth:your_note_is_also_your_first_message_in_the_grou_210befcf" /></p>
        <div className="mt-4">
          <Button type="button" onClick={() => { void shareLink(); }} disabled={busy} layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="flex items-center justify-center disabled:opacity-60">
            <Message id="auth:share_link_712a4823" />
          </Button>
        </div>
        {status ? <p role="status" data-first-session-invite-status="" className="mt-3 text-center text-[14px] text-emerald-700 dark:text-emerald-400">{status}</p> : null}
        {error ? <p id="first-session-invite-error" role="alert" className="mt-3 text-center text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
        <p className="mt-3 text-center text-[13px] text-zinc-500 dark:text-zinc-400"><Message id="auth:anyone_with_the_link_can_join_until_you_turn_it__4635ef3a" /></p>
      </div>
    </div>
  );
}

/**
 * B6: the plan waits for its maker's answer, which is given in the chat with
 * Homeroom bot (Build it, or Change something). Here it is one small card
 * under the project, in the place it always takes, with the way to that
 * chat. It never says Build it itself.
 */
export function PlanWaitsCard({ name, onOpenChat }: { name: string; onOpenChat: () => void }) {
  useUiLanguage();
  return (
    <section data-first-session-plan="waiting" aria-labelledby="first-session-plan-label" className="mt-4">
      <p id="first-session-plan-label" className="px-1 pb-1.5 text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{PLAN_LABEL()}</p>
      <div className="flex items-center gap-3 rounded-[20px] bg-white py-3 pl-4 pr-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-[650] leading-snug">{planWaitsLine(name)}</p>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400"><Message id="auth:answer_it_in_your_chat_and_it_starts_building_659a6875" /></p>
        </div>
        <Button type="button" data-first-session-plan-chat="" onClick={onOpenChat} variant="pillAccent" size="sm" ink="solid" className="shrink-0 text-[15px] font-semibold">
          <Message id="auth:go_to_chat_bc012506" />
        </Button>
      </div>
    </section>
  );
}

type CommunityMember = { username?: string; display_name?: string | null; source?: string };
type Community = { member_count?: number; members?: CommunityMember[] } | null;

/**
 * The made screen's line once an invite is out: who has joined (joinedLine),
 * or, before anyone has, "✓ Invite sent."
 */
export function sentLines(joined: string | null): string[] {
  return [joined || tr("auth:invite_sent_4aa0288f")];
}

/**
 * Who has joined since the invite went out, from GET /api/apps/:slug/community
 * (`members` is the newest few, the maker first as 'creator'; `member_count`
 * is everyone): "✓ Sam joined.", "✓ Sam and Alex joined.", "✓ 3 people
 * joined.", or null while nobody has.
 */
export function joinedLine(community: Community): string | null {
  const members = Array.isArray(community?.members) ? community!.members : [];
  const others = members.filter((m) => m && m.source !== 'creator' && (m.display_name || m.username));
  const counted = Number.isInteger(community?.member_count)
    ? Number(community!.member_count) - (members.length > others.length ? 1 : 0) : 0;
  const count = Math.max(others.length, counted);
  if (count <= 0) return null;
  const named = (m: CommunityMember) => m.display_name || m.username;
  if (count === 1 && others.length === 1) return tr("auth:value1_joined_2fcc8fe7", { value1: named(others[0]) });
  if (count === 2 && others.length === 2) return tr("auth:value1_and_value2_joined_bbe11f6c", { value1: named(others[0]), value2: named(others[1]) });
  return tr("auth:value1_people_joined_0e5634f1", { value1: count });
}

const JOINED_POLL_MS = 10000;

/** The project's community, read again while an invite is out, so a join shows. */
function useCommunity(slug: string, on: boolean): Community {
  const [community, setCommunity] = useState<Community>(null);
  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    const read = () => fetch(`/api/apps/${encodeURIComponent(slug)}/community`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (live && data) setCommunity(data); })
      .catch(() => {});
    read();
    const t = window.setInterval(read, JOINED_POLL_MS);
    return () => { live = false; window.clearInterval(t); };
  }, [slug, on]);
  return community;
}

export function MadeScreen({ made, me, onContinue, onOpenChat }: {
  made: Made;
  me: string;
  /** "Invite people later" / "Go to the Homeroom app": `skipped` when nothing went out. */
  onContinue: (skipped: boolean) => void;
  /** Go to chat, on the plan's card: the chat with Homeroom bot, where the plan is answered. */
  onOpenChat: (conversationId: number | null) => void;
}) {
  useUiLanguage();
  const [fv, setFv] = useState<FirstVersion>(null);
  const [appStatus, setAppStatus] = useState<string | null>('creating');
  const [inviting, setInviting] = useState(false);
  const [sent, setSent] = useState(false);
  // Whether a first version has been read as on its way: once it has, a read
  // without one means it is live (or came to something else), and the
  // project is no longer "being made" (makerLine).
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () => fetch(madeAppUrl(made.slug), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const app = madeAppOf(body);
        if (live && app) {
          setFv(app.firstVersion);
          setAppStatus(app.status);
          if (app.firstVersion && !app.firstVersion.ready) setBuilding(true);
        }
      })
      .catch(() => {});
    read();
    const t = window.setInterval(read, 10000);
    return () => { live = false; window.clearInterval(t); };
  }, [made.slug]);

  const community = useCommunity(made.slug, sent);
  const joined = joinedLine(community);
  const plan = waitingPlan(fv);
  // Not live yet: nothing read, still on its way, or up for approval.
  const making = !(building && !fv);

  const botBuilds = made.conversationId != null;
  // WP-E: "Get a ping when it's ready?" in the Homeroom app, now that there
  // is something to be pinged about (features/dialogs/ping-ask.ts: it shows
  // nothing on the web, or once the phone's answer is decided).
  useEffect(() => { if (botBuilds) askForPingWhileBotBuilds(); }, [botBuilds]);
  const note = buildNote(botBuilds, !!plan);
  const sketch = useSketch(made.slug);
  const line = buildLine(fv, appStatus, botBuilds);
  // Something is under way: the project being set up, or the bot's build
  // (not while its plan waits on them: then nothing is).
  const busy = appStatus === 'creating' || (botBuilds && !(fv && fv.ready) && !plan);
  const tile = sketch.card?.emoji || made.emoji || made.name.slice(0, 1);
  return (
    <div
      role="dialog"
      aria-labelledby="first-session-made-title"
      data-first-session-made=""
      className="fixed inset-0 z-[9000] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100"
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      <div className="flex h-[52px] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)]">
        <Wordmark className="h-6 w-auto text-[color:var(--brand-ink)]" />
      </div>
      <div className="mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))]">
        {showsCard(sketch.state) ? (
          <SketchCard made={made} sketch={sketch} line={line} note={note} busy={busy} botBuilds={botBuilds} built={!making || !!(fv && fv.ready)} />
        ) : (
          <div className="mt-4 flex flex-col items-center rounded-[20px] bg-white px-6 py-7 text-center shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
            <span className="app-icon-tile flex h-20 w-20 items-center justify-center rounded-[22px] text-5xl" aria-hidden="true">{tile}</span>
            <h1 id="first-session-made-title" className="mt-3 text-[22px] font-extrabold leading-tight">{made.name}</h1>
            {made.description ? <p className="mt-1 text-[15px] text-zinc-500 dark:text-zinc-400">{made.description}</p> : null}
            <div className="mt-4 flex items-center gap-2 text-[14px] text-zinc-600 dark:text-zinc-300">
              {busy ? <span className="status-dot creating" aria-hidden="true" /> : null}
              <span data-first-session-build="">{line}</span>
            </div>
            <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{note}</p>
          </div>
        )}
        {/* Under the project, never above it: the sketch stays where it is when the plan lands. */}
        {plan ? <PlanWaitsCard name={made.name} onOpenChat={() => onOpenChat(plan.conversationId ?? made.conversationId)} /> : null}
        <div className="mt-6">
          <p className="text-[17px] font-semibold"><LocalizedValue render={() => (tr("auth:invite_people_to_value1_847cd1ff", { value1: made.name }))} /></p>
          <p className="mt-0.5 text-[14px] leading-snug text-zinc-500 dark:text-zinc-400"><Message id="auth:they_can_follow_along_and_chat_with_you_while_it_637651af" /></p>
          {sent ? sentLines(joined).map((line) => (
            <p key={line} data-first-session-sent={joined ? 'joined' : ''} className="mt-2 text-[14px] font-semibold text-emerald-700 dark:text-emerald-400">
              {line}
            </p>
          )) : null}
        </div>
        <div className="grow" />
        <div className="mt-6 flex flex-col gap-2.5">
          <Button type="button" onClick={() => setInviting(true)} layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="flex items-center justify-center"><Message id="auth:share_invite_a8da10e5" /></Button>
          <button
            type="button"
            data-first-session-continue=""
            onClick={() => onContinue(!sent)}
            className="flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            <LocalizedValue render={() => (sent ? tr("auth:go_to_the_homeroom_app_8e0abf15") : tr("auth:invite_people_later_9acf0464"))} />
          </button>
        </div>
      </div>
      {inviting ? (
        <InviteSheet
          made={sketch.card ? { ...made, emoji: sketch.card.emoji } : made}
          me={me}
          making={making}
          onClose={() => setInviting(false)}
          onSent={() => { setSent(true); setInviting(false); }}
        />
      ) : null}
    </div>
  );
}
