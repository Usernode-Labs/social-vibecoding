/**
 * #4455 — a change's page, drawn as a Messages reply thread: the change as
 * the root post (./change-head.tsx), where it stands under it, then "N
 * replies" and one stream in time order (../../group-chat/transcript.tsx
 * `ChangeRows`).
 *
 * The stream's rules live here, pure, so they can be read and tested
 * without a page: which rows are people (drawn as Messages rows), which are
 * things that happened (one quiet line each), and which say what the page
 * already says and are left out.
 */

import type { TranscriptMessage } from '../../group-chat/transcript-store';
import { eventText } from '../../group-chat/proposal-event';

/** One thing that happened, as its line: a glyph, who did it, and the rest. */
export interface ChangeLine {
  kind: 'submitted' | 'vote' | 'preview' | 'merged' | 'spec' | 'notice';
  glyph: string;
  /** Bold at the line's start, or null when the line names nobody. */
  actor: string | null;
  text: string;
  /** A vote's own line, quoted after it. */
  reason?: string;
  /** `preview`: the line ends "· Try it". */
  tryIt?: boolean;
}

/**
 * The line a row is drawn as, or null for a person's message (a Messages
 * row) and for a row the page leaves out.
 *
 *   - "snait asked for approval", for the row that put it up for a vote;
 *   - "cilokman voted yes", or "…voted yes on an earlier version" once a
 *     newer push has retired that yes (`GroupChat._votedOnEarlierVersion`);
 *   - "The preview is ready · Try it", in place of the two long build
 *     notices: the one that says the build started is the Testing card's to
 *     say, so it leaves the stream;
 *   - "This change went live with 2/3 votes", in the event's own words;
 *   - any other notice, as the platform wrote it for this page.
 */
export function changeLine(msg: TranscriptMessage): ChangeLine | null {
  if (msg.kind === 'message' || msg.kind === 'github') return null;
  if (msg.kind === 'spec_share' && msg.specShare) {
    return { kind: 'spec', glyph: '📋', actor: msg.specShare.sharedBy, text: ` posted plan v${msg.specShare.version}` };
  }
  if (msg.stagingBuild === 'started') return null;
  if (msg.stagingBuild === 'ready') return { kind: 'preview', glyph: '👀', actor: null, text: 'The preview is ready', tryIt: true };
  const ev = msg.event;
  if (ev && ev.type === 'vote') {
    const said = `voted ${ev.vote === 'no' ? 'no' : 'yes'}${ev.earlier ? ' on an earlier version' : ''}`;
    return {
      kind: 'vote',
      glyph: ev.vote === 'no' ? '✋' : '✅',
      actor: ev.actor || null,
      text: ev.actor ? ` ${said}` : `${said.charAt(0).toUpperCase()}${said.slice(1)}`,
      ...(ev.reason ? { reason: ev.reason } : {}),
    };
  }
  if (ev && ev.type === 'submitted') {
    return ev.actor
      ? { kind: 'submitted', glyph: '🗳️', actor: ev.actor, text: ' asked for approval' }
      : { kind: 'submitted', glyph: '🗳️', actor: null, text: 'Asked for approval' };
  }
  if (ev && ev.type === 'merged') return { kind: 'merged', glyph: '🎉', actor: null, text: eventText(msg) };
  const text = ev && ev.type === 'notice' ? (ev.text || '') : (msg.systemText || '');
  if (!text.trim()) return null;
  return { kind: 'notice', glyph: '•', actor: null, text };
}

/** The rows a change's page draws: every person, and every line it keeps. */
export function changeStream(rows: TranscriptMessage[]): TranscriptMessage[] {
  return rows.filter((m) => m.kind === 'message' || changeLine(m) !== null);
}

/** The people in the stream: what "N replies" counts. */
export function changeReplyCount(rows: TranscriptMessage[]): number {
  return rows.filter((m) => m.kind === 'message' && !m.deleted).length;
}
