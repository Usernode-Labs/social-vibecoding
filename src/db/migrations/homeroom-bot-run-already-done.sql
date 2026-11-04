-- #6306: a request the triage found already done (its `done` tag: the ask
-- exists in the app, or a merged change did it) records that on its run, so
-- Needs you, its page, its notification and the bot's summary say "Already
-- works" and offer to close it rather than reading as a decision. Runs from
-- before this column keep NULL, which reads as a plain hand-back until the
-- bot reads the request again.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS already_done BOOLEAN;
