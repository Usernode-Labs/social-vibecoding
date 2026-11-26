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
import { plainPrRefs } from '../../../lib/change-ref';
import { eventText } from '../../group-chat/proposal-event';

/**
 * One thing that happened, as its line: a glyph and the line's words. A line
 * the page words itself is a whole message (`id`, read with `values` where
 * it is drawn, with `<0>` around who did it and `<1>` around a vote's
 * reason); a line somebody else worded, the merge event's or a platform
 * notice's, arrives as `text`.
 */
export interface ChangeLine {
  kind: 'submitted' | 'vote' | 'preview' | 'merged' | 'spec' | 'notice';
  glyph: string;
  /** Bold at the line's start, or null when the line names nobody. */
  actor: string | null;
  /** The whole line's message id. */
  id?: string;
  /** What `id` is read with: who did it, a spec's version, a vote's reason. */
  values?: Record<string, string | number>;
  /** A line already worded: the merge event's sentence, or a notice. */
  text?: string;
  /** `preview`: the line ends "· Try it". */
  tryIt?: boolean;
}

/**
 * A vote's line, one whole message for each case: who voted (or nobody
 * named), yes or no, on this version or an earlier one, with or without the
 * voter's reason.
 */
const VOTE_LINE = {
  named: {
    yes: {
      current: { bare: 'project:topic.change.line.votedYes', reason: 'project:topic.change.line.votedYesReason' },
      earlier: { bare: 'project:topic.change.line.votedYesEarlier', reason: 'project:topic.change.line.votedYesEarlierReason' },
    },
    no: {
      current: { bare: 'project:topic.change.line.votedNo', reason: 'project:topic.change.line.votedNoReason' },
      earlier: { bare: 'project:topic.change.line.votedNoEarlier', reason: 'project:topic.change.line.votedNoEarlierReason' },
    },
  },
  unnamed: {
    yes: {
      current: { bare: 'project:topic.change.line.unnamedVotedYes', reason: 'project:topic.change.line.unnamedVotedYesReason' },
      earlier: { bare: 'project:topic.change.line.unnamedVotedYesEarlier', reason: 'project:topic.change.line.unnamedVotedYesEarlierReason' },
    },
    no: {
      current: { bare: 'project:topic.change.line.unnamedVotedNo', reason: 'project:topic.change.line.unnamedVotedNoReason' },
      earlier: { bare: 'project:topic.change.line.unnamedVotedNoEarlier', reason: 'project:topic.change.line.unnamedVotedNoEarlierReason' },
    },
  },
} as const;

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
    // Homeroom bot's plan reads as the plan itself, "Plan v1: Dark mode",
    // with its Read (homeroom-bot-live.js specCard).
    if (msg.specShare.botNote || (!msg.specShare.sharedByUnknown && /^homeroom_bot$/i.test(msg.specShare.sharedBy))) {
      return {
        kind: 'spec', glyph: '📋', actor: null, id: 'project:topic.change.line.botPlan',
        values: { version: msg.specShare.version, title: msg.specShare.title },
      };
    }
    return {
      kind: 'spec', glyph: '📋', actor: msg.specShare.sharedBy,
      // Nobody to name has a wording of its own.
      id: msg.specShare.sharedByUnknown ? 'project:topic.change.line.postedSpecUnnamed' : 'project:topic.change.line.postedSpec',
      values: msg.specShare.sharedByUnknown
        ? { version: msg.specShare.version }
        : { author: msg.specShare.sharedBy, version: msg.specShare.version },
    };
  }
  if (msg.stagingBuild === 'started') return null;
  if (msg.stagingBuild === 'ready') return { kind: 'preview', glyph: '👀', actor: null, id: 'project:topic.change.line.previewReady', tryIt: true };
  const ev = msg.event;
  if (ev && ev.type === 'vote') {
    const ids = VOTE_LINE[ev.actor ? 'named' : 'unnamed'][ev.vote === 'no' ? 'no' : 'yes'][ev.earlier ? 'earlier' : 'current'];
    return {
      kind: 'vote',
      glyph: ev.vote === 'no' ? '✋' : '✅',
      actor: ev.actor || null,
      id: ev.reason ? ids.reason : ids.bare,
      values: { voter: ev.actor || '', ...(ev.reason ? { reason: ev.reason } : {}) },
    };
  }
  if (ev && ev.type === 'submitted') {
    return ev.actor
      ? { kind: 'submitted', glyph: '🗳️', actor: ev.actor, id: 'project:topic.change.line.askedForApproval', values: { author: ev.actor } }
      : { kind: 'submitted', glyph: '🗳️', actor: null, id: 'project:topic.change.line.unnamedAskedForApproval' };
  }
  if (ev && ev.type === 'merged') return { kind: 'merged', glyph: '🎉', actor: null, text: eventText(msg) };
  const text = ev && ev.type === 'notice' ? (ev.text || '') : (msg.systemText || '');
  if (!text.trim()) return null;
  // Stored lines keep "PR #N" because the server's regex readers match it;
  // a person reads "PR N", so it cannot be taken for a request's number.
  return { kind: 'notice', glyph: '•', actor: null, text: plainPrRefs(text) };
}

/** The rows a change's page draws: every person, and every line it keeps. */
export function changeStream(rows: TranscriptMessage[]): TranscriptMessage[] {
  return rows.filter((m) => m.kind === 'message' || changeLine(m) !== null);
}

/** The people in the stream: what "N replies" counts. */
export function changeReplyCount(rows: TranscriptMessage[]): number {
  return rows.filter((m) => m.kind === 'message' && !m.deleted).length;
}

/**
 * 1 Nov 2026 (one page per thread): which of a change's rows its request's
 * page keeps, in the thread's one discussion: every person's reply, and of
 * what happened to the change only a plan posted, the ask for approval, the
 * preview being ready (with Try it), a vote with a written reason, and its
 * going live. A vote with no reason is the Votes card's to count, and a
 * notice is its cards' to say.
 */
export function keptOnRequest(msg: TranscriptMessage): boolean {
  if (msg.kind === 'message') return true;
  const line = changeLine(msg);
  if (!line || line.kind === 'notice') return false;
  if (line.kind === 'vote') return !!(msg.event && msg.event.reason);
  return true;
}

/**
 * #7216: a No's reason on one of Homeroom bot's changes is handed to the bot
 * as the voter's own reply (routes/votes.js), and the vote row then carries
 * no reason, so the request's page drew those words as an ordinary message.
 * This joins the reply back onto the vote row, so the page words it with the
 * change page's own line ("evan voted no: “…”"), its "on change PR N" tag
 * kept. The reply then leaves the stream.
 *
 * Pure: returns a new array and never mutates its input, leaving every row it
 * does not join as the same object, so memo()'d rows keep their props. A row
 * is joined only when all of these hold:
 *
 *   - it is a vote row of a change, naming who voted, with no reason;
 *   - its reason reply is found: the row `event.reasonMessageId` names (a
 *     non-deleted message by that voter on the same change), or, for older
 *     rows with no id, the non-deleted message by that voter directly before
 *     a No, on the same change, written at most two minutes earlier;
 *   - the reply has words, and no other vote row has claimed it.
 */
export function joinVoteReasons(rows: TranscriptMessage[]): TranscriptMessage[] {
  const out = rows.slice();
  const dropped = new Set<number>();
  const claimed = new Set<number>();
  rows.forEach((vote, i) => {
    const ev = vote.event;
    const sessionId = vote.changeOf?.sessionId;
    if (!sessionId || !ev || ev.type !== 'vote' || !ev.actor || (ev.reason && ev.reason.trim())) return;
    let found = -1;
    const wanted = Number(ev.reasonMessageId) || 0;
    if (wanted > 0) {
      const at = rows.findIndex((m) => m.id === wanted);
      const m = at >= 0 ? rows[at] : null;
      if (m && m.kind === 'message' && !m.deleted && m.username === ev.actor
        && (m.changeOf?.sessionId ?? null) === sessionId) found = at;
    } else if (ev.vote === 'no') {
      // Older rows: the voter's message directly before the vote.
      const at = i - 1;
      const m = at >= 0 ? rows[at] : null;
      if (m && m.kind === 'message' && !m.deleted && m.username === ev.actor
        && (m.changeOf?.sessionId ?? null) === sessionId && m.at && vote.at) {
        const gap = Date.parse(vote.at) - Date.parse(m.at);
        if (Number.isFinite(gap) && gap >= 0 && gap <= 120_000) found = at;
      }
    }
    if (found < 0 || claimed.has(found)) return;
    const message = rows[found];
    const reason = String(message.text || '').trim();
    if (!reason) return;
    claimed.add(found);
    dropped.add(found);
    out[i] = { ...vote, event: { ...vote.event, reason } };
  });
  return dropped.size ? out.filter((_, i) => !dropped.has(i)) : out;
}
