-- #5974 (4 Nov 2026): Settings › Linked devices lists the browsers signed in
-- to the account beside its phones, with Sign out for each.
--
-- A browser session row said nothing about where it was made or when it was
-- last used, so the list could not name a row or say whether it was still in
-- use. Two columns, and nothing that identifies a person or a machine:
--
--   user_agent_class  a SHORT class from a closed vocabulary, written once at
--                     sign-in (services/linked-browsers.js classifyUserAgent):
--                     browser family and OS family, like 'chrome/mac'. Never
--                     the User-Agent string itself, and never an address.
--   last_seen_at      when the session last authenticated a request, written
--                     by middleware/auth.js at most once per 15 minutes per
--                     session. NULL on a row that has not been used since
--                     this migration; the list then shows its sign-in date.
--
-- The table stays staging:private as a whole (its token is the credential).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent_class TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
