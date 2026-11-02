-- SEC-09 (2 Nov 2026): who appended a workflow event is the database's
-- word, not the producer's.
--
-- Web and the conductor log in as different roles (docs/security/
-- database-roles.md). The conductor decides: it writes machine state,
-- receipts, work and every event's outcome. Web only asks: it appends
-- pending events and reads what was decided, and holds no other write on
-- the kernel's tables (services/database-role-grants.js).
--
-- `producer` records which: 'platform' when the appending login may update
-- the event stream (the conductor's, the migrator's, the one login of a
-- database whose roles are not split), 'web' when it may only append. Each
-- machine names the events web may append (src/workflow/kernel/machine.ts
-- `web`), and the pipeline refuses any other event web appended. Web never
-- appends a work result, a timer or another machine's message, whatever
-- source it claims: those are the conductor's alone.
--
-- Events appended before this read as 'platform', as they were decided.
ALTER TABLE wf_events ADD COLUMN IF NOT EXISTS producer TEXT NOT NULL DEFAULT 'platform';

CREATE OR REPLACE FUNCTION wf_stamp_producer() RETURNS TRIGGER AS $$
DECLARE
  original TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.producer := OLD.producer;
    RETURN NEW;
  END IF;
  NEW.producer := CASE WHEN has_table_privilege(session_user, TG_RELID, 'UPDATE') THEN 'platform' ELSE 'web' END;
  IF NEW.producer = 'web' THEN
    IF COALESCE(NEW.source ->> 'kind', '') NOT IN ('route', 'admin', 'system') THEN
      RAISE EXCEPTION 'WF_PRODUCER_REFUSED: web cannot append a % event', COALESCE(NEW.source ->> 'kind', 'sourceless');
    END IF;
    -- What caused an event is the kernel's to say (a re-ask names the event
    -- it asks again), never web's.
    NEW.caused_by := NULL;
  ELSIF NEW.caused_by IS NOT NULL AND NEW.request_key = 'reask:' || NEW.caused_by THEN
    -- A refused event asked again by the conductor (platform.ts
    -- reaskRefused) is still its first producer's request.
    EXECUTE format('SELECT producer FROM %I.%I WHERE id = $1', TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO original USING NEW.caused_by;
    IF original = 'web' THEN NEW.producer := 'web'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
DROP TRIGGER IF EXISTS wf_events_producer ON wf_events;
CREATE TRIGGER wf_events_producer
  BEFORE INSERT OR UPDATE OF producer ON wf_events
  FOR EACH ROW EXECUTE FUNCTION wf_stamp_producer();

-- A producer that stopped waiting for its pending event refuses it, so it is
-- never applied after its caller gave up (src/workflow/kernel/stream.ts
-- refuseIfPending). Web may not update the stream, so it does this here, and
-- only for an event its own login appended: a producer withdraws its own
-- request, never another's. Callable by the serving logins only (granted with
-- the schema's other functions), never by the read-only roles.
-- The kernel's writer marker is set and put back in the body: a function's own
-- SET clause on a custom setting needs a superuser to create it, and the
-- migrator is not one.
CREATE OR REPLACE FUNCTION wf_refuse_pending(event_id BIGINT, refusal TEXT) RETURNS BOOLEAN AS $$
DECLARE
  refused BIGINT;
  marker TEXT := current_setting('app.wf_writer', true);
BEGIN
  -- The reasons a caller gives up for; never one the kernel decides with
  -- (an unknown_event is asked again by the conductor).
  IF refusal IS NULL OR refusal NOT IN ('expired', 'operation_unavailable', 'stop_unavailable') THEN
    RAISE EXCEPTION 'WF_INVALID_REFUSAL: % is not a reason a producer gives up for', COALESCE(refusal, 'null');
  END IF;
  PERFORM set_config('app.wf_writer', 'transition', true);
  UPDATE wf_events SET status = 'processed', result = 'rejected', reason = refusal, processed_at = clock_timestamp()
   WHERE id = event_id AND status = 'pending'
     AND producer = CASE WHEN has_table_privilege(session_user, 'wf_events'::regclass, 'UPDATE') THEN 'platform' ELSE 'web' END
  RETURNING id INTO refused;
  PERFORM set_config('app.wf_writer', COALESCE(marker, ''), true);
  IF refused IS NOT NULL THEN
    PERFORM pg_notify('wf_outcome', refused::text);
  END IF;
  RETURN refused IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
REVOKE ALL ON FUNCTION wf_refuse_pending(BIGINT, TEXT) FROM PUBLIC;
-- Names resolve in the schema the stream is in, never a caller's temporary one.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION wf_refuse_pending(BIGINT, TEXT) SET search_path = %I, pg_temp', current_schema());
END;
$$;

-- Whether a platform process's build serves with web's writes on the kernel's
-- tables taken away: it withdraws its requests through wf_refuse_pending,
-- asks a conductor to release a faulted instance, and leaves wf_settings to
-- the conductor. Every process of this build says so (services/processes.js).
-- The release that takes those writes waits until no web process of an
-- earlier build serves (services/database-role-grants.js).
ALTER TABLE platform_processes ADD COLUMN IF NOT EXISTS web_restriction_ready BOOLEAN NOT NULL DEFAULT FALSE;
