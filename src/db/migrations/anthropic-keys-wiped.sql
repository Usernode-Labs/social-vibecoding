-- Task 2275: Homeroom no longer bills Anthropic directly. Every model call
-- goes to OpenRouter (services/openrouter-messages.js), people's own
-- Anthropic keys are gone (their Settings section and routes with them),
-- and so is the admin card that recorded the Anthropic credit balance.
--
-- 1. Every stored Anthropic key is wiped. The two columns stay for one more
--    release, so a rollback to the build before this one still boots and
--    simply finds no key; a later migration drops them.
UPDATE users
   SET anthropic_key_enc = NULL,
       anthropic_key_last4 = NULL
 WHERE anthropic_key_enc IS NOT NULL OR anthropic_key_last4 IS NOT NULL;

-- 2. Their copies in the generic credential store become tombstones, the
--    shape credential-store.js revoke() leaves: the secret cleared, the row
--    revoked, its revision moved on. Rows are kept, never deleted, so an
--    audit reference to one stays safe.
UPDATE credentials.user_ai_credentials
   SET secret_enc = NULL,
       secret_last4 = NULL,
       secret_fingerprint = NULL,
       status = 'revoked',
       verified_at = NULL,
       revoked_at = COALESCE(revoked_at, NOW()),
       revision = revision + 1,
       updated_at = NOW()
 WHERE provider = 'anthropic'
   AND (status <> 'revoked' OR secret_enc IS NOT NULL OR secret_last4 IS NOT NULL);

-- 3. The Anthropic credit balance an admin recorded (services/anthropic-
--    credits.js, removed): nothing reads it any more.
DELETE FROM platform_settings
 WHERE key IN ('anthropic_credit_balance_cents', 'anthropic_credit_as_of');
