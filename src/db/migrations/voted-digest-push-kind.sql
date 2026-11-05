-- #5404: the Monday "changes you voted on" row reaches a phone, as a Change
-- alert beside the daily vote digest (services/mobile-push-preferences.js).
-- A kind with no row here pushes nothing.
INSERT INTO mobile_push_kind_categories (kind, category, default_enabled) VALUES
  ('voted_digest', 'proposal_alerts', TRUE)
ON CONFLICT (kind) DO UPDATE SET
  category = EXCLUDED.category,
  default_enabled = EXCLUDED.default_enabled;
