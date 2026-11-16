-- Request #6479: the time zone a person's times are shown in, chosen in
-- Settings › Language and saved to the account so it follows them to every
-- device (POST /api/me/timezone, /api/auth/me `timeZone`). An IANA name, as
-- the browser resolves it ("America/New_York"). NULL means Auto: the device's
-- own zone, which is what every account showed before this column existed.
-- Only the client's formatters read it; scheduled sends do not.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);
