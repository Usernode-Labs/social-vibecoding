-- #6752: a request the triage found was filed on the wrong project (its
-- `wrong_project`: where it seems to belong, and what in the request points
-- there) records that on its run, so Needs you, its page and the bot's
-- summary can say so. Runs from before this column keep NULL, which reads as
-- a plain hand-back until the bot reads the request again.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS wrong_project JSONB;
