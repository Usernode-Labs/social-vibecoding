-- Artifacts, stage 0 (docs/plans/artifacts.md): a plan knows which design it
-- came from. A plan made from a design (services/design-threads.js
-- postDesignPlan) said so only in its own words ("after is version 4 of the
-- design"), and the one way back was a regular expression over them. It is
-- stored now, on the plan's version: the design's thread and the version of
-- it the plan shows as its after side.
--
-- No foreign key on purpose: private_threads is private to staging clones,
-- so a preview's copy of this table names threads its database does not
-- hold. A reader finds the thread or says nothing.
--
-- Both columns are nullable with no default, so a build from before this
-- (which names neither in its INSERT) keeps working while the two run side
-- by side during a release.
ALTER TABLE chat_session_specs ADD COLUMN IF NOT EXISTS design_thread_id BIGINT;
ALTER TABLE chat_session_specs ADD COLUMN IF NOT EXISTS design_version INTEGER;

-- The plans posted before this, filled once from the words they already
-- carry: the same expression the code read (design-threads.js
-- PLAN_VERSION_RE, removed with this), over only the plans whose author has
-- a thread with a design that filed or posted on the plan's request, so the
-- scan is those few rows and never every plan. At most six digits, so the
-- cast cannot overflow. Rows already filled are left alone, which makes a
-- second run change nothing.
UPDATE chat_session_specs s
   SET design_thread_id = found.thread_id,
       design_version = found.version
  FROM (
    SELECT sp.id,
           p.id AS thread_id,
           substring(sp.content_html from '\mafter is version ([0-9]{1,6})(?:, a mockup| of the design)\M')::int AS version
      FROM chat_session_specs sp
      JOIN chat_sessions cs ON cs.id = sp.session_id AND cs.source = 'request_spec'
      JOIN LATERAL (
        SELECT t.id
          FROM private_threads t
          JOIN design_threads d ON d.private_thread_id = t.id
         WHERE t.user_id = cs.user_id
           AND t.app_id = cs.app_id
           AND t.result_ref = cs.created_from_issue_number
           AND t.state IN ('filed', 'posted')
         ORDER BY t.updated_at DESC, t.id DESC
         LIMIT 1
      ) p ON TRUE
     WHERE sp.design_version IS NULL
       AND sp.content_html IS NOT NULL
  ) found
 WHERE s.id = found.id
   AND found.version > 0;
