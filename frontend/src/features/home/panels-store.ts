/**
 * The home screen's three fixed sections — Discover, Challenges, Create app —
 * as view models.
 *
 * ── The split ─────────────────────────────────────────────────────────
 *
 * `home-panels.js` keeps everything that is not markup: the `/api/home-panels`
 * fetch and its TTL, the per-key expand flags, the hidden/removable rules, the
 * ⋮ menu's rows and both destinations. What it used to do on top of that —
 * build ~800 lines of HTML string per paint and re-attach eight families of
 * listener afterwards — is now this: compute three plain objects and push
 * them. `panels/sections.tsx` renders them.
 *
 * Every derivation the renderers did inline is resolved HERE, where the data
 * lives: which rows fit, whether the list reserves a meter lane, whether the
 * viewer may create an app. A component reads facts.
 *
 * ── `painted` ─────────────────────────────────────────────────────────
 *
 * The three hosts ship WITHOUT `hidden` and empty, because that is what the
 * hand-written shell shipped and hydration has to agree. A section with
 * nothing to show is `hidden` — but only once a render has decided so.
 * `painted: false` is the difference between "not yet" and "nothing", and it
 * is why the flag exists rather than being inferred from three nulls.
 */

import { createStore } from '../../lib/plain-store.js';

import type { IconView } from './grid-store';

/** `data-*` attributes the block stamps on its own article AND on its host. */
export interface PanelStamps {
  /** Discover's two lane counts, mirrored so one selector can ask for both. */
  featured?: number;
  popular?: number;
  /** The Challenges block's composition: how many challenge rows it drew. */
  rows?: number;
  /** The Create block's quota state. */
  createEnabled?: boolean;
}

// ── Discover ──────────────────────────────────────────────────────────

export interface DiscoverTileView {
  slug: string;
  name: string;
  status: string;
  demo: boolean;
  /** Is this app already in "Your apps"? Drives the badge's whole treatment. */
  added: boolean;
  icon: IconView;
}

export interface DiscoverView {
  key: string;
  title: string;
  featured: DiscoverTileView[];
  popular: DiscoverTileView[];
}

// ── Challenges ────────────────────────────────────────────────────────

export interface ChallengeRowView {
  id: string;
  goal: string;
  /** The task, folded into the row's tooltip — the one place it still shows. */
  tip: string;
  done: boolean;
  reward: string;
  /** Null on a non-numeric challenge, which reserves no meter. */
  meter: { current: number; target: number; label: string; pct: number } | null;
}

export interface ChallengesView {
  key: string;
  title: string;
  /** "1 of 6 · 3,900 pts left", or null between seasons. */
  summary: string | null;
  total: number;
  expanded: boolean;
  rows: ChallengeRowView[];
  /** Does the LIST reserve the meter lane? A property of the list, not a row. */
  metered: boolean;
}

// ── Create app ────────────────────────────────────────────────────────

export interface CreateView {
  key: string;
  canCreate: boolean;
  /** The ask-an-admin sentence — tooltip, tap toast and ⋮ note share it. */
  hint: string;
}

export interface HomePanelsState {
  painted: boolean;
  discover: DiscoverView | null;
  challenges: ChallengesView | null;
  create: CreateView | null;
}

export const INITIAL_PANELS: HomePanelsState = {
  painted: false,
  discover: null,
  challenges: null,
  create: null,
};

export const panelsStore = createStore<HomePanelsState>(INITIAL_PANELS);

if (typeof window !== 'undefined') {
  (window as unknown as { HomePanelsStore?: unknown }).HomePanelsStore = panelsStore;
}
