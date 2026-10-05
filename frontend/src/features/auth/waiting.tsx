import { getLanguage } from "../../lib/i18n/runtime";
import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
/**
 * `#auth-waiting-screen` — the platform-access gate (#1080, step 2 chunk C,
 * screen 4 of 6).
 *
 * An authed session WITHOUT `hasPlatformAccess` lands here instead of the
 * shell. The screen polls `/api/auth/me` every 30s and, the moment access is
 * granted, boots the full shell in place — the same reload-free handover login
 * uses, so a released user never has to know to refresh.
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
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { inviteTokenFrom } from './invite-card';
import { AUTH_SCREEN_IDS, fx, legacy, useAuthScreensPatch } from './shared';

/** How often to re-check for release. */
const POLL_MS = 30000;

interface MeUser {
  username?: string;
  hasPlatformAccess?: boolean;
}

export function WaitingScreen() {
  useUiLanguage();
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.waiting, false);
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.waiting);

  const [who, setWho] = useState('');
  const [checkState, setCheckState] = useState('');
  // The communities this account's invite links queued for the day it is
  // let in (src/services/community-invites.js). Empty until loaded, and
  // for most people forever.
  const [queued, setQueued] = useState<Array<{ name: string; inviter: string | null }>>([]);

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
      setWho(user.username || '');
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
        fx(() => {
          (host?.hideAll as undefined | (() => void))?.();
          w.App?.enterAuthed?.(user);
        }, 'pop');
        return;
      }
      setCheckState(tr("auth:last_checked_a0044d86") + new Date().toLocaleTimeString(getLanguage()));
    } catch {
      setCheckState(tr("auth:connection_issue_will_retry_77c78259"));
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
      const res = await fetch('/api/invite-links/queued', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = await res.json();
      setQueued(Array.isArray(body?.queued) ? body.queued : []);
    } catch {
      /* the waiting room works without it */
    }
  }, []);

  const waitingOnShow = useCallback(() => {
    setWho(legacy().App?.user?.username || '');
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
      <div className="min-h-full flex items-center justify-center">
        <div className="w-full max-w-sm px-6 py-16 text-center">
          <h1 className="text-[28px] font-extrabold leading-tight tracking-tight mb-1 text-zinc-900 dark:text-zinc-100"><Message id="auth:you_re_in_the_queue_38c934d4" /></h1>
          <p className="text-[15px] text-zinc-500 dark:text-zinc-400 mb-8 italic"><Message id="auth:homeroom_c9149977" /></p>
          <div className="rounded-2xl bg-white dark:bg-zinc-900 p-5 text-left space-y-3">
            <p className="text-[17px] leading-snug text-zinc-900 dark:text-zinc-100">
              <Message id="auth:your_account_ce511b79" />
              <span id="waiting-who" className="font-semibold">
                {who}
              </span>
              <Message id="auth:doesn_t_have_platform_access_yet_we_let_people_i_5c9eaea2" />
            </p>
            <p className="text-[15px] text-zinc-500 dark:text-zinc-400"><Message id="auth:this_page_checks_for_you_every_so_often_you_can__e57a8cc2" /></p>
            <p id="waiting-check-state" className="text-[15px] text-zinc-500 dark:text-zinc-500">
              {checkState}
            </p>
          </div>
          {queued.length ? (
            <div data-waiting-queued="" className="mt-3 rounded-2xl bg-white dark:bg-zinc-900 p-5 text-left">
              <p className="text-[15px] font-[650] text-zinc-900 dark:text-zinc-100"><Message id="auth:when_you_re_let_in_7662a01c" /></p>
              <ul className="mt-1 space-y-1 text-[15px] text-zinc-600 dark:text-zinc-300">
                {queued.map((q) => (
                  <li key={q.name}>
                    <LocalizedValue render={() => (tr("auth:you_join_value1_value2_742d3c7d", { value1: q.name, value2: q.inviter ? tr("auth:message_c2cc93b976bb", { username: q.inviter }) : '' }))} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {/*
              QA 2026-09-24 Q12: this used to open with a violet "Use apps
              while you wait" pill to `#landing`. The landing stopped listing
              apps when its directory grid was removed (landing.tsx,
              `landingTileFor`), and for a waiting-room session it shows one
              pill, "Your queue status", back to this screen: the promise led
              in a circle. Nothing a waiting-room account can reach lists apps
              today, so the pill is gone rather than pointed at something that
              does not exist. Log out is the one action left.
          */}
          <div className="mt-6 space-y-3">
            <button
              id="waiting-logout"
              className="flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              onClick={onLogout}
            ><Message id="auth:log_out_49616145" /></button>
          </div>
        </div>
      </div>
        </>
      ) : null}
    </main>
  );
}
