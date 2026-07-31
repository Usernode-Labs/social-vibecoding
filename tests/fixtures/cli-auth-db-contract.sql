\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (username, password)
VALUES ('cli-auth-db-contract-user', 'unused')
RETURNING id \gset user_

WITH db_now AS (SELECT clock_timestamp() AS now)
INSERT INTO cli_device_authorizations
  (device_code_hash, user_code, scopes, request_ip, created_at, expires_at)
SELECT repeat('a', 64), 'ABCD-EFGH',
       ARRAY['rpc:identity:read', 'api:access']::text[],
       '127.0.0.1'::inet, now, now + INTERVAL '10 minutes'
FROM db_now
RETURNING id \gset device_

DO $$
BEGIN
  BEGIN
    INSERT INTO cli_device_authorizations
      (device_code_hash, user_code, scopes, request_ip, created_at, expires_at)
    VALUES (
      repeat('b', 64), 'ABCD-EFGJ',
      ARRAY['rpc:identity:read', 'api:access']::text[],
      '127.0.0.1'::inet, clock_timestamp(),
      clock_timestamp() + INTERVAL '9 minutes'
    );
    RAISE EXCEPTION 'invalid device lifetime unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO cli_device_authorizations
      (device_code_hash, user_code, scopes, request_ip, created_at, expires_at)
    VALUES (
      repeat('c', 64), 'ABCD-EFGK', ARRAY['rpc:read']::text[],
      '127.0.0.1'::inet, clock_timestamp(),
      clock_timestamp() + INTERVAL '10 minutes'
    );
    RAISE EXCEPTION 'invalid device scope unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

WITH db_now AS (SELECT clock_timestamp() AS now)
UPDATE cli_device_authorizations d
SET status = 'approved', user_id = :user_id, approved_at = db_now.now
FROM db_now
WHERE d.id = :device_id;

WITH db_now AS (SELECT clock_timestamp() AS now)
INSERT INTO cli_access_tokens
  (token_hash, token_hint, user_id, scopes, created_at, expires_at)
SELECT repeat('d', 64), 'svcli_…ABCD', :user_id,
       ARRAY['rpc:identity:read', 'api:access']::text[],
       now, now + INTERVAL '30 days'
FROM db_now
RETURNING id \gset token_

WITH db_now AS (SELECT clock_timestamp() AS now)
INSERT INTO cli_access_tokens
  (token_hash, token_hint, user_id, scopes, created_at, expires_at)
SELECT repeat('e', 64), 'svcli_…EFGH', :user_id,
       ARRAY[]::text[], now, now + INTERVAL '30 days'
FROM db_now;

INSERT INTO cli_auth_audit_events
  (event_type, user_id, actor_user_id, device_authorization_id, scopes)
VALUES (
  'authorization_started', NULL, NULL, :device_id,
  ARRAY['rpc:identity:read', 'api:access']::text[]
);

INSERT INTO cli_auth_audit_events
  (event_type, user_id, actor_user_id, access_token_id, scopes, outcome, metadata)
VALUES (
  'token_used', :user_id, :user_id, :token_id,
  ARRAY['rpc:identity:read', 'api:access']::text[],
  'scope_authorized',
  '{"method":"POST","route":"/api/apps/demo/issues"}'::jsonb
);

DO $$
BEGIN
  BEGIN
    INSERT INTO cli_auth_audit_events
      (event_type, device_authorization_id, scopes)
    SELECT 'authorization_started', id,
           ARRAY['rpc:identity:read', 'api:access']::text[]
      FROM cli_device_authorizations
     WHERE device_code_hash = repeat('a', 64);
    RAISE EXCEPTION 'duplicate transition audit unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO cli_auth_audit_events
      (event_type, user_id, actor_user_id, access_token_id, scopes, outcome, metadata)
    VALUES (
      'token_used',
      (SELECT user_id FROM cli_access_tokens WHERE token_hash = repeat('d', 64)),
      (SELECT user_id FROM cli_access_tokens WHERE token_hash = repeat('d', 64)),
      (SELECT id FROM cli_access_tokens WHERE token_hash = repeat('d', 64)),
      ARRAY['rpc:identity:read', 'api:access']::text[],
      'scope_authorized',
      '{"method":"POST","route":"/api/apps/demo/issues","body":"forbidden"}'::jsonb
    );
    RAISE EXCEPTION 'extra token-use metadata unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO cli_auth_audit_events
      (event_type, user_id, actor_user_id, access_token_id, scopes, metadata)
    VALUES (
      'token_revoked',
      (SELECT user_id FROM cli_access_tokens WHERE token_hash = repeat('d', 64)),
      (SELECT user_id FROM cli_access_tokens WHERE token_hash = repeat('d', 64)),
      (SELECT id FROM cli_access_tokens WHERE token_hash = repeat('d', 64)),
      ARRAY['rpc:identity:read', 'api:access']::text[],
      '{"reason":null}'::jsonb
    );
    RAISE EXCEPTION 'null revocation reason unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

DO $$
DECLARE
  private_count integer;
BEGIN
  SELECT COUNT(*) INTO private_count
  FROM pg_catalog.pg_class c
  WHERE c.relname IN (
    'cli_device_authorizations',
    'cli_access_tokens',
    'cli_auth_audit_events',
    'cli_auth_rate_limits'
  )
    AND obj_description(c.oid, 'pg_class') = 'staging:private';
  IF private_count <> 4 THEN
    RAISE EXCEPTION 'CLI auth privacy comments missing';
  END IF;
END
$$;

ROLLBACK;
