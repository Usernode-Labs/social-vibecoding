-- #6494: remember the highest storage line the admins were told about, so a
-- half-full heads-up can fire before the 80% warning without re-sending an
-- early notice to a project that was already warned. NULL means no line was
-- crossed, 1 the early (50%) line, 2 the warning line.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_storage_warn_level SMALLINT;

-- Projects that were already warned keep their state: they must not be told
-- again, and they get no early notice afterwards.
UPDATE apps
   SET db_storage_warn_level = 2
 WHERE db_storage_warned_at IS NOT NULL
   AND db_storage_warn_level IS NULL;
