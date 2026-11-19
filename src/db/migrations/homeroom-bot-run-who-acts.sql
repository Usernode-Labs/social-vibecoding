-- #6869: who can act on a person verdict that is the project's own setup,
-- named by the read (who_acts), so a repeated refusal can say it again.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS who_acts TEXT;
