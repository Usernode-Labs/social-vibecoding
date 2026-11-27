/**
 * THE RULE FOR WHAT YOU CAN DO WITH A MESSAGE, WRITTEN ONCE.
 *
 * Every place that draws a message asks this one function which of the
 * message's acts it offers: a Messages conversation (../messages/message-row.tsx),
 * a project's topic channels and its request and change threads
 * (../group-chat/transcript.tsx), the platform notices and shared plans in
 * those streams, and the comments under a change on the board
 * (../dev-board/card/feed-thread.tsx). Each place used to decide for itself,
 * in its own words ("showEdit", "theirs", "mine ? null : …"), and the
 * answers had drifted: a channel offered Edit on a message with no words, a
 * notice could be reported in one place and not another.
 *
 * Three things decide it, and nothing else:
 *
 *   who is asking  — signed in or not, and whether they may write here
 *   whose message  — the viewer's own, somebody else's, or nobody's (a notice)
 *   what place     — a direct chat, a group, a channel, a reply thread, a
 *                    request's or a change's stream, or a comment preview
 *
 * plus the facts about the message itself that every act needs (is it
 * still there, does it have words, can a thread hang off it). The answer is
 * a set of yes/no flags; the place then supplies the acts for the flags that
 * are yes, against its own store or socket (../message-actions/message-menu.ts
 * builds the ⋯ menu and the long-press sheet from them, in the one order).
 *
 * Pure: no window, no store, no DOM. tests/message-action-rules.test.js
 * runs it directly.
 */

/** Where a message is drawn. */
export type MessagePlace =
  /** A direct chat between two people (Messages). */
  | 'direct'
  /** A group chat between a few people (Messages). */
  | 'group'
  /** A room: #general, a project's channel or a topic's (Messages or the project page). */
  | 'channel'
  /** A reply thread opened beside a channel or a group. */
  | 'thread'
  /** A request's or a change's own stream on its page. */
  | 'stream'
  /** A comment previewed under a change or a request on the board: read here, answered on its page. */
  | 'comment';

export interface MessageAsk {
  /** Who is asking. */
  viewer: {
    /** Signed in at all. A signed-out reader of a public channel can read and copy, nothing more. */
    signedIn: boolean;
    /** May write in this place: false for a read-only reader (#621) or a place whose box is closed to them. */
    canWrite: boolean;
  };
  /** Whose message: the viewer's own (`mine`), and whether it has an author at all. */
  author: {
    mine: boolean;
    /** A person's account is behind it, so it can be blocked. */
    known: boolean;
  };
  place: MessagePlace;
  message: {
    /** Delivered and still there: not deleted, not still on its way, not failed. */
    live: boolean;
    /** Something a person (or the bot) said, as opposed to a notice of something that happened. */
    said: boolean;
    /** It has words to copy and to edit. */
    hasText: boolean;
    /** A reply thread can hang off it here (the place keeps threads, and this kind of row can start one). */
    threadable?: boolean;
    /** It can be handed to Homeroom bot as a request (the bot answers in this place and it is not one already). */
    askable?: boolean;
  };
}

/** What the viewer can do with the message. Every flag is a yes or a no; nothing is implied. */
export interface MessageActions {
  react: boolean;
  reply: boolean;
  save: boolean;
  thread: boolean;
  edit: boolean;
  copy: boolean;
  /** Read somebody else's words in the viewer's language (where the place can ask for a translation). */
  translate: boolean;
  /** Save its pictures to the device. */
  download: boolean;
  link: boolean;
  markUnread: boolean;
  remove: boolean;
  report: boolean;
  block: boolean;
  makeRequest: boolean;
}

const NOTHING: MessageActions = Object.freeze({
  react: false, reply: false, save: false, thread: false, edit: false, copy: false, translate: false, download: false,
  link: false, markUnread: false, remove: false, report: false, block: false, makeRequest: false,
}) as MessageActions;

/**
 * The places whose main stream has its own read position, so a message
 * there can be marked unread. A reply thread, a request's or change's stream
 * and a comment preview are read as a whole.
 */
const HAS_READ_POSITION: ReadonlySet<MessagePlace> = new Set(['direct', 'group', 'channel']);

/** The places a reply thread can be started from. */
const STARTS_THREADS: ReadonlySet<MessagePlace> = new Set(['group', 'channel']);

/** What the viewer can do with this message, here. */
export function messageActions(ask: MessageAsk): MessageActions {
  const { viewer, author, place, message } = ask;
  // A comment previewed on the board is read there and answered on its own
  // page, where its reactions, replies and menu are: nothing to do with it here.
  if (place === 'comment') return NOTHING;
  // A message that is gone, or not delivered yet, offers nothing: a failed
  // send's only controls are its Retry and Discard.
  if (!message.live) return NOTHING;
  const writes = viewer.signedIn && viewer.canWrite;
  const theirs = !author.mine && message.said;
  return {
    react: writes,
    reply: writes,
    save: viewer.signedIn,
    thread: !!message.threadable && STARTS_THREADS.has(place),
    edit: author.mine && message.said && message.hasText && writes,
    copy: message.hasText,
    translate: theirs && message.hasText,
    download: true,
    link: true,
    markUnread: viewer.signedIn && !author.mine && HAS_READ_POSITION.has(place),
    remove: author.mine && message.said && viewer.signedIn,
    report: viewer.signedIn && theirs,
    block: viewer.signedIn && theirs && author.known,
    makeRequest: author.mine && !!message.askable && place === 'channel' && writes,
  };
}
