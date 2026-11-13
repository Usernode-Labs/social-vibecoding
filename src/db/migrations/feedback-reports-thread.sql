-- #6566 (10 Nov 2026): a report filed by the Homeroom bot remembers the
-- conversation thread it was filed from.
--
-- Asked again in the same thread about the same problem (for a link to the
-- report, say), the bot answers with the report already filed instead of
-- filing a duplicate (services/feedback-reports.js findRecentReport). Both
-- columns are nullable: the feedback dialog files no thread, and reports
-- from before this change sit outside every thread.
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS conversation_id INTEGER
  REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS thread_root_id INTEGER
  REFERENCES conversation_messages(id) ON DELETE SET NULL;
