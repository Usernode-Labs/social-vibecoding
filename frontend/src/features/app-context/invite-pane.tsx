import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * Invite — the third pane of the app-context sheet: a link to this project
 * that anyone can use to join it (/invite/<token>,
 * src/services/community-invites.js).
 *
 * ── What it does, in order ────────────────────────────────────────────
 *
 *   1. THE LINK. Your newest live link for this project, or a new one made
 *      the first time you open the pane: opening it again does not mint
 *      another. Copy, and Share where the device has a share sheet.
 *   2. WHAT IT DOES, in one sentence: who can use it, for how long, for how
 *      many people, and — what a new person meets — that somebody new to
 *      Homeroom joins the waitlist first and this project when let in.
 *   3. CHANGE. How long and for how many, within the server's limits; a new
 *      link is made with them. The old one keeps working until turned off.
 *   4. YOUR LINKS. Every live one, with Turn off. Someone who manages the
 *      project sees everyone's, with who made each.
 *
 * ── It is a PANE, for About's reason ──────────────────────────────────
 *
 * The kit cannot present a sheet while it is still dismissing another, and
 * inviting is where this menu goes rather than something opened over it
 * (./about-pane.tsx). The header row's back arrow is the way back.
 *
 * ── It opens at its own height, once ─────────────────────────────────
 *
 * The sheet goes up at the height it first renders at, so the pane's first
 * render is as tall as it will be. `AppContext.openInvite()` reads the state
 * before presenting (./invite-data.ts) and the pane starts from that answer;
 * when the read is slow, it starts from InviteSkeleton, the loaded pane's own
 * rows in grey. It never starts from a one-line note that grows: that was a
 * short sheet that rose a second time, with the dim fading in twice.
 *
 * Nothing here is in the prerender: `view` is 'menu' there, so the pane only
 * ever renders on the client, and its data loads in an effect (or arrived
 * before it mounted).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { CopyIcon, ShareIcon } from '@/components/ui/icons';
import { Input, inputVariants } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import {
  forgetPreparedInvite,
  inviteApi,
  inviteLinksUrl,
  prepareInvite,
  preparedInvite,
  readInviteState,
  type InviteLink,
  type InviteOutcome,
  type InviteState,
} from './invite-data';
import { daysUntil } from './invite-model';

export type { InviteLink, InviteState } from './invite-data';

const ROW = 'flex items-center gap-3 px-5 min-h-[44px] text-sm w-full text-left '
  + 'text-zinc-700 dark:text-zinc-200';
const SECTION = 'px-5 pt-4 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide '
  + 'text-zinc-400 dark:text-zinc-500';
const NOTE = 'px-5 py-2 text-sm text-zinc-500 dark:text-zinc-400';
const TITLE = 'text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100';
// The small lines under the link: what it does, who is new, the joining rule.
const SMALL = 'text-[0.8125rem] leading-snug';
const CHANGE_ROW = 'w-full px-5 min-h-[40px] text-left text-sm font-medium';
const PRIMARY = 'inline-flex flex-1 basis-0 min-w-0 items-center justify-center gap-1.5 h-10 px-4 '
  + 'rounded-full text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors';
const SECONDARY = 'inline-flex flex-1 basis-0 min-w-0 items-center justify-center gap-1.5 h-10 px-4 '
  + 'rounded-full text-sm font-semibold bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-800 '
  + 'dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100 transition-colors';

// 0 asks for no limit (WP-D): no end date, or any number of people.
const NO_LIMIT = 0;
const DAY_CHOICES = [1, 7, 30, NO_LIMIT];
const USE_CHOICES = [1, 5, 10, 25, 50, 100, NO_LIMIT];

/** The sentence under the link. */
export function linkSentence(link: Pick<InviteLink, 'expiresAt' | 'maxUses' | 'uses'>, grant: string, now = Date.now()): string {
  const who = grant === 'collaborator'
    ? tr("apps:anyone_with_this_link_can_join_and_build_with_yo_14dcc368")
    : tr("apps:anyone_with_this_link_can_join_f3b51368");
  if (link.expiresAt == null && link.maxUses == null) return tr("apps:value1_it_works_until_you_turn_it_off_00f04b7b", { value1: who });
  const days = link.expiresAt == null ? null : daysUntil(link.expiresAt, now);
  const when = days == null ? tr("apps:it_has_no_end_date_4feb5001") : days <= 1 ? tr("apps:it_expires_within_a_day_46a0d7e2") : tr("apps:it_expires_in_value1_days_22f7b48e", { value1: days });
  if (link.maxUses == null) return `${who} ${when}.`;
  // Before anyone has used it, the number it was made for; after, what is
  // left of it.
  const count = link.uses ? Math.max(0, link.maxUses - link.uses) : link.maxUses;
  const more = link.uses ? ' more' : '';
  return tr("apps:value1_value2_and_works_for_count_value4_people_8af220ef", { value1: who, value2: when, count: count, value4: more });
}

/** "3 of 25 used · 5 days left", for a row of Your links. */
export function linkDetail(link: Pick<InviteLink, 'expiresAt' | 'maxUses' | 'uses'>, now = Date.now()): string {
  const used = link.maxUses == null ? tr("apps:value1_joined_9ccfce0f", { value1: link.uses }) : tr("apps:value1_of_value2_used_baced1a0", { value1: link.uses, value2: link.maxUses });
  if (link.expiresAt == null) return tr("apps:value1_no_end_date_b85e817d", { value1: used });
  const days = daysUntil(link.expiresAt, now);
  return `${used} · ${days <= 1 ? tr("apps:under_a_day_left_add5bd90") : tr("apps:value1_days_left_14f91809", { value1: days })}`;
}

/** The line about people new to Homeroom. */
export function newcomerLine(skipsLeft: number | null): string {
  if (skipsLeft && skipsLeft > 0) {
    return tr("apps:you_can_let_count_people_new_to_homeroom_skip_th_3fad3e4e", { count: skipsLeft });
  }
  return tr("apps:someone_new_to_homeroom_joins_the_waitlist_first_cda30a49");
}

function absolute(path: string): string {
  try { return new URL(path, window.location.origin).toString(); } catch { return path; }
}

/**
 * One line of text that has not arrived: as tall as the line it stands for
 * (the zero-width space takes its height from the type around it), with a
 * bar across it.
 */
function SkeletonLine({ className, shape = 'muted' }: { className: string; shape?: 'line' | 'muted' }): ReactNode {
  return (
    <span className="flex items-center">
      {'\u200b'}
      <Skeleton shape={shape} className={className} />
    </span>
  );
}

/**
 * The pane before its link has come: the loaded pane's own rows, in grey, so
 * the sheet that goes up around it is already the height it stays. Only when
 * the read outlasts the opener's wait (AppContext.openInvite); otherwise the
 * pane's first render is the loaded one.
 *
 * Each row keeps the container, padding and type of the row it stands for,
 * so its height comes from the same classes rather than a copied number: the
 * link field is the Input's own box, the buttons are h-10 like Copy and
 * Share, the lines are the small paragraphs' lines. What it cannot know is
 * how many links there are and how long each sentence runs, so it draws the
 * common case: one link of their own, two lines each for what the link does,
 * who is new, and the joining rule.
 */
export function InviteSkeleton({ label, canShare }: { label: string; canShare: boolean }): ReactNode {
  return (
    <div id="app-invite-pane" className="pb-2" data-invite-loading="">
      <div className="px-5 pt-1">
        <div className={TITLE}><LocalizedValue render={() => (tr("apps:invite_people_to_value1_847cd1ff", { value1: label }))} /></div>
      </div>
      {/* The pulse is opacity alone, on the compositor, and still under
          reduced motion. */}
      <SkeletonGroup label={catalogText("apps:making_your_link_cb9ae30b")} className="motion-reduce:animate-none">
        <div className="px-5 pt-3">
          <div className={inputVariants()}>
            <SkeletonLine shape="line" className="w-3/4" />
          </div>
        </div>
        <div className={`px-5 pt-2 ${SMALL}`}>
          <SkeletonLine className="w-full" />
          <SkeletonLine className="w-1/2" />
        </div>
        <div className="flex items-stretch gap-2 px-5 pt-3">
          <Skeleton shape="block" className="h-10 flex-1 basis-0 rounded-full" />
          {canShare ? <Skeleton shape="block" className="h-10 flex-1 basis-0 rounded-full" /> : null}
        </div>
        <div className={`px-5 pt-3 ${SMALL}`}>
          <SkeletonLine className="w-full" />
          <SkeletonLine className="w-2/5" />
        </div>
        <div className={`px-5 pt-2 ${SMALL}`}>
          <SkeletonLine className="w-full" />
          <SkeletonLine className="w-3/5" />
        </div>
        <div className={`flex items-center ${CHANGE_ROW}`}>
          <Skeleton className="w-1/2" />
        </div>
        <div className={SECTION}>
          <SkeletonLine shape="line" className="w-16" />
        </div>
        <div className={ROW}>
          <Skeleton className="w-2/5" />
          <Skeleton className="ml-auto w-12" />
        </div>
      </SkeletonGroup>
    </div>
  );
}

export function InvitePane({ slug, label }: { slug: string | null; label: string }) {
  useUiLanguage();
  // What AppContext.openInvite() read before the sheet went up, when it came
  // in time: the pane's first render is then the loaded one.
  const [prepared] = useState<InviteOutcome | null>(() => (slug ? preparedInvite(slug) : null));
  const fromOpener = useRef(prepared != null);
  const [state, setState] = useState<InviteState | null>(prepared?.state ?? null);
  const [error, setError] = useState<string | null>(prepared?.error ?? null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [changing, setChanging] = useState(false);
  const [days, setDays] = useState(prepared?.state?.defaults.days ?? 7);
  const [uses, setUses] = useState(prepared?.state?.defaults.maxUses ?? 25);

  const base = slug ? inviteLinksUrl(slug) : null;

  const apply = useCallback((next: InviteState) => {
    setState(next);
    setDays(next.defaults.days);
    setUses(next.defaults.maxUses);
  }, []);

  // After a change of theirs (a new link, one turned off): read it again.
  const load = useCallback(async () => {
    if (!slug) return;
    setError(null);
    try {
      apply(await readInviteState(slug, false));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [slug, apply]);

  // Opening: the opener's read, taken whole when it came in time, else joined
  // where it is (it may be making their first link, so it is never started
  // twice). Reached without the opener, this starts it.
  useEffect(() => {
    if (!slug) return undefined;
    if (fromOpener.current) {
      fromOpener.current = false;
      forgetPreparedInvite();
      return undefined;
    }
    let live = true;
    void prepareInvite(slug).then((outcome) => {
      if (!live) return;
      forgetPreparedInvite();
      if (outcome.state) apply(outcome.state);
      else setError(outcome.error);
    });
    return () => { live = false; };
  }, [slug, apply]);

  const current = state?.links.find((l) => l.mine) || null;
  const url = current ? absolute(current.path) : '';

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(tr("apps:could_not_copy_press_and_hold_the_link_to_copy_i_dac2f281"));
    }
  };
  const share = async () => {
    if (!url || typeof navigator.share !== 'function') return;
    try { await navigator.share({ get title() { return tr("apps:join_value1_on_homeroom_f4436c83", { value1: label }); }, url }); } catch { /* dismissed */ }
  };
  const make = async () => {
    if (!base) return;
    setBusy(true);
    setError(null);
    try {
      await inviteApi(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, maxUses: uses }),
      });
      setChanging(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async (link: InviteLink) => {
    setBusy(true);
    setError(null);
    try {
      await inviteApi(`/api/invite-links/${link.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  if (!slug) return <div id="app-invite-pane"><p className={NOTE}><Message id="apps:open_a_project_to_invite_people_to_it_96c1e967" /></p></div>;
  if (!state && error) {
    return (
      <div id="app-invite-pane">
        <p className={NOTE}>{error}</p>
      </div>
    );
  }
  if (!state) return <InviteSkeleton label={label} canShare={canShare} />;
  if (!state.canCreate) {
    return (
      <div id="app-invite-pane">
        <p className={NOTE}>
          <LocalizedValue render={() => (state.grant === 'collaborator'
            ? tr("apps:only_the_people_building_value1_can_invite_other_f7b43cca", { value1: label })
            : tr("apps:join_value1_to_invite_people_to_it_5a22e9d5", { value1: label }))} />
        </p>
      </div>
    );
  }
  return (
    <div id="app-invite-pane" className="pb-2">
      <div className="px-5 pt-1">
        <div className={TITLE}>
          <LocalizedValue render={() => (tr("apps:invite_people_to_value1_847cd1ff", { value1: label }))} />
        </div>
      </div>
      {current ? (
        <>
          <div className="px-5 pt-3">
            <Localized element={<Input
              id="app-invite-url"
              readOnly
              value={url} aria-label={catalogText("apps:invite_link_826c2722")}
              onFocus={(e) => e.currentTarget.select()}
            />} messages={{"aria-label":"apps:invite_link_826c2722"}} />
          </div>
          <p id="app-invite-sentence" className={`px-5 pt-2 ${SMALL} text-zinc-600 dark:text-zinc-300`}>
            {linkSentence(current, state.grant)}
          </p>
          <div className="flex items-stretch gap-2 px-5 pt-3">
            <button id="app-invite-copy" type="button" className={PRIMARY} onClick={copy}>
              <CopyIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="truncate"><LocalizedValue render={() => (copied ? tr("apps:copied_8d525e5f") : tr("apps:copy_link_dbf362d4"))} /></span>
            </button>
            {canShare ? (
              <button id="app-invite-share" type="button" className={SECONDARY} onClick={share}>
                <ShareIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate"><Message id="apps:share_29887a5f" /></span>
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      <p className={`px-5 pt-3 ${SMALL} text-zinc-500 dark:text-zinc-400`}>
        {newcomerLine(state.skipsLeft)}
      </p>
      {state.joiningRule ? (
        <p data-invite-rule="" className={`px-5 pt-2 ${SMALL} text-zinc-500 dark:text-zinc-400`}>
          {state.joiningRule}
        </p>
      ) : null}
      {error ? <p role="alert" className="px-5 pt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      {changing ? (
        <div id="app-invite-change" className="px-5 pt-4 space-y-3">
          <label className="block text-sm text-zinc-700 dark:text-zinc-200">
            <span className="block pb-1"><Message id="apps:expires_after_a5e4b9f5" /></span>
            <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {DAY_CHOICES.filter((d) => d === NO_LIMIT || (d >= state.limits.minDays && d <= state.limits.maxDays)).map((d) => (
                <option key={d} value={d}><LocalizedValue render={() => (d === NO_LIMIT ? tr("apps:until_you_turn_it_off_e8a440c9") : d === 1 ? tr("apps:1_day_fa665d95") : tr("apps:value1_days_f766f83d", { value1: d }))} /></option>
              ))}
            </Select>
          </label>
          <label className="block text-sm text-zinc-700 dark:text-zinc-200">
            <span className="block pb-1"><Message id="apps:works_for_dd8110e9" /></span>
            <Select value={String(uses)} onChange={(e) => setUses(Number(e.target.value))}>
              {USE_CHOICES.filter((n) => n === NO_LIMIT || (n >= state.limits.minUses && n <= state.limits.maxUses)).map((n) => (
                <option key={n} value={n}><LocalizedValue render={() => (n === NO_LIMIT ? tr("apps:anyone_with_the_link_5b7f7017") : n === 1 ? tr("apps:1_person_de545d07") : tr("apps:value1_people_80ea6fd0", { value1: n }))} /></option>
              ))}
            </Select>
          </label>
          <div className="flex items-stretch gap-2">
            <button type="button" className={SECONDARY} onClick={() => setChanging(false)}><Message id="apps:cancel_19766ed6" /></button>
            <button id="app-invite-make" type="button" className={PRIMARY} disabled={busy} onClick={make}><Message id="apps:make_new_link_7630d846" /></button>
          </div>
        </div>
      ) : (
        <button
          id="app-invite-change-open"
          type="button"
          className={`${CHANGE_ROW} text-violet-700 dark:text-violet-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors`}
          onClick={() => setChanging(true)}
        ><Message id="apps:change_how_long_or_how_many_20fabfc1" /></button>
      )}

      {state.links.length ? (
        <div id="app-invite-links">
          <h4 className={SECTION}><LocalizedValue render={() => (state.manages ? tr("apps:live_links_3401ecef") : tr("apps:your_links_219ee7d1"))} /></h4>
          {state.links.map((link) => (
            <div key={link.id} className={ROW} data-invite-link={link.id}>
              <span className="flex-1 min-w-0">
                <span className="block truncate">{linkDetail(link)}</span>
                {!link.mine && link.createdBy ? (
                  <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400"><LocalizedValue render={() => (tr("apps:by_value1_363778f7", { value1: link.createdBy }))} /></span>
                ) : null}
              </span>
              <button
                type="button"
                className="shrink-0 text-sm font-medium text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                disabled={busy}
                onClick={() => turnOff(link)}
              ><Message id="apps:turn_off_06f0e210" /></button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
