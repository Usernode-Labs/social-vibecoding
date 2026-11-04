-- When the merge queue tries this change again after GitHub held its merge
-- back (a "merge already in progress" busy answer, or a plain refusal nobody
-- has to act on). Read alongside integration_block_reasons, which carries
-- the 'github_busy' / 'github_refused' reason that explains it. NULL for
-- every other row, and for a refusal that stays held until the head or main
-- moves (a conflict, a draft, a wrong base, code missing from the git host).
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS merge_held_until TIMESTAMPTZ;
