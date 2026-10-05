import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
/**
 * The friend control on a person's page (#2386) — `#profile/<name>`, drawn
 * under the name for a signed-in viewer looking at someone else.
 *
 * Four states, from `friendship.state` on the profile payload the page
 * already fetched (routes/profiles.js), so it paints with the page and needs
 * no request of its own:
 *
 *   none      "Add friend"
 *   outgoing  "Requested" — a menu with Cancel request. A decline never
 *             changes this: the sender is not told (friendsButtonView).
 *   incoming  "Accept" + "Decline", side by side
 *   friends   "Friends ✓" — a menu with Unfriend
 *
 * Every write answers the new state (features/friends/api.ts), and the button
 * draws THAT, so a request the other person answered a moment ago lands on
 * the true state rather than an error. The menus go through PlatformUI.menu —
 * a bottom sheet on touch, an anchored popover on desktop — the shell's one
 * menu idiom (see features/dev-chat/session-header.tsx); a page without the
 * kit falls back to a confirm.
 *
 * The widget language's filled pills: accent for the one act the state asks
 * for (Add friend, Accept), neutral for everything else. No counts, ever —
 * nothing here knows how many friends anybody has.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { CheckIcon, ChevronDownIcon } from '@/components/ui/icons';
import {
  act,
  announceFriendsChanged,
  errorMessage,
  normalizeState,
  type FriendAction,
  type FriendState,
} from './api';

type MenuItem = { label: string; destructive: boolean; handler: () => void };

type PlatformUiLike = {
  hasKit?: () => boolean;
  toast?: (message: string) => unknown;
  menu?: (opts: { anchorEl?: HTMLElement; items: MenuItem[] }) => Promise<unknown>;
};

function platformUi(): PlatformUiLike | null {
  return (typeof window !== 'undefined'
    ? (window as unknown as { PlatformUI?: PlatformUiLike }).PlatformUI
    : null) || null;
}

/** What each state draws. Pure, for tests: the component only spells it. */
export function friendsButtonView(state: FriendState, username: string): {
  primary: { action: FriendAction | 'menu'; label: string; accent: boolean };
  secondary: { action: FriendAction; label: string } | null;
  menu: { action: FriendAction; label: string; confirm: string } | null;
} {
  switch (state) {
    case 'outgoing':
      return {
        primary: { action: 'menu', get label() { return tr("core:requested_2d9e2828"); }, accent: false },
        secondary: null,
        menu: { action: 'cancel', get label() { return tr("core:cancel_request_56196683"); }, confirm: tr("community:cancel_your_friend_request_to_value1_12988df6", { value1: username }) },
      };
    case 'incoming':
      return {
        primary: { action: 'accept', get label() { return tr("core:accept_89713b9c"); }, accent: true },
        secondary: { action: 'decline', get label() { return tr("core:decline_a2d285b3"); } },
        menu: null,
      };
    case 'friends':
      return {
        primary: { action: 'menu', get label() { return tr("core:friends_bd104d1b"); }, accent: false },
        secondary: null,
        menu: { action: 'unfriend', get label() { return tr("core:unfriend_dd56a057"); }, confirm: tr("community:unfriend_value1_they_won_t_be_told_684fd621", { value1: username }) },
      };
    default:
      return {
        primary: { action: 'request', get label() { return tr("core:add_friend_c1f87281"); }, accent: true },
        secondary: null,
        menu: null,
      };
  }
}

export function FriendButton({
  userId,
  username,
  initialState,
}: {
  userId: number;
  username: string;
  initialState: FriendState;
}): ReactNode {
  useUiLanguage();
  const [state, setState] = useState<FriendState>(normalizeState(initialState));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { alive.current = false; }, []);
  // A reload of the page hands a fresh state down; follow it.
  useEffect(() => { setState(normalizeState(initialState)); }, [initialState, userId]);

  const view = friendsButtonView(state, username);

  function report(message: string): void {
    const ui = platformUi();
    if (ui?.hasKit?.() && typeof ui.toast === 'function') ui.toast(message);
    else setError(message);
  }

  async function run(action: FriendAction): Promise<void> {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const next = await act(userId, action);
      if (!alive.current) return;
      setState(next);
      announceFriendsChanged();
    } catch (err) {
      if (alive.current) report(errorMessage(err, username));
    } finally {
      if (alive.current) setPending(false);
    }
  }

  async function openMenu(): Promise<void> {
    const item = view.menu;
    if (!item || pending) return;
    const ui = platformUi();
    if (ui && typeof ui.menu === 'function') {
      await ui.menu({
        anchorEl: primaryRef.current || undefined,
        items: [{ label: item.label, destructive: true, handler: () => { void run(item.action); } }],
      });
      return;
    }
    if (window.confirm(item.confirm)) await run(item.action);
  }

  const primary = view.primary;
  return (
    <div
      className="relative flex items-center gap-2"
      data-friend-button={username}
      data-friend-state={state}
    >
      <LocalizedDynamic element={<Button
        ref={primaryRef}
        type="button"
        size="sm"
        variant={primary.accent ? 'default' : 'neutral'}
        ink={primary.accent ? 'solid' : 'neutral'}
        data-friend-action={primary.action}
        aria-haspopup={primary.action === 'menu' ? 'menu' : undefined}
        aria-label={primary.action === 'menu' ? tr("core:value1_with_value2_more_options_336a3c71", { value1: primary.label, value2: username }) : undefined}
        disabled={pending}
        aria-busy={pending}
        className="inline-flex items-center gap-1.5 disabled:opacity-60"
        onClick={() => {
          if (primary.action === 'menu') void openMenu();
          else void run(primary.action);
        }}
      >
        <span>{primary.label}</span>
        {/* "Friends ✓" and "Requested ⌄": the trailing glyph says what the
            state is, and on Requested that it opens a menu. */}
        {state === 'friends' ? <CheckIcon aria-hidden="true" className="w-4 h-4" /> : null}
        {state === 'outgoing' ? <ChevronDownIcon aria-hidden="true" className="w-3.5 h-3.5" /> : null}
      </Button>} resolve={() => ({ "aria-label": primary.action === 'menu' ? tr("core:value1_with_value2_more_options_336a3c71", { value1: primary.label, value2: username }) : undefined })} />
      {view.secondary ? (
        <Button
          type="button"
          size="sm"
          variant="neutral"
          ink="neutral"
          data-friend-action={view.secondary.action}
          disabled={pending}
          className="disabled:opacity-60"
          onClick={() => { void run(view.secondary!.action); }}
        >
          {view.secondary.label}
        </Button>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="absolute left-0 top-full z-10 mt-1 w-max max-w-[16rem] rounded-lg bg-white px-2 py-1 text-xs text-red-700 shadow-sm dark:bg-zinc-800 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
