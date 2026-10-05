import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * Right after "Make it" (./make.tsx): something to give, and one thing to
 * do with it.
 *
 *   what      The project, being built: its tile and name, Homeroom bot's
 *             step from GET /api/apps/:slug (`first_version`, "Step 2 of 7:
 *             Read the description"), read again every ten seconds.
 *   plan      B6: once the bot has read the description it waits for its
 *             plan's Build it (`first_version.plan`) and builds nothing
 *             until then. The plan is drawn first, under "Needs you", as
 *             the same card as in the chat and on the App tab: Build it is
 *             decided here through the chat's own call, and Change
 *             something leaves for the chat with the plan quoted
 *             (./index.tsx). A plan built from here stays, chosen.
 *   invite    "Invite people to <name>": Share invite opens a short sheet
 *             (InviteSheet below). Once something has gone out, the line
 *             says so and "Invite people later" becomes "Go to the
 *             Homeroom app". Either starts the tour (./index.tsx). While
 *             it is out, the project's community is read again, and the
 *             line says who has joined (joinedLine).
 *
 * The sheet is the first invite, not the project's full invite pane
 * (features/app-context/invite-pane.tsx, with live links and their limits,
 * which stays where it is): what they'll get, with the note edited in place,
 * then Share link; a username sits behind one button. The link it makes
 * works until it is turned off, for anyone it reaches (WP-D) — the project
 * is the gift, so the link should outlive a week. Under it, one line on what
 * joining means, from the project's real rule (GET .../invite-links
 * `joiningRule`). The first note shared is also
 * the maker's first message in the group's chat (the sheet says so), so the
 * people it brings find it waiting there.
 *
 *   sketch    A sketch of its main screen (services/app-sketch.js), drawn
 *             from the description in about half a minute: "Sketching…" from
 *             GET /api/apps/:slug/sketch, read every two seconds, then the
 *             page itself in a frame with an empty `sandbox` (no script, its
 *             own origin). Without one (no description, no model, a reply
 *             that was not usable) the card shows the build as before.
 *
 * Every line says what is true for this project: when Homeroom bot builds
 * it (`made.conversationId`, its DM), its step and "messages you"; when it
 * does not, the description is the project's first request, for whoever
 * builds it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { askForPingWhileBotBuilds } from '../dialogs/ping-ask';
import { decideBotAction, MessagesApiError } from '../messages/api';
import { PlanCardView } from '../messages/bot-plan-view';
import type { HomeroomBotPlanQuestion } from '../messages/types';

import type { Made } from './make';

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
  /** WP-E: about how many minutes a build takes, while this one is not ready. */
  typicalMinutes?: number;
  /** B6: the plan waiting for Build it, for its creator (GET /api/apps/:slug). */
  plan?: Partial<WaitingPlan> | null;
} | null;

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

/** Over the plan: it is the one thing on the screen that waits on them. */
export const PLAN_LABEL = () => tr("workshop:needs_you_74b6abdf");

/** Under the plan, until Build it is tapped. */
export function planNote(name: string): string {
  return tr("auth:homeroom_bot_starts_building_value1_when_you_tap_98ef5703", { value1: name });
}

/** "Step 2 of 7: Read the description", or what to say without a build. */
export function buildLine(fv: FirstVersion, appStatus: string | null, botBuilds = true): string {
  if (fv && fv.ready) return tr("auth:version_one_is_ready_to_try_bbe53bf2");
  if (fv && fv.step && fv.of) return tr("auth:step_value1_of_value2_value3_8acfce48", { value1: fv.step, value2: fv.of, value3: fv.stepName ? `: ${fv.stepName}` : '' });
  if (appStatus === 'creating') return tr("auth:setting_it_up_a5a8341a");
  return botBuilds ? tr("auth:homeroom_bot_builds_it_from_your_description_594b8440") : tr("auth:your_description_is_its_first_request_e08683bb");
}

/**
 * The line under the build's: who tells them, or who builds it. WP-E: and,
 * while it is building, about how long that usually takes. B6: while its
 * plan waits, that nothing happens until they say so.
 */
export function buildNote(botBuilds: boolean, minutes: number | null = null, planWaits = false): string {
  if (!botBuilds) return tr("auth:you_or_anyone_you_invite_can_build_it_from_there_f3222583");
  if (planWaits) return 'Homeroom bot is waiting for your go-ahead.';
  return minutes && minutes > 0
    ? tr("auth:homeroom_bot_messages_you_when_it_s_ready_to_try_6b46ca8d", { value1: minutes })
    : tr("auth:homeroom_bot_messages_you_when_it_s_ready_to_try_87dee6a0");
}

export type SketchState = 'loading' | 'none' | 'pending' | 'ready' | 'failed';

/** Under the sketch: what it is, and what happens to it. */
export function sketchCaption(name: string, botBuilds: boolean): string {
  return botBuilds
    ? tr("auth:a_sketch_from_your_description_homeroom_bot_buil_7cab542f", { value1: name })
    : tr("auth:a_sketch_from_your_description_nothing_on_it_wor_beb3edff", { value1: name });
}

// Stop asking after this long: a sketch is drawn in well under a minute.
const SKETCH_POLL_MS = 2000;
const SKETCH_GIVE_UP_MS = 90 * 1000;

/** The shell's look, so the sketch is drawn in the same one. */
function useDarkClass(): boolean {
  const read = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** GET /api/apps/:slug/sketch until it is ready, failed, or there is none. */
function useSketch(slug: string): SketchState {
  const [state, setState] = useState<SketchState>('loading');
  useEffect(() => {
    let live = true;
    let timer = 0;
    const started = Date.now();
    const read = async () => {
      const data = await fetch(`/api/apps/${encodeURIComponent(slug)}/sketch`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!live) return;
      const status = data?.status;
      if (status === 'ready' || status === 'failed' || status === 'none') { setState(status); return; }
      // A read that failed is asked again; the card shows the build meanwhile.
      if (status === 'pending') setState('pending');
      if (Date.now() - started > SKETCH_GIVE_UP_MS) { setState((s) => (s === 'pending' ? 'failed' : s)); return; }
      timer = window.setTimeout(() => { void read(); }, SKETCH_POLL_MS);
    };
    void read();
    return () => { live = false; window.clearTimeout(timer); };
  }, [slug]);
  return state;
}

function SketchCard({ made, tile, sketch, line, botBuilds, busy, minutes, planWaits }: {
  made: Made;
  tile: string;
  sketch: 'pending' | 'ready';
  line: string;
  botBuilds: boolean;
  busy: boolean;
  minutes: number | null;
  planWaits: boolean;
}) {
  const dark = useDarkClass();
  return (
    <div data-first-session-sketch={sketch} className="mt-4 rounded-[20px] bg-white p-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
      <div className="flex items-center gap-3 px-1 pb-3">
        <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{tile}</span>
        <div className="min-w-0 flex-1">
          <h1 id="first-session-made-title" className="truncate text-[17px] font-semibold leading-snug">{made.name}</h1>
          <p className="flex items-center gap-1.5 text-[13px] text-zinc-500 dark:text-zinc-400">
            {busy ? <span className="status-dot creating" aria-hidden="true" /> : null}
            <span data-first-session-build="" className="truncate">{line}</span>
          </p>
        </div>
      </div>
      <div className="relative h-[380px] overflow-hidden rounded-[14px] bg-zinc-100 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800">
        {sketch === 'ready' ? (
          <LocalizedDynamic element={<iframe
            title={tr("auth:a_sketch_of_value1_1b50b7e2", { value1: made.name })}
            src={`/api/apps/${encodeURIComponent(made.slug)}/sketch.html?theme=${dark ? 'dark' : 'light'}`}
            sandbox=""
            referrerPolicy="no-referrer"
            className="h-full w-full border-0"
          />} resolve={() => ({ get "title"() { return tr("auth:a_sketch_of_value1_1b50b7e2", { value1: made.name }); } })} />
        ) : (
          <div role="status" className="flex h-full flex-col gap-4 p-5">
            <p className="pr-16 text-[14px] text-zinc-500 dark:text-zinc-400"><LocalizedValue render={() => (tr("auth:sketching_value1_from_your_description_b86a752c", { value1: made.name }))} /></p>
            <div className="h-6 w-2/3 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-20 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-11 w-1/2 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-24 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-700" />
          </div>
        )}
        <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[12px] font-semibold text-white"><Message id="auth:sketch_0f9b002d" /></span>
      </div>
      <p className="px-1 pt-2.5 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
        {sketch === 'ready' ? sketchCaption(made.name, botBuilds) : buildNote(botBuilds, minutes, planWaits)}
      </p>
    </div>
  );
}

const NOTE_DEFAULT = () => tr("workshop:come_try_it_with_me_6fb15c1a");
// WP-D: the link works until it is turned off, for anyone it is sent to (0 is
// no limit, services/community-invites.js NO_LIMIT): the project is the gift.
const LINK_DAYS = 0;
const LINK_USES = 0;

/** The note, posted once per project as the maker's first chat message. */
const postedKey = (slug: string) => `usernode:first-session:note-posted:${slug}`;

function InviteSheet({ made, me, onClose, onSent }: {
  made: Made;
  me: string;
  onClose: () => void;
  onSent: (to: string | null) => void;
}) {
  useUiLanguage();
  const [note, setNote] = useState(made.example?.note || NOTE_DEFAULT());
  const [byName, setByName] = useState(false);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [rule, setRule] = useState<string | null>(null);
  const linkRef = useRef<string | null>(null);
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  // WP-D: what joining means here, said from the project's real rule.
  useEffect(() => {
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(made.slug)}/invite-links`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (live && typeof data?.joiningRule === 'string') setRule(data.joiningRule); })
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
      const title = `${me ? tr("auth:value1_made_4dd7e32d", { value1: me }) : tr("core:made_45a5300c")} ${made.name}`;
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
      await postNote();
      onSent(null);
    } catch {
      setError(tr("auth:could_not_share_the_link_try_again_4954e198"));
    } finally {
      setBusy(false);
    }
  }, [busy, link, me, made.name, note, postNote, onSent]);

  const sendToUsername = useCallback(async () => {
    const handle = username.trim().replace(/^@/, '');
    if (!handle || busy) return;
    setBusy(true); setError(null); setStatus(null);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: handle }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || tr("auth:could_not_invite_them_aed7ba18")); return; }
      await postNote();
      setUsername('');
      onSent(`@${handle}`);
    } catch {
      setError(tr("auth:network_error_2a33d984"));
    } finally {
      setBusy(false);
    }
  }, [username, busy, made.slug, postNote, onSent]);

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
              <p className="text-[15px] font-semibold leading-snug">{`${me ? tr("auth:value1_made_4dd7e32d", { value1: me }) : tr("core:made_45a5300c")} ${made.name}`}</p>
              <p className="text-[13px] text-zinc-500 dark:text-zinc-400"><Message id="auth:a_link_to_see_it_and_join_the_chat_bd28e004" /></p>
            </div>
          </div>
          <div className="px-3 pb-2 pt-2.5 shadow-[inset_0_1px_0_var(--app-sheet-line)]">
            <label htmlFor="first-session-note" className="sr-only"><Message id="auth:your_note_5331e47d" /></label>
            <Localized element={<textarea
              id="first-session-note"
              rows={2}
              maxLength={280}
              value={note}
              onChange={(e) => setNote(e.target.value)} placeholder={catalogText("auth:add_a_note_optional_6bb0c6b3")}
              className="w-full resize-none border-0 bg-transparent p-0 text-[16px] leading-snug placeholder-zinc-500 focus:outline-none"
            />} messages={{"placeholder":"auth:add_a_note_optional_6bb0c6b3"}} />
          </div>
        </div>
        <p className="mt-2 text-[13px] text-zinc-500 dark:text-zinc-400"><Message id="auth:your_note_is_also_your_first_message_in_the_grou_210befcf" /></p>
        <div className="mt-4 flex flex-col gap-2.5">
          <Button type="button" onClick={() => { void shareLink(); }} disabled={busy} layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="flex items-center justify-center disabled:opacity-60"><Message id="auth:share_link_712a4823" /></Button>
          {byName ? (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void sendToUsername(); }}>
              <Localized element={<input
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)} placeholder={catalogText("auth:username_93100fc4")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 min-w-0 flex-1 rounded-full border-0 bg-white px-4 text-[16px] placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 dark:bg-zinc-800"
              />} messages={{"placeholder":"auth:username_93100fc4"}} />
              <Button type="submit" disabled={busy || !username.trim()} variant="pillAccent" size="pill" ink="solid" className="disabled:opacity-60"><Message id="auth:send_f6f4688f" /></Button>
            </form>
          ) : (
            <button type="button" onClick={() => setByName(true)} className="flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"><Message id="auth:invite_by_username_fefe06c7" /></button>
          )}
        </div>
        {status ? <p className="mt-3 text-center text-[14px] text-emerald-700 dark:text-emerald-400">{status}</p> : null}
        {error ? <p role="alert" className="mt-3 text-center text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
        <p className="mt-3 text-center text-[13px] text-zinc-500 dark:text-zinc-400"><Message id="auth:anyone_with_the_link_can_join_until_you_turn_it__4635ef3a" /></p>
        {rule ? <p data-first-session-rule="" className="mt-1 text-center text-[13px] text-zinc-500 dark:text-zinc-400">{rule}</p> : null}
      </div>
    </div>
  );
}

/**
 * B6: the plan, waiting for Build it, the same card as in the chat with
 * Homeroom bot and on the App tab. Build it is decided once on the server,
 * through the chat's own call (api.decideBotAction); Change something is
 * the screen's owner's (./index.tsx: the chat, with the plan quoted).
 */
export function PlanSection({ name, plan, onBuilt, onGone, onChange }: {
  name: string;
  plan: WaitingPlan;
  /** Built from here, with the answer each choice went with. */
  onBuilt: (plan: WaitingPlan, choices: string[]) => void;
  /** Decided somewhere else already, or replaced: read the project again. */
  onGone: () => void;
  onChange: () => void;
}) {
  useUiLanguage();
  const [pressed, setPressed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const build = useCallback(async (answers: Array<string | null>) => {
    if (pressed) return;
    setPressed(true);
    setError(null);
    try {
      await decideBotAction(plan.actionId, 'build', answers.map((a) => a || ''));
    } catch (err) {
      if (err instanceof MessagesApiError && err.status === 409) { onGone(); return; }
      setPressed(false);
      setError(tr("auth:couldn_t_start_building_just_now_try_again_b1ee2774"));
      return;
    }
    onBuilt(plan, plan.questions.map((q, i) => answers[i] || q.answers[0] || ''));
  }, [pressed, plan, onBuilt, onGone]);
  return (
    <section data-first-session-plan="open" aria-labelledby="first-session-plan-label" className="mt-4">
      <p id="first-session-plan-label" className="px-1 pb-1.5 text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{PLAN_LABEL()}</p>
      <PlanCardView
        surface="app"
        appName={name}
        plan={{ bullets: plan.bullets, questions: plan.questions }}
        state="open"
        busy={pressed}
        onBuild={(answers) => { void build(answers); }}
        onChange={onChange}
      />
      {pressed ? null : <p className="px-1 pt-2 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{planNote(name)}</p>}
      {error ? <p role="alert" className="px-1 pt-1 text-[13px] text-red-600 dark:text-red-400">{error}</p> : null}
    </section>
  );
}

type CommunityMember = { username?: string; display_name?: string | null; source?: string };
type Community = { member_count?: number; members?: CommunityMember[] } | null;

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

export function MadeScreen({ made, me, onContinue, onChangePlan }: {
  made: Made;
  me: string;
  /** "Invite people later" / "Go to the Homeroom app": `skipped` when nothing went out. */
  onContinue: (skipped: boolean) => void;
  /** Change something, under the plan: its chat with Homeroom bot, and the plan's message. */
  onChangePlan: (conversationId: number | null, messageId: number | null) => void;
}) {
  useUiLanguage();
  const [fv, setFv] = useState<FirstVersion>(null);
  const [appStatus, setAppStatus] = useState<string | null>('creating');
  const [inviting, setInviting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // B6: a plan built from here stays, chosen, so the screen says what was decided.
  const [chosen, setChosen] = useState<{ plan: WaitingPlan; choices: string[] } | null>(null);
  const readRef = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    const read = () => fetch(`/api/apps/${encodeURIComponent(made.slug)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((app) => { if (live && app) { setFv(app.first_version || null); setAppStatus(app.status || null); } })
      .catch(() => {});
    readRef.current = read;
    read();
    const t = window.setInterval(read, 10000);
    return () => { live = false; window.clearInterval(t); readRef.current = () => {}; };
  }, [made.slug]);

  const community = useCommunity(made.slug, sent);
  const joined = joinedLine(community);
  const waiting = waitingPlan(fv);
  // The plan to decide: one waiting that was not just built from here.
  const plan = waiting && waiting.actionId !== chosen?.plan.actionId ? waiting : null;
  const onBuilt = useCallback((built: WaitingPlan, choices: string[]) => {
    setChosen({ plan: built, choices });
    readRef.current();
  }, []);
  const onGone = useCallback(() => { readRef.current(); }, []);

  const botBuilds = made.conversationId != null;
  // WP-E: "Get a ping when it's ready?" in the Homeroom app, now that there
  // is something to be pinged about (features/dialogs/ping-ask.ts: it shows
  // nothing on the web, or once the phone's answer is decided).
  useEffect(() => { if (botBuilds) askForPingWhileBotBuilds(); }, [botBuilds]);
  const minutes = fv && !fv.ready && typeof fv.typicalMinutes === 'number' ? fv.typicalMinutes : null;
  const sketch = useSketch(made.slug);
  const line = buildLine(fv, appStatus, botBuilds);
  // Something is under way: the project being set up, or the bot's build
  // (not while its plan waits on them: then nothing is).
  const busy = appStatus === 'creating' || (botBuilds && !(fv && fv.ready) && !plan);
  const tile = made.emoji || made.name.slice(0, 1);
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
        {plan ? (
          <PlanSection
            key={plan.actionId}
            name={made.name}
            plan={plan}
            onBuilt={onBuilt}
            onGone={onGone}
            onChange={() => onChangePlan(plan.conversationId ?? made.conversationId, plan.messageId)}
          />
        ) : chosen ? (
          <div data-first-session-plan="built" className="mt-4">
            <PlanCardView surface="app" appName={made.name} plan={chosen.plan} state="built" choices={chosen.choices} />
          </div>
        ) : null}
        {sketch === 'pending' || sketch === 'ready' ? (
          <SketchCard made={made} tile={tile} sketch={sketch} line={line} botBuilds={botBuilds} busy={busy} minutes={minutes} planWaits={!!plan} />
        ) : (
          <div className="mt-4 flex flex-col items-center rounded-[20px] bg-white px-6 py-7 text-center shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
            <span className="app-icon-tile flex h-20 w-20 items-center justify-center rounded-[22px] text-5xl" aria-hidden="true">{tile}</span>
            <h1 id="first-session-made-title" className="mt-3 text-[22px] font-extrabold leading-tight">{made.name}</h1>
            {made.description ? <p className="mt-1 text-[15px] text-zinc-500 dark:text-zinc-400">{made.description}</p> : null}
            <div className="mt-4 flex items-center gap-2 text-[14px] text-zinc-600 dark:text-zinc-300">
              {busy ? <span className="status-dot creating" aria-hidden="true" /> : null}
              <span data-first-session-build="">{line}</span>
            </div>
            <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{buildNote(botBuilds, minutes, !!plan)}</p>
          </div>
        )}
        <div className="mt-6">
          <p className="text-[17px] font-semibold"><LocalizedValue render={() => (tr("auth:invite_people_to_value1_847cd1ff", { value1: made.name }))} /></p>
          <p className="mt-0.5 text-[14px] leading-snug text-zinc-500 dark:text-zinc-400"><Message id="auth:they_can_follow_along_and_chat_with_you_while_it_637651af" /></p>
          {sent ? (
            <p data-first-session-sent={joined ? 'joined' : ''} className="mt-2 text-[14px] font-semibold text-emerald-700 dark:text-emerald-400">
              <LocalizedValue render={() => (joined || tr("auth:invite_sent_value1_d60514ef", { value1: sentTo ? tr("auth:message_bc252627b50b", { recipient: sentTo }) : '' }))} />
            </p>
          ) : null}
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
          made={made}
          me={me}
          onClose={() => setInviting(false)}
          onSent={(to) => { setSent(true); if (to) setSentTo(to); setInviting(false); }}
        />
      ) : null}
    </div>
  );
}
