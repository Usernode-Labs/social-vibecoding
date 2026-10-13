// #4769: personal bookmarks on notifications — the save button at the
// right end of every row in the notifications drawer.
//
// A user saves any notification in their own feed; saved rows render in
// the pinned "Saved" section at the TOP of the drawer (shared with
// #1280's saved messages, one SECTION over several tables) until unsaved
// — either from the row's own bookmark button or from that section.
//
// Why this is its own service rather than a corner of ./notifications.js:
// a bookmark is not a notification. It is never created for you by someone
// else, it has no unread state, it never pushes, and it never expires.
// Saving one deliberately does not touch the notification's read state,
// and reading or clearing one leaves the save in place. The only thing
// the two share is the drawer they render in, which is a rendering fact,
// not a data one — src/routes/notifications.js folds the saved list into
// that one payload so the drawer still opens in a single round-trip.
// The list itself is built in ./notifications.js, which owns the row
// SELECT the saved rows share.
//
// Everything here is scoped to ONE user's own rows, and to notifications
// that are already theirs: the save INSERTs only when the notification
// row has the saver as its user, so there is no read path for another
// user's saves and no way to pin one by id. There is deliberately no
// aggregate ("N people saved this"): unlike a reaction, a save is
// private, which is also why the toggle is REST rather than a
// chat-WebSocket broadcast.

const { MAX_SAVED } = require('./message-bookmarks');

// Save a notification. The INSERT…SELECT means only the user's OWN
// notification can be pinned: for anybody else's (or a missing) id the
// SELECT matches nothing and the statement affects no row — the route
// answers 404. Idempotent: the DO UPDATE arm is a deliberate no-op that
// keeps the original `created_at`, so a double-tap (or two tabs, or a
// save racing the list refetch) still answers 200 instead of failing
// with DO NOTHING's zero count. Returns true when the notification
// exists and is the user's, false otherwise.
async function save(pool, userId, notificationId) {
  if (!userId || !notificationId) return false;
  const { rowCount } = await pool.query(
    `INSERT INTO notification_bookmarks (user_id, notification_id)
     SELECT $1, n.id FROM notifications n
      WHERE n.id = $2 AND n.user_id = $1
     ON CONFLICT (user_id, notification_id) DO UPDATE
        SET user_id = EXCLUDED.user_id`,
    [userId, notificationId]
  );
  return (rowCount || 0) > 0;
}

// Unsave. Returns the number of rows removed (0 when it wasn't saved), so
// the route can answer honestly without a second lookup.
async function remove(pool, userId, notificationId) {
  if (!userId || !notificationId) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM notification_bookmarks
      WHERE user_id = $1 AND notification_id = $2`,
    [userId, notificationId]
  );
  return rowCount || 0;
}

module.exports = {
  MAX_SAVED,
  save,
  remove,
};