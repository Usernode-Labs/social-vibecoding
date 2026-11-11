-- The leaked-link guard's two notices to a link's maker
-- (services/invite-activity.js noteGuard), in Your invites beside the other
-- news a link brings: one link brought in 20 people in a day, and one link
-- paused at 100. A kind with no row here pushes nothing.
INSERT INTO mobile_push_kind_categories (kind, category, default_enabled) VALUES
  ('invite_link_busy', 'invite_activity', TRUE),
  ('invite_link_paused', 'invite_activity', TRUE)
ON CONFLICT (kind) DO UPDATE SET
  category = EXCLUDED.category,
  default_enabled = EXCLUDED.default_enabled;
