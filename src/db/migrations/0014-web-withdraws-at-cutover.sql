-- SEC-09 (2 Nov 2026): web withdraws a request it appended just before its
-- writes on the workflow kernel's tables were taken.
--
-- Until then web could update the event stream, so its events were stamped
-- 'platform' (0011-workflow-producers.sql). A route that appended one just
-- before the migration Job took web's writes, and stops waiting just after,
-- withdraws it (src/workflow/kernel/stream.ts refuseIfPending) as web, and
-- `producer = caller` no longer matched: its caller heard "not decided yet"
-- and the request could still be applied. restrictWebWorkflow records when
-- it took them (wf_settings 'web_restricted_at'); web may also withdraw a
-- pending event of the platform's from before then, with a few seconds for
-- the grants' commit, that a route could have appended (a route's, an
-- admin's or a system one; never a service result, a timer or a message).
-- Nothing appended later.
CREATE OR REPLACE FUNCTION wf_refuse_pending(event_id BIGINT, refusal TEXT) RETURNS BOOLEAN AS $$
DECLARE
  refused BIGINT;
  marker TEXT := current_setting('app.wf_writer', true);
  caller TEXT := CASE WHEN has_table_privilege(session_user, 'wf_events'::regclass, 'UPDATE') THEN 'platform' ELSE 'web' END;
  restricted TIMESTAMPTZ;
BEGIN
  -- The reasons a caller gives up for; never one the kernel decides with
  -- (an unknown_event is asked again by the conductor).
  IF refusal IS NULL OR refusal NOT IN ('expired', 'operation_unavailable', 'stop_unavailable') THEN
    RAISE EXCEPTION 'WF_INVALID_REFUSAL: % is not a reason a producer gives up for', COALESCE(refusal, 'null');
  END IF;
  IF caller = 'web' THEN
    SELECT value::timestamptz INTO restricted FROM wf_settings WHERE key = 'web_restricted_at';
  END IF;
  PERFORM set_config('app.wf_writer', 'transition', true);
  UPDATE wf_events SET status = 'processed', result = 'rejected', reason = refusal, processed_at = clock_timestamp()
   WHERE id = event_id AND status = 'pending'
     AND (producer = caller
       OR (caller = 'web' AND producer = 'platform' AND restricted IS NOT NULL
           AND created_at < restricted + interval '5 seconds'
           AND COALESCE(source ->> 'kind', '') IN ('route', 'admin', 'system')))
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
