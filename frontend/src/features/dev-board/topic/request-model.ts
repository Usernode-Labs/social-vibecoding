/**
 * #4453 — a request's page, drawn as a Messages reply thread: the request as
 * the root post, where it stands under it, its specs hanging off it, then
 * one stream of replies in the order they were written.
 *
 * ── Two halves, two owners ────────────────────────────────────────────
 *
 * The REQUEST (who asked, its words, its claim and the change on it) is the
 * issue row, which `AppView._topicViewFor` turns into `TopicBody.request`
 * and the topic head draws (./request-head.tsx). The STREAM (the thread's
 * own messages and the GitHub comments merged into them) is the thread
 * transcript's, which `GroupChat.renderThread` publishes. The specs are in
 * the stream (a spec_share message, or Homeroom bot's spec comment on
 * GitHub) but drawn by the head, as cards under the request, so the stream
 * publishes them here as well (`requestThreadStore`).
 *
 * Everything below is pure, so both halves read one rule for which rows
 * are a spec and which are the same spec said twice.
 */

import { t } from '../../../lib/i18n/runtime';
import { createStore } from '../../../lib/plain-store.js';
import type { TranscriptMessage } from '../../group-chat/transcript-store';

/** The GitHub account Homeroom files and mirrors through, and its name on screen. */
export const BOT_NAME = 'Homeroom bot';

export function displayName(username: string): string {
  return /^usernode-bot$|^homeroom_bot$/i.test(username) ? BOT_NAME : username;
}

/** One spec, at its newest version, as its card under the request draws it. */
export interface RequestSpecCard {
  key: string;
  title: string;
  /** Null for the bot's GitHub copy, which carries no version. */
  version: number | null;
  by: string;
  /** `by` is a stand-in word, not a name: the card uses its unnamed wording. */
  byUnknown?: boolean;
  /** `by` is the chat's "System" stand-in: the row came with no author. */
  bySystem?: boolean;
  at: string | null;
  time: string;
  timeTitle: string;
  /** What Read opens: a shared version, or the GitHub copy's own text. */
  read:
    | { kind: 'shared'; sessionId: number; version: number; previewTitle: string }
    | { kind: 'text'; title: string; markdown: string; html: string };
}

/**
 * The stream a request's page draws, from the rows the thread published:
 *
 *   - A spec posted on Homeroom is mirrored to GitHub by the bot ("**evan**
 *     posted a spec…", or the bot's own "Homeroom bot wrote a spec…"). Once
 *     the thread has the posting itself, the bot's copy is the same spec
 *     said twice, and it leaves the stream.
 *   - Without one, the bot's comment is the only place the spec is, so it
 *     stays: a spec card, and the line saying it was posted.
 */
export function requestStream(rows: TranscriptMessage[]): { rows: TranscriptMessage[]; specs: RequestSpecCard[] } {
  const shared = rows.some((m) => m.kind === 'spec_share' && !!m.specShare);
  const kept = shared ? rows.filter((m) => !(m.kind === 'github' && m.githubSpec)) : rows;
  const specs: RequestSpecCard[] = [];
  const bySession = new Map<string, number>();
  for (const m of kept) {
    if (m.kind === 'spec_share' && m.specShare) {
      const s = m.specShare;
      const key = s.sessionId != null ? `s${s.sessionId}` : `t${s.title}`;
      const card: RequestSpecCard = {
        key,
        title: s.title,
        version: s.version,
        by: s.sharedBy,
        byUnknown: !!s.sharedByUnknown,
        at: m.at || null,
        time: m.time,
        timeTitle: m.timeTitle,
        read: { kind: 'shared', sessionId: Number(s.sessionId), version: s.version, previewTitle: s.previewTitle },
      };
      const at = bySession.get(key);
      if (at == null) { bySession.set(key, specs.length); specs.push(card); }
      else if ((specs[at].version || 0) <= s.version) specs[at] = card;
    } else if (m.kind === 'github' && m.githubSpec) {
      specs.push({
        key: `g${m.key || specs.length}`,
        title: m.githubSpec.title || t('project:topic.request.spec.untitled'),
        version: null,
        by: displayName(m.username),
        bySystem: !!m.usernameMissing,
        at: m.at || null,
        time: m.time,
        timeTitle: m.timeTitle,
        read: { kind: 'text', title: m.githubSpec.title || t('project:topic.request.spec.untitled'), markdown: m.githubSpec.markdown, html: m.githubSpec.html },
      });
    }
  }
  return { rows: kept, specs };
}

/** The people in the stream: what "N replies" counts. */
export function replyCount(rows: TranscriptMessage[]): number {
  return rows.filter((m) => (m.kind === 'message' || (m.kind === 'github' && !m.githubSpec)) && !m.deleted).length;
}

/** A claim, in the words of the page: "evan started working on this". */
export function eventText(m: TranscriptMessage): string {
  const text = m.systemText || '';
  const claimed = /^(\S+) claimed this (?:issue|request)$/.exec(text.trim());
  return claimed ? t('project:topic.request.stream.claimedPlain', { member: claimed[1] }) : text;
}

/** Open a spec card's Read in the spec reader beside the page. */
export function openRequestSpec(card: RequestSpecCard): Promise<void> | void {
  const gc = typeof window !== 'undefined' ? (window as any).GroupChat : null;
  if (!gc) return;
  if (card.read.kind === 'shared') {
    return gc.openSharedSpec?.(card.read.sessionId, card.read.version, card.read.previewTitle);
  }
  gc._showSpecPanel?.({ title: card.read.title, version: null, content: card.read.markdown, html: card.read.html });
}

/** Where a request is: the stepper's four stops. */
export type RequestStage = 'asked' | 'spec' | 'built' | 'voted';

/** Each stop and its label's message id, read where the stepper is drawn. */
export const STAGES: { key: RequestStage; label: string }[] = [
  { key: 'asked', label: 'project:topic.request.stage.asked' },
  { key: 'spec', label: 'project:topic.request.stage.spec' },
  { key: 'built', label: 'project:topic.request.stage.built' },
  { key: 'voted', label: 'project:topic.request.stage.voted' },
];

/**
 * The stage, from what the issue row knows (a change underway or in review
 * is Built, merged is Voted in) and what the stream knows (a spec posted is
 * Spec). The row's own stage wins when it is further on.
 */
export function requestStage(fromRow: RequestStage, specs: number): RequestStage {
  if (fromRow === 'asked' && specs > 0) return 'spec';
  return fromRow;
}

/** The newest spec's version, for "Plan v2 is ready for comments." */
export function newestSpecVersion(specs: RequestSpecCard[]): number | null {
  const versions = specs.map((s) => s.version).filter((v): v is number => v != null);
  return versions.length ? Math.max(...versions) : null;
}

export interface RequestThreadState {
  /** The request the rows are for, so a page left behind is not read as this one. */
  number: number | null;
  specs: RequestSpecCard[];
}

export const requestThreadStore = createStore<RequestThreadState>({ number: null, specs: [] });

/** Called by `GroupChat.renderThread` (through mount.ts) on every render of a request's stream. */
export function publishRequestThread(number: number, rows: TranscriptMessage[]): void {
  const { specs } = requestStream(rows);
  const prev = requestThreadStore.get();
  // The transcript republishes on every reaction and typing tick; keep the
  // head's store still unless the specs themselves moved.
  const same = prev.number === number && prev.specs.length === specs.length
    && prev.specs.every((s, i) => s.key === specs[i].key && s.version === specs[i].version && s.title === specs[i].title && s.time === specs[i].time);
  if (!same) requestThreadStore.set({ number, specs });
}
