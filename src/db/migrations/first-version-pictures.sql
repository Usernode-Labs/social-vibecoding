-- #7118: a new app's own logo and card picture, with its first version.
--
-- `card_picture_at` is when the first version's card picture was considered
-- (services/first-version-pictures.js): set once, on the first production
-- deploy after the first version merged, whether a picture was applied or
-- the creator's own picture won. It makes that step run once, so a picture
-- applied later is never put back.
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS card_picture_at TIMESTAMPTZ;

-- #7118: the first version's build pays for its own two pictures (its logo's
-- card picture), so they do not use up the maker's week of pictures
-- (services/bot-pictures.js). False on those two rows only; every other
-- picture keeps counting.
ALTER TABLE homeroom_bot_pictures ADD COLUMN IF NOT EXISTS counts_toward_cap BOOLEAN NOT NULL DEFAULT TRUE;
