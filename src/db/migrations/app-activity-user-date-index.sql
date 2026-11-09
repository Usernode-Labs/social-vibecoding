-- The profile's "This week" card reads one person's last seven days on every
-- open. The table's unique key leads with app_id, so nothing could find a
-- person's rows without scanning it.
CREATE INDEX IF NOT EXISTS idx_app_activity_user_date
  ON app_activity(user_id, date);
