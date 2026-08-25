/**
 * `#settings-usernode-section` — the mobile app's native App Settings, as a
 * view model.
 *
 * ── Why this host had to convert all at once ──────────────────────────
 *
 * It is ONE host with six sub-sections — connection, device permissions,
 * activity notifications, node, block production, privacy, widget icons,
 * diagnostics — built by `_renderUsernodeBody` and five sibling renderers,
 * about 900 lines of `document.createElement`. The stateful-island rule is
 * per SUBTREE, not per section: React cannot own half of a host while
 * settings.js appends into the other half, so there is no incremental path
 * and the whole body arrives here at once.
 *
 * ── Every async lifecycle stays the module's ──────────────────────────
 *
 * The bridge reads (`getSettingsState`, the permission prompt, the setters),
 * the `/challenges-api/bp/*` fetches, the `usernode:social-push-state`
 * listener and its `SocialPush.isSupported()` probe are all still settings.js's
 * — including the retry ladders, which is where most of this screen's value
 * is. What crosses the seam is what to DRAW.
 *
 * Three of those used to re-render IN PLACE through a closure over their own
 * host (`render(state)` in the block-production and activity-notification
 * sections, `holder.textContent = ''` first). Each is a slice of this model
 * now, so a late arrival repaints its own rows and nothing else — and a
 * listener that fires after the section is gone can no longer write into a
 * detached node, which is what `box.isConnected` was guarding by hand.
 */

import { createStore } from '../../../lib/plain-store.js';

/** A `_unStatusRow`: dot, label, and an ok/bad readout on the right. */
export interface UnStatusRow {
  id?: string;
  label: string;
  ok: boolean;
  text: string;
  /** Present when the row itself is the control. */
  hint?: string;
  action?: string;
}

/** A `_unButton`. `action` names the module function to dispatch into. */
export interface UnAction {
  label: string;
  action: string;
  danger?: boolean;
  disabled?: boolean;
  id?: string;
}

/** A `_unToggle`. */
export interface UnToggle {
  label: string;
  checked: boolean;
  action: string;
  includeErrorDetail?: boolean;
}

/** A paragraph, with the one class run that distinguishes the mono ones. */
export interface UnNote {
  text: string;
  tone?: 'muted' | 'mono' | 'demo' | 'warn';
}

/** The connection panel — first, so a refused handshake explains itself. */
export interface UnConnection {
  demo: boolean;
  row: UnStatusRow;
  reason: string;
  build: string;
  message: string | null;
  retryDisabled: boolean;
}

/** The read-failure panel, and its loading variant. */
export type UnBody =
  | { kind: 'loading' }
  | { kind: 'error'; reason: string; message: string | null }
  | {
    kind: 'permissions';
    demo: boolean;
    heading: string;
    description: string;
    row: UnStatusRow;
    button: UnAction | null;
    notice: { text: string; tone: 'warn' | 'ok' | 'plain'; settings: boolean } | null;
    android: {
      row: UnStatusRow;
      button: UnAction | null;
      device: string | null;
    } | null;
  };

/** The activity-notifications section: absent, a reason, or the toggle. */
export type UnSocialPush =
  | { kind: 'absent' }
  | { kind: 'checking' }
  | { kind: 'unavailable'; reason: string; failure: string | null; retry: boolean }
  | { kind: 'ready'; enabled: boolean; status: string };

/** The block-production queue. */
export type UnBlockProduction =
  | { kind: 'checking' }
  | { kind: 'note'; text: string }
  | { kind: 'ask' };

export interface UnWidgetIcons {
  demo: boolean;
  rows: UnStatusRow[];
  notes: UnNote[];
  /**
   * One pinned shortcut: a health dot, the app's name, and the note that
   * separates "never sent" from "sent and not kept". `empty` is the
   * no-shortcuts sentence, carried as a row so the list has one shape.
   */
  entries: {
    key: string; ok: boolean; name: string; note: string; empty: string | null;
  }[];
  recheck: boolean;
}

export interface UsernodeSectionState {
  /** The CAPABILITY gate — separate from the wrapper's routing `hidden`. */
  gated: boolean;
  connection: UnConnection | null;
  body: UnBody | null;
  socialPush: UnSocialPush;
  /** Everything below the demo cut — a browser link renders permissions only. */
  belowDemoCut: boolean;
  nodeSleep: UnToggle | null;
  blockProduction: UnBlockProduction;
  privacy: { facematch: UnToggle; reset: UnAction } | null;
  widgetIcons: UnWidgetIcons | null;
  diagnostics: { debugMode: UnToggle | null; actions: UnAction[] } | null;
  about: { notes: UnNote[]; actions: UnAction[] } | null;
  account: { rows: UnStatusRow[]; actions: UnAction[] } | null;
}

export const USERNODE_EMPTY: UsernodeSectionState = {
  gated: false,
  connection: null,
  body: null,
  socialPush: { kind: 'absent' },
  belowDemoCut: false,
  nodeSleep: null,
  blockProduction: { kind: 'checking' },
  privacy: null,
  widgetIcons: null,
  diagnostics: null,
  about: null,
  account: null,
};

export const usernodeSectionStore = createStore<UsernodeSectionState>(USERNODE_EMPTY);
