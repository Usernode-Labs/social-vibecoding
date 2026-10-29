/**
 * The All tab's kind filters (#3206).
 *
 * "I opened my notifications to find vote and mention updates" — and found
 * kudos, invites, quota changes and chat lines all in one list. Unread is
 * grouped by project (#5406) and the search field matches words (#5405), but
 * neither answers "show me what wants a vote from me" across every project.
 * So the All tab carries three chips, one per kind of thing that waits on
 * you, and a chip narrows the list to that kind. Everything else (kudos,
 * quota, builds, merges) is only seen with no chip on.
 *
 * Three, not a chip per kind: the chips are for finding what is time-
 * sensitive, and every kind outside them is news you read rather than answer.
 * There is no Messages chip on purpose: #5289 took that filter out because
 * the Messages tab in the bar already is one. A mention or a reply in a
 * conversation is still a mention or a reply, so those count here.
 *
 * Client-side, over the rows already loaded, like the search: All's own
 * "See older notifications" pager brings more in, and the filtered list grows
 * with it. `kind` is the row view's `kind` (rowView in ./notifications.js);
 * a collapsed conversation run carries its representative's kind.
 *
 * Import-free, like ./notifications-search.js, so the tests can evaluate it
 * from the shipped source.
 */

export const NOTIFICATION_KIND_FILTERS = Object.freeze({
  // A change asking for your vote, or what became of one you voted on.
  votes: Object.freeze([
    'pr_proposed', 'stale_pr', 'revision_recheck', 'change_ready', 'vote_digest',
    'proposal_vote', 'voted_change_merged',
  ]),
  // Someone named you with @, or answered you, in a project's chat, a request
  // or a conversation.
  mentions: Object.freeze([
    'mention', 'issue_mention', 'conversation_mention',
    'reply', 'thread_reply', 'issue_thread_reply', 'change_thread_reply',
    'conversation_reply', 'conversation_thread_reply',
  ]),
  // Something you can accept: to build or approve on a project, to join a
  // conversation, a friend request.
  invites: Object.freeze([
    'collab_invite', 'approver_invite', 'conversation_invite', 'friend_request',
  ]),
});

/** The chips, in the order they are drawn. */
export const NOTIFICATION_KIND_FILTER_KEYS = Object.freeze(['votes', 'mentions', 'invites']);

/** Does a row of this kind belong under this filter? No filter keeps every row. */
export function matchesKindFilter(kind, filter) {
  if (!filter) return true;
  if (!Object.prototype.hasOwnProperty.call(NOTIFICATION_KIND_FILTERS, filter)) return true;
  return NOTIFICATION_KIND_FILTERS[filter].includes(kind);
}
