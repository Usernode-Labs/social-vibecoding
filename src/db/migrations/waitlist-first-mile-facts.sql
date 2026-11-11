-- Admin › Journey's first mile, the parts it could not see (services/journey.js).
--
-- waitlist_signups.source: which form a signup came from, written as the row
-- is made (NULL for rows from before):
--   'form'              Homeroom's own waitlist page (POST /api/public/waitlist)
--   'partner:<label>'   a partner's form through that route with its key
--   'app'               the waitlist card in the app (an email or a phone)
--   'account'           an account made without access, given its row then
--   'test'              an admin's test release
-- How somebody heard of Homeroom is their own answer, answers.discovery.
--
-- release_page_opened_at / release_page_outcome: the "You're in" mail's own
-- page (features/auth/landing.tsx), first opened at, and what happened there:
--   'opened'      it opened and nothing else is known yet
--   'signed_in'   its one-time link signed them in (services/release-links.js)
--   'welcome'     the welcome showed for an account already set up, waiting
--                 for Get started
--   'link_expired' / 'link_used'   the link no longer worked
-- The mail's click tracking leaves that link out, and a mail scanner fetches
-- the page without running it, so these are written only by the page's own
-- read and the link's spend.

ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS source VARCHAR(64);
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS release_page_opened_at TIMESTAMPTZ;
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS release_page_outcome VARCHAR(16);
