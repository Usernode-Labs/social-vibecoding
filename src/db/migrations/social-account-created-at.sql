-- Homeroom bot's "Verified accounts only" rule (#6632) gains a signal that
-- counts GitHub and X only together, and only when both accounts are older
-- than a minimum age (services/homeroom-bot-verified.js 'github_x_age').
-- That needs when each provider account was created, ON THE PROVIDER, not
-- when it was linked here.
--
-- account_created_at      when the GitHub or X account itself was made.
--                         NULL is unknown, and unknown never counts.
-- account_created_source  'provider': reported by the provider (GitHub's
--                         /user or /user/{id} created_at, X's /2/users/me
--                         with user.fields=created_at). 'derived': worked
--                         out from an X snowflake id, exact to the
--                         millisecond (services/social-account-age.js).
--
-- Written when an account is linked or verified again, and for accounts
-- linked before this by the social-account-age clock. The table stays
-- staging:private: a creation date is personal data.
ALTER TABLE user_social_identities
  ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS account_created_source VARCHAR(16)
    CHECK (account_created_source IS NULL OR account_created_source IN ('provider', 'derived'));

-- A replacement awaiting its confirmation carries the date the provider
-- reported with it, so confirming it records the new account's own date.
ALTER TABLE social_identity_pending_replacements
  ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ;
