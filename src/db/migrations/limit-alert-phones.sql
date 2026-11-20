-- Text alerts for platform limits (services/limit-texts.js; Admin › Limits,
-- "Text alerts"): the numbers a full admin has asked to be texted when a
-- platform-wide limit is near or reached, what each was last told, and a log
-- of every text and refusal. Every table here is private: a phone number is
-- personal data, and the marks and the log hang off it.

-- A number, added by a full admin and active only once its code is entered.
-- `verify_code_hash` is a SHA-256 of the row id and the code, never the code;
-- it and its expiry are cleared once the number is verified.
CREATE TABLE IF NOT EXISTS limit_alert_phones (
  id                 BIGSERIAL PRIMARY KEY,
  phone_e164         VARCHAR(16) NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  country            VARCHAR(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  label              VARCHAR(60) NOT NULL CHECK (btrim(label) <> ''),
  added_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verify_code_hash   TEXT,
  verify_expires_at  TIMESTAMPTZ,
  verify_attempts    INTEGER NOT NULL DEFAULT 0,
  verify_sent_at     TIMESTAMPTZ,
  verified_at        TIMESTAMPTZ,
  last_texted_at     TIMESTAMPTZ,
  last_status        TEXT,
  last_error         TEXT
);
COMMENT ON TABLE limit_alert_phones IS 'staging:private';

-- What each number was last told about each limit: the level it was texted
-- at ('near' or 'broken', or 'ok' once the limit is back under its line),
-- when, and how long a limit has been unreadable, so a crossing is texted
-- once and a limit that stays broken is reminded at most every six hours.
CREATE TABLE IF NOT EXISTS limit_alert_marks (
  phone_id        BIGINT NOT NULL REFERENCES limit_alert_phones(id) ON DELETE CASCADE,
  limit_key       VARCHAR(32) NOT NULL,
  level           VARCHAR(8) NOT NULL DEFAULT 'ok' CHECK (level IN ('ok', 'near', 'broken')),
  texted_at       TIMESTAMPTZ,
  unknown_since   TIMESTAMPTZ,
  unknown_texted  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (phone_id, limit_key)
);
COMMENT ON TABLE limit_alert_marks IS 'staging:private';

-- Every text and every refusal, for the card's "last texted" and for a
-- record of what was said. The number appears only as its last four digits.
CREATE TABLE IF NOT EXISTS limit_alert_sends (
  id           BIGSERIAL PRIMARY KEY,
  phone_id     BIGINT REFERENCES limit_alert_phones(id) ON DELETE SET NULL,
  phone_last4  VARCHAR(4) CHECK (phone_last4 ~ '^[0-9]{4}$'),
  limit_key    VARCHAR(32),
  what         VARCHAR(16) NOT NULL CHECK (what IN ('verify', 'test', 'crossing', 'reminder', 'unknown')),
  level        VARCHAR(8),
  status       VARCHAR(16) NOT NULL CHECK (status IN ('sent', 'logged', 'refused', 'failed')),
  error_code   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE limit_alert_sends IS 'staging:private';
CREATE INDEX IF NOT EXISTS limit_alert_sends_phone_idx ON limit_alert_sends (phone_id, created_at DESC);

-- The SMS layer's own delivery log gains the kind these texts are sent as.
ALTER TABLE sms_deliveries DROP CONSTRAINT IF EXISTS sms_deliveries_kind_check;
ALTER TABLE sms_deliveries ADD CONSTRAINT sms_deliveries_kind_check
  CHECK (kind IN ('otp', 'marketing', 'test', 'limit_alert'));
