-- Homeroom mobile polish, item 05 (24 Nov 2026): when each person last
-- looked at the Homeroom bot tab's list, and what its three bands held then,
-- so the list can mark what is new since that visit (services/ai-visits.js).
-- Kept per person, not per device, so a phone and a computer agree, as
-- unread messages already do; the precedent is conversation_members
-- .last_visit_at (conversation-members-last-visit.sql), which tells a chat's
-- return after hours away from a glance.
--
--   last_visit_at, last_visit_seen  the visit the marks are measured from:
--       when it ended and what the bands held then ({ needs, busy, done },
--       each a map of a row's identity to where it stood). NULL until a
--       first visit has ended: a first visit has nothing before it.
--   current_at, current_seen  the visit under way, or the one just left:
--       when its last word came and what it had in view then. It becomes
--       the last visit when the next one starts.
--   current_tabs  the browser tabs that have the list open now, by the
--       token each was given, with when each was last heard from.
--   left_tab, left_at  the tab that left last, so a reload of that tab
--       carries on the same visit rather than starting the next one.
--
-- Nullable and never backfilled. staging:private for the reason
-- thread_reads is: personal reading history.
CREATE TABLE IF NOT EXISTS ai_list_visits (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_visit_at   TIMESTAMPTZ,
  last_visit_seen JSONB,
  current_at      TIMESTAMPTZ,
  current_seen    JSONB,
  current_tabs    JSONB NOT NULL DEFAULT '{}'::jsonb,
  left_tab        TEXT,
  left_at         TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE ai_list_visits IS 'staging:private';
