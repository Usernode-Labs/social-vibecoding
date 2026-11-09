-- The person a hand-off verdict named to build its request (a 'person'
-- verdict's builder), kept on its run (5 Nov 2026,
-- docs/plans/bot-one-model.md, step 4). A request's stage rings its
-- requester's bell (services/work-state.js bellPushes); a hand-off that
-- names who builds it asks nothing of the requester and rings nothing, as
-- its news did not (the 16 Oct quiet rule), so the bell must know the name
-- from the run, in the insert that records the verdict.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS builder TEXT;
