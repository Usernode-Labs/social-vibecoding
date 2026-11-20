-- #6900: a refused Make it in a private thread with Homeroom bot is kept on
-- that thread, so the bot's next turn is told why Homeroom refused it and
-- stops guessing (services/homeroom-bot-dm.js noteMakeRefused/makeRefusalNote,
-- routes/apps.js rememberMakeRefusal). Only the newest refusal is kept:
-- each one overwrites the column, and making the project from the thread
-- clears it. Private: a refusal names the person's own planned project.
--
-- staging:private (the table itself is private already)
ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS last_make_refusal JSONB;
COMMENT ON COLUMN private_threads.last_make_refusal IS
  'The newest refused Make it from this thread (POST /api/apps thread.rootId): {status, code, reason, error, name, retryAfterSeconds, at}. Cleared when a project is made from it.';
