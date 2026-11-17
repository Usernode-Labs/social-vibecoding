-- #6764 (17 Nov 2026): a private thread with Homeroom bot is named by a short
-- summary of what it is about, written once after the bot's first answer
-- (services/private-threads.js autoTitle), and can be renamed by its owner
-- from its ⋯ menu (rename). Until a title exists it keeps today's name: the
-- person's first words, or what the thread is (kindTitle).
--
-- `title_source` 'auto' is the summary; 'person' is a name they set
-- themselves, which the automatic title never replaces. `title_runs` counts
-- the automatic runs that read the exchange, so a greeting-only first
-- exchange may be titled once more after the next message, and then never
-- again (at most two). No backfill: an existing thread keeps its name until
-- a bot reply arrives after this ships.
ALTER TABLE private_threads
  ADD COLUMN IF NOT EXISTS title        VARCHAR(120),
  ADD COLUMN IF NOT EXISTS title_source VARCHAR(8)
    CHECK (title_source IS NULL OR title_source IN ('auto', 'person')),
  ADD COLUMN IF NOT EXISTS title_runs   SMALLINT NOT NULL DEFAULT 0;
