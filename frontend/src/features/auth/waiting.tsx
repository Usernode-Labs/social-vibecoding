/**
 * `#auth-waiting-screen` — the platform-access gate (#1080, step 2 chunk C,
 * screen 4 of 6).
 *
 * An authed session WITHOUT `hasPlatformAccess` lands here instead of the
 * shell. The screen polls `/api/auth/me` every 30s and, the moment access is
 * granted, boots the full shell in place — the same reload-free handover login
 * uses, so a released user never has to know to refresh.
 *
 * ── A group waiting for them, and a phone ─────────────────────────────
 *
 * An invite link this account followed queues its group (the list under
 * "When you're let in"). An invite lets in, as a private member, only an
 * account with a verified phone, so when the server offers phone sign-in
 * the screen offers the phone too (./add-phone.tsx): adding it joins the
 * queued groups now, and the check below lets them in to the first one's
 * app.
 *
 * ── The poll is not a mount effect ────────────────────────────────────
 *
 * It starts from `_waitingOnShow()` and stops from `_stopWaitingPoll()`, both
 * of which the router calls — `show()` stops it when navigating away from
 * `waiting`, and `hideAll()` stops it on the way into the authed shell. That
 * lifecycle is the router's, not the component's: this screen element stays
 * mounted for the whole session (all six do), so a mount effect would start
 * the poll for every visitor who never sees this screen. So the timer lives in
 * a ref driven by the patched hooks, and the only mount effect is the one that
 * clears it on unmount.
 *
 * ── The words (#4073) ──────────────────────────────────────────────────
 *
 * The onboarding canvas's waiting screen: the wordmark, "You're on the
 * waitlist", "We let people in a few at a time.", the invite box when a link
 * queued a community, and
 * Sign out. It does not promise an email: an account made by email code
 * has no waitlist row, so nothing would send one (#4083 makes every
 * newcomer get a spot and the email). The waitlist is said with its own words, waitlist, your spot,
 * a few at a time and access, and never queue, batches or your turn. The
 * line under the title was the account's username and "platform access",
 * and a status line said when the page last checked; both are gone. The
 * page still checks every 30 seconds, quietly, and a check that fails is
 * tried again on the next one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Wordmark } from '@/components/ui/wordmark';

import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { AddPhoneCard, type JoinedGroup } from './add-phone';
import { inviteTokenFrom } from './invite-card';
import { AUTH_SCREEN_IDS, fx, legacy, useAuthScreensPatch } from './shared';
import { waitlistOptions } from './waitlist-shared';

/** How often to re-check for release. */
const POLL_MS = 30000;

interface MeUser {
  username?: string;
  hasPlatformAccess?: boolean;
}

/**
 * `?shot=waiting` and `?shot=waiting-invite` (App._waitingShot in
 * public/js/app.js): this screen for the before/after shots, which no shot
 * persona reaches, since each one either has access or has no session. In a
 * shot the screen neither checks for access nor follows a link: `-invite`
 * draws the box for one queued community, the plain one draws none.
 */
export function waitingShot(search: string): 'plain' | 'invite' | null {
  let shot: string | null = null;
  try { shot = new URLSearchParams(search).get('shot'); } catch { /* no shot */ }
  if (shot === 'waiting') return 'plain';
  if (shot === 'waiting-invite') return 'invite';
  return null;
}

/** "Sunday Run Club", "A and B", "A, B and C": the invite box's names. */
export function namesLine(names: readonly string[]): string {
  if (names.length < 2) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function WaitingScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.waiting, false);
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.waiting);

  // The communities this account's invite links queued for the day it is
  // let in (src/services/community-invites.js). Empty until loaded, and
  // for most people forever.
  const [queued, setQueued] = useState<Array<{ name: string; inviter: string | null }>>([]);
  // Phone sign-in is set up (the waitlist options' phone_sign_in): a queued
  // group can be joined now by adding a phone (./add-phone.tsx).
  const [phoneOffered, setPhoneOffered] = useState(false);

  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopWaitingPoll = useCallback(() => {
    if (timer.current === null) return;
    clearInterval(timer.current);
    timer.current = null;
  }, []);

  const check = useCallback(async () => {
    const w = legacy();
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        // Session died while waiting — back to the login screen.
        stopWaitingPoll();
        if (w.App) {
          if (typeof w.App.enterAnonymous === 'function') await w.App.enterAnonymous();
        }
        location.hash = '#login';
        return;
      }
      const data = await res.json();
      const user: MeUser | undefined = data && data.user;
      if (!user) return;
      if (user.hasPlatformAccess) {
        // Released! Boot the full shell in place — same reload-free path as
        // login, including the deep link the visitor originally arrived with.
        stopWaitingPoll();
        const host = w.AuthScreens;
        const target = (host?._pendingHash as string) || '';
        if (host) host._pendingHash = '';
        const targetUrl = typeof host?.deepLinkUrl === 'function'
          ? host.deepLinkUrl(target) : '/' + target;
        history.replaceState(null, '', targetUrl);
        // Let in on a build that is behind the live one: move to it before
        // the signed-in shell starts, so the first-run screens are the live
        // build's (App._moveToLiveShell). Never resolves once it reloads.
        await w.App?._moveToLiveShell?.('signed-in');
        fx(() => {
          (host?.hideAll as undefined | (() => void))?.();
          w.App?.enterAuthed?.(user);
        }, 'pop');
        return;
      }
    } catch {
      /* tried again on the next poll */
    }
  }, [stopWaitingPoll]);

  const startWaitingPoll = useCallback(() => {
    if (timer.current !== null) return;
    void check();
    timer.current = setInterval(() => void check(), POLL_MS);
  }, [check]);

  // AN INVITE LINK OPENED FROM HERE. The shell routes a waiting account to
  // this screen whatever the address (App.enterAuthed), and showWaiting
  // keeps an invite link's token before it rewrites the address to
  // #waiting. It is followed from this side, which only queues its
  // community — the redeem route is open to a waiting account for exactly
  // this (GATE_OPEN_PATHS). Following it twice spends nothing, so a sign-up
  // that already followed it server-side is not counted again. Then the
  // list.
  const followAndList = useCallback(async () => {
    try {
      const host = legacy().AuthScreens as { _waitingInvite?: string } | undefined;
      const token = (host && host._waitingInvite) || inviteTokenFrom(location.pathname);
      if (host) host._waitingInvite = '';
      if (token) {
        await fetch(`/api/invite-links/by-token/${encodeURIComponent(token)}/redeem`, {
          method: 'POST',
          credentials: 'same-origin',
        });
      }
      const [res, options] = await Promise.all([
        fetch('/api/invite-links/queued', { credentials: 'same-origin' }),
        waitlistOptions(),
      ]);
      setPhoneOffered(options?.phone_sign_in === true);
      if (!res.ok) return;
      const body = await res.json();
      setQueued(Array.isArray(body?.queued) ? body.queued : []);
    } catch {
      /* the waiting room works without it */
    }
  }, []);

  // A phone added from here joined its queued groups as a private member,
  // which /api/auth/me reports as access: check now, and land in the first
  // group's app, the way its invite's Join lands a newcomer (deepLinkUrl
  // takes an app path).
  const onJoined = useCallback((joined: JoinedGroup[]) => {
    const host = legacy().AuthScreens as { _pendingHash?: string } | undefined;
    if (host && joined[0]?.slug) host._pendingHash = `/app/${joined[0].slug}`;
    void check();
  }, [check]);

  const waitingOnShow = useCallback(() => {
    const shot = waitingShot(location.search);
    if (shot) {
      setQueued(shot === 'invite' ? [{ name: 'Sunday Run Club', inviter: null }] : []);
      return;
    }
    startWaitingPoll();
    void followAndList();
  }, [startWaitingPoll, followAndList]);

  const onLogout = useCallback(async () => {
    const w = legacy();
    // Settings.logout commits web logout/cache cleanup before its final hard
    // native boundary (or hard-navigates in a regular browser). Keep polling
    // alive if that preflight or web logout fails.
    if (w.Settings && typeof w.Settings.logout === 'function') {
      w.Settings.logout();
      return;
    }
    stopWaitingPoll();
    // Same sweep and same landing as Settings.logout (#1524): the wider
    // _dropCachedSession so no remembered header survives the sign-out, and a
    // REPLACE to a bare '/' so Back cannot restore the signed-in document and
    // no leftover query or fragment turns the landing page into a sign-in form.
    try {
      w.App?._dropCachedSession?.();
    } catch {
      /* ignore */
    }
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      /* ignore */
    }
    window.location.replace('/');
  }, [stopWaitingPoll]);

  const live = useRef({ waitingOnShow, startWaitingPoll, stopWaitingPoll });
  live.current = { waitingOnShow, startWaitingPoll, stopWaitingPoll };
  useAuthScreensPatch({
    _wireWaiting: () => {},
    _waitingOnShow: () => live.current.waitingOnShow(),
    // show() and hideAll() both drive these directly, so they stay part of
    // the screen's public surface rather than becoming private helpers.
    _startWaitingPoll: () => live.current.startWaitingPoll(),
    _stopWaitingPoll: () => live.current.stopWaitingPoll(),
  });

  // The only mount-scoped concern: never leave an interval behind.
  useEffect(() => () => stopWaitingPoll(), [stopWaitingPoll]);

  return (
    <main
      ref={rootRef}
      id="auth-waiting-screen"
      className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll"
    >
      {mounted ? (
        <>
        <div className="mx-auto flex min-h-full w-full max-w-sm flex-col px-6 pt-16 pb-9 text-center">
          <Wordmark className="mx-auto h-6 w-auto text-[color:var(--brand-ink)]" />
          <h1 className="mt-12 text-[30px] font-extrabold leading-[34px] text-zinc-900 dark:text-zinc-100">
            You're on the waitlist
          </h1>
          <p className="mt-3 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400">
            We let people in a few at a time.
          </p>
          {queued.length ? (
            <p data-waiting-queued="" className="mt-7 text-balance rounded-[20px] bg-white px-4 py-3.5 text-[15px] leading-5 text-zinc-600 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-300">
              {`When you get access, you join ${namesLine(queued.map((q) => q.name))}.`}
            </p>
          ) : null}
          {phoneOffered && queued.length ? (
            <AddPhoneCard groups={queued.map((q) => q.name)} onJoined={onJoined} />
          ) : null}
          {/*
              QA 2026-09-24 Q12: this used to open with a violet "Use apps
              while you wait" pill to `#landing`. The landing stopped listing
              apps when its directory grid was removed (landing.tsx,
              `landingTileFor`), and for a waiting-room session it shows one
              pill, "Your spot on the waitlist", back to this screen: the
              promise led in a circle. Nothing a waiting-room account can
              reach lists apps today, so the pill is gone rather than pointed
              at something that does not exist. Sign out is the one action
              left ("Sign out", as Settings says it, beside every "Sign in"),
              at the foot of the screen.
          */}
          <div className="grow" />
          <button
            id="waiting-logout"
            className="mt-8 flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            onClick={onLogout}
          >
            Sign out
          </button>
        </div>
        </>
      ) : null}
    </main>
  );
}
