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
  return rows.filter((m) => m.kind === 'message' && !m.deleted && !m.voteReasonPost).length;
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
  if (line.kind === 'vote') return !!msg.voteNote || !!(msg.event && msg.event.reason);
  return true;
}

/** The words a vote's reason is drawn as, escaped for the post's body. */
function reasonBody(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
}

/**
 * The vote line that goes above its reason's post: the change page's own
 * wording, without the reason ("evan voted no", or "…on an earlier version").
 * It carries no time (#7221: its change is named in the line's own sentence,
 * and the post under it shows only its time), and `voteNote` keeps it through
 * `keptOnRequest` after its reason has left the row.
 */
function voteNoteOf(vote: TranscriptMessage): TranscriptMessage {
  return {
    ...vote,
    event: vote.event ? { ...vote.event, reason: '' } : vote.event,
    time: '',
    timeTitle: '',
    voteNote: true,
  };
}

/**
 * A vote's reason as the ordinary post it is (#7216, evan): the voter's own
 * message row, name and avatar, its words the reason. A vote whose reason came
 * attached to its row (a Yes, or a No that stayed on the change) has no reply
 * to draw, so its post is made from `event.reason`. It is not a reply of the
 * request's thread (`voteReasonPost`), so it does not count in "N replies"
 * nor stand as the newest comment.
 */
function voteReasonPost(vote: TranscriptMessage, reason: string): TranscriptMessage {
  return {
    ...vote,
    id: null,
    kind: 'message',
    username: vote.event?.actor || vote.username,
    usernameMissing: false,
    text: reason,
    bodyHtml: reasonBody(reason),
    systemText: '',
    event: null,
    eventHref: null,
    voteRef: null,
    vote: null,
    voteRowClass: '',
    votePhase: undefined,
    reactions: [],
    attachments: [],
    quote: null,
    unread: false,
    bookmarked: false,
    editedTitle: null,
    flash: false,
    canEdit: false,
    showEdit: false,
    showBookmark: false,
    showReact: false,
    voteNote: false,
    voteReasonPost: true,
    // #7221: the note above names the change, so this post is not tagged with
    // it again; it shows only its time.
    changeOf: null,
  };
}

/**
 * #7216: a vote's reason on a request's thread is that person's ordinary post,
 * with the change page's vote line above it as its note ("evan voted no"),
 * never words swallowed into the vote line. This returns the rows the page
 * draws:
 *
 *   - A vote whose reason is on its row (a Yes, or a No not handed to
 *     Homeroom bot) becomes its note and a post carrying the reason.
 *   - A No whose reason was handed to the bot as the voter's own reply
 *     (routes/votes.js, `event.reasonMessageId`) becomes the note and that
 *     reply, moved up to sit under the note. Older rows with no id pair with
 *     the voter's own message directly before a No, on the same change,
 *     written at most two minutes earlier.
 *   - Every other row is left alone and the same object, so memo()'d rows
 *     keep their props.
 */
export function requestVotePosts(rows: TranscriptMessage[]): TranscriptMessage[] {
  const indexById = new Map<number, number>();
  rows.forEach((m, i) => { if (m.id != null) indexById.set(Number(m.id), i); });

  // First pass: which reply carried a handed-off No's reason. A reply is
  // claimed by one vote only, and the vote's note moves to the reply's place
  // so the post keeps the order it was written in.
  const replyAt = new Map<number, TranscriptMessage>();
  const consumed = new Set<number>();
  const movedVote = new Set<number>();
  rows.forEach((vote, i) => {
    const ev = vote.event;
    const sessionId = vote.changeOf?.sessionId;
    if (!sessionId || !ev || ev.type !== 'vote' || !ev.actor || (ev.reason && ev.reason.trim())) return;
    let found = -1;
    const wanted = Number(ev.reasonMessageId) || 0;
    if (wanted > 0) {
      const at = indexById.get(wanted);
      const m = at == null ? null : rows[at];
      if (m && m.kind === 'message' && !m.deleted && m.username === ev.actor
        && (m.changeOf?.sessionId ?? null) === sessionId && !consumed.has(at as number)) found = at as number;
    } else if (ev.vote === 'no') {
      // Older rows: the voter's message directly before the vote.
      const at = i - 1;
      const m = at >= 0 ? rows[at] : null;
      if (m && m.kind === 'message' && !m.deleted && m.username === ev.actor
        && (m.changeOf?.sessionId ?? null) === sessionId && m.at && vote.at && !consumed.has(at)) {
        const gap = Date.parse(vote.at) - Date.parse(m.at);
        if (Number.isFinite(gap) && gap >= 0 && gap <= 120_000) found = at;
      }
    }
    if (found < 0) return;
    const message = rows[found];
    const reason = String(message.text || '').trim();
    if (!reason) return;
    consumed.add(found);
    movedVote.add(i);
    replyAt.set(found, vote);
  });

  // Second pass: emit, with each reason a note above its post.
  const out: TranscriptMessage[] = [];
  rows.forEach((row, i) => {
    if (movedVote.has(i)) return;
    if (consumed.has(i)) {
      const vote = replyAt.get(i);
      if (vote) out.push(voteNoteOf(vote), row);
      else out.push(row);
      return;
    }
    const ev = row.event;
    const sessionId = row.changeOf?.sessionId;
    if (row.kind !== 'message' && sessionId && ev && ev.type === 'vote' && ev.actor) {
      const reason = String(ev.reason || '').trim();
      if (reason) {
        out.push(voteNoteOf(row), voteReasonPost(row, reason));
        return;
      }
    }
    out.push(row);
  });
  return out;
}
