/**
 * Two small strips above the dev chat's send row, as view models.
 *
 * ── The quick-reply pills ─────────────────────────────────────────────
 *
 * The suggestions the last assistant turn offered, or a state-derived starter
 * set. WHICH pills is a long piece of reasoning in dev-chat.js — it walks the
 * message list backwards, skips pill-less system rows, stops at the first
 * user/assistant row, and falls back per #894 when an assistant reply carries
 * none — and none of that moves. This carries the answer.
 *
 * ── The "Run on" controls ─────────────────────────────────────────────
 *
 * Deliberately SILENT for the overwhelmingly common case: a session with no
 * machine attached that has never run one draws nothing at all, so the
 * composer row is unchanged for everyone not using this. The other two states
 * are a live lease (a picker plus a chip) and a past one (a chip alone, saying
 * the machine has detached so the next turn comes back here).
 *
 * Both hosts stay the module's — `renderChatView`'s template writes them, and
 * `dc-quick-replies-active` is what gives the pill bar its height — so React
 * owns only their children.
 */

import { createStore } from '../../lib/plain-store.js';

export interface QuickRepliesState {
  /** Empty hides the bar; the module also drops its active class. */
  replies: string[];
}

export const quickRepliesStore = createStore<QuickRepliesState>({ replies: [] });

export interface RunnerState {
  /** 'none' draws nothing — no machine, and none has ever run a turn. */
  kind: 'none' | 'past' | 'live';
  /** The machine's name. Empty when `kind` is 'none'. */
  label: string;
}

export const runnerStore = createStore<RunnerState>({ kind: 'none', label: '' });
