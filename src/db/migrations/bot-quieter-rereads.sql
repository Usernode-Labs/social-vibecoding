-- Homeroom bot, one model, step 5 (11 Nov 2026): fewer, quieter re-reads.
--
-- homeroom_bot_voice_turns.addressed_ids: the messages a turn of the bot's
-- voice judged, the ones it answered (or chose to say nothing to) in a
-- thread. A comment it answered that does not change what a request asks
-- for (a question, a status check, thanks) does not make the bot read the
-- request again (homeroom-bot.js unaddressedActivityByIssue); one it judged
-- to change the ask is read again through its ask_changed tool. Empty for a
-- turn that answered nobody, and for every turn before this.
ALTER TABLE homeroom_bot_voice_turns ADD COLUMN IF NOT EXISTS addressed_ids INTEGER[] NOT NULL DEFAULT '{}';

-- homeroom_bot_runs.look_kind: what kind of look a run was that did not
-- read its request. A fix round on its change's failing checks ('fix'), the
-- change brought up to date with main instead ('sync'), the checks handed
-- to a person ('hand_off'), and a fix that ran out of time tried once more
-- ('retry'). NULL is a read: a triage read, or a reply turn on its change.
-- The rollout health's reads per request counts the NULL ones only
-- (homeroom-bot-health.js REREADS_SQL).
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS look_kind TEXT;
