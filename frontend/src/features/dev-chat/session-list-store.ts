/**
 * `#dc-session-list` — the dev chat's own list of this app's sessions — as a
 * view model.
 *
 * ── One row, five decisions ───────────────────────────────────────────
 *
 * Which buttons a row carries is the whole of this surface, and none of it
 * is obvious from the status alone:
 *
 * - a PROMOTED session cannot be paused (its PR must stay votable) but its
 *   warm worker can still be freed — the same endpoint, and the server
 *   answers `keptPromoted`;
 * - once that worker is gone there is nothing left to free, so no button;
 * - Archive is gated INDEPENDENTLY of the other three, because the backend
 *   archives any open session regardless of warm state. Re-coupling them is
 *   a regression this shape makes hard to write.
 *
 * So the model carries the resolved buttons, not the status. `dev-chat.js`
 * decides; ./session-list.tsx draws.
 *
 * ── Handlers are named calls ──────────────────────────────────────────
 *
 * dev-chat.js must stay import-free (see ./mount.ts), so a row's actions
 * cannot be closures the module hands over. Each one names a `DevChat`
 * method and the component dispatches by name — the same shape the Dev
 * board's cards use. Each returns a "flash" label or null: the module owns
 * the request and what it means, the component owns the button's pending
 * text.
 */

import { createStore } from '../../lib/plain-store.js';

/** A row action. `label` is the button; `busy` is what it says mid-request. */
export interface SessionAction {
  key: 'pause' | 'free' | 'resume' | 'archive' | 'unarchive';
  label: string;
  busy: string;
  title?: string | null;
  /** The `DevChat` method to call, and what to call it with. */
  fn: string;
  args: (string | number | boolean)[];
  /** Tailwind classes — complete literals, see ./session-list.tsx. */
  tone: 'quiet' | 'go' | 'danger';
}

export interface SessionRow {
  id: number;
  status: string;
  /** The status word's tint, as a name the component resolves. */
  statusTone: 'active' | 'promoted' | 'paused' | 'other';
  title: string;
  /** The branch name, as the row's tooltip. */
  branch: string;
  /** #1038: from the live store, not the sessions payload. */
  busy: boolean;
  pr: { url: string; number: number } | null;
  date: string;
  actions: SessionAction[];
}

export interface SessionListState {
  /** `null` until the first publish; `[]` is the real "no sessions" state. */
  rows: SessionRow[] | null;
}

export const sessionListStore = createStore<SessionListState>({ rows: null });
