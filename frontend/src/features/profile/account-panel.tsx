/**
 * The account group on the Profile screen — Settings, Admin & moderation, and
 * the two native rows.
 *
 * ── Why it is here ────────────────────────────────────────────────────
 *
 * All four lived in the hamburger drawer. The Streamlined Concept retired the
 * hamburger and the drawer went with it, which left Settings and Admin with
 * no entrance at all: their links existed in exactly one file, and nothing
 * opened that file. Profile is where they belong — it is already the screen
 * about the viewer rather than about an app, and "your settings" and "the
 * console you can reach because of who you are" are both statements about the
 * viewer.
 *
 * Home carries the entrance to THIS screen (features/home/panels/account.tsx),
 * so the chain is Home → Profile → Settings / Admin, each step a screen with
 * its own address and its own back arrow.
 *
 * ── The two native rows came along ────────────────────────────────────
 *
 * Node status and Wallet are native-app chrome absorbed into the platform
 * (NATIVE-BRIDGE.md). Both ship `hidden` and are revealed by their own stores
 * when the bridge reports the capability, so on the web they are absent and
 * this group is two rows. They kept their components and their modules —
 * ../header/node-pill.js and ../header/wallet-sheet.js still initialise from
 * the header island — and changed only their ids, because `drawer-row-*` on a
 * screen with no drawer is the kind of name that outlives everyone who
 * remembers what it referred to.
 */

import { useRef } from 'react';

import { CogIcon, ShieldCheckIcon } from '@/components/ui/icons';

import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { NodePillRow } from '../header/node-pill-row';
import { WalletRow } from '../header/wallet-row';

/** Matches the drawer pair's geometry — a 44px row, the platform minimum. */
const TILE = 'flex-1 min-w-0 flex items-center justify-center gap-2 min-h-[44px] rounded-xl '
  + 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 '
  + 'hover:bg-zinc-50 dark:hover:bg-zinc-800';

export function AccountPanel() {
  // Both flags arrive from classic modules through the visibility store —
  // App.renderAdminButton for the console, settings.js for the BYOK dot — and
  // both elements ship `hidden` with a CONSTANT className, which is what makes
  // a `hidden` toggle from outside React sanctioned rather than a second
  // owner. See the note on each writer.
  const adminRef = useRef<HTMLAnchorElement | null>(null);
  const byokRef = useRef<HTMLSpanElement | null>(null);
  useVisibilityHiddenClass(adminRef, 'profile-row-admin', false);
  useVisibilityHiddenClass(byokRef, 'profile-byok-dot', false);
  return (
    <section id="profile-account" className="mt-6">
      <div className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mb-2">
        Account
      </div>
      {/*
          Native only — both ship hidden and their stores reveal them when the
          bridge reports the capability. On the web this renders nothing.
      */}
      <NodePillRow />
      <WalletRow />
      <div className="flex gap-3">
        <a
          id="profile-row-settings"
          href="#settings"
          className={TILE}
        >
          <CogIcon className="w-4 h-4 shrink-0" />
          <span className="text-sm font-medium">
            Settings
          </span>
          {/* The BYOK dot — lit when the viewer has their own API key.
              settings.js publishes the flag; see the subscription above. */}
          <span
            ref={byokRef}
            id="profile-byok-dot"
            className="hidden w-2 h-2 rounded-full bg-emerald-500 shrink-0"
            aria-hidden="true"
          >
          </span>
        </a>
        {/*
            Admin & moderation. Ships `hidden`; App.renderAdminButton()
            publishes the flag for platform admins AND view-only admins —
            gated on
            `App.user.isAdmin`, which both roles carry, and deliberately NOT on
            `canAdminWrite` (the full-admin mutation gate, which would hide the
            console from exactly the moderation audience). Never gated on
            USERNODE_ENV: the row must exist identically in staging and
            production. Navigation rides the anchor's #admin hash, which
            navigateToAdminConsole re-gates server-side.
        */}
        <a
          ref={adminRef}
          id="profile-row-admin"
          href="#admin"
          className={`hidden ${TILE}`}
        >
          <ShieldCheckIcon className="w-4 h-4 shrink-0" />
          <span className="text-sm font-medium">
            Admin
          </span>
        </a>
      </div>
    </section>
  );
}
