-- Final media contract, after #6111 is deployed on every web/conductor.
-- Refuse to discard unbackfilled bytes or unusable references. Hold the
-- tables from the preflight through DDL so no writer can race the checks.
-- The migration runner supplies the transaction and bounded lock wait.
DO $media_drop$
DECLARE
  t text;
  dense boolean;
  invalid boolean;
BEGIN
  LOCK TABLE public.shot_run_files, public.shot_artifacts,
    public.shots_eval_artifacts, public.shot_diagnostic_artifacts,
    public.check_run_media, public.session_visuals IN ACCESS EXCLUSIVE MODE;
  FOREACH t IN ARRAY ARRAY['shot_run_files', 'shot_artifacts',
    'shots_eval_artifacts', 'shot_diagnostic_artifacts', 'check_run_media', 'session_visuals'] LOOP
    dense := t IN ('shot_run_files', 'shot_artifacts');
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE data IS NOT NULL%s)',
      t, CASE WHEN dense THEN ' OR dense_data IS NOT NULL' ELSE '' END) INTO invalid;
    IF invalid THEN
      RAISE EXCEPTION 'Media column removal refused: % still contains bytes; complete its backfill first', t
        USING ERRCODE = '23514';
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE
      object_key IS NULL OR sha256 IS NULL OR sha256 !~ ''^[a-f0-9]{64}$''
      OR object_key IS DISTINCT FROM ''media/sha256/'' || sha256
      OR bytes IS NULL OR bytes < 0%s)', t,
      CASE WHEN t IN ('check_run_media', 'session_visuals') THEN ' OR legacy_etag IS NULL' ELSE '' END) INTO invalid;
    IF invalid THEN
      RAISE EXCEPTION 'Media column removal refused: % has missing or inconsistent object metadata', t
        USING ERRCODE = '23514';
    END IF;
    IF dense THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE
        density IS NULL OR density NOT BETWEEN 1 AND 4
        OR (density = 1 AND (dense_object_key IS NOT NULL OR dense_width IS NOT NULL
          OR dense_height IS NOT NULL OR dense_bytes IS NOT NULL OR dense_sha256 IS NOT NULL))
        OR (density > 1 AND (dense_object_key IS NULL OR dense_width IS NULL OR dense_width <= 0
          OR dense_height IS NULL OR dense_height <= 0 OR dense_bytes IS NULL OR dense_bytes < 0
          OR dense_sha256 IS NULL OR dense_sha256 !~ ''^[a-f0-9]{64}$''
          OR dense_object_key IS DISTINCT FROM ''media/sha256/'' || dense_sha256)))', t) INTO invalid;
      IF invalid THEN
        RAISE EXCEPTION 'Media column removal refused: % has missing or inconsistent dense metadata', t
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['shot_run_files', 'shot_artifacts',
    'shots_eval_artifacts', 'shot_diagnostic_artifacts'] LOOP
    -- Preserve the separate media-enum check, every FK, and every key index.
    EXECUTE format('ALTER TABLE public.%I
      DROP CONSTRAINT %I, DROP COLUMN data, ALTER COLUMN object_key SET NOT NULL,
      ADD CONSTRAINT %I CHECK (object_key = ''media/sha256/'' || sha256)',
      t, t || '_storage_check', t || '_storage_check');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['shot_run_files', 'shot_artifacts'] LOOP
    EXECUTE format('ALTER TABLE public.%I
      DROP CONSTRAINT %I, DROP COLUMN dense_data,
      ADD CONSTRAINT %I CHECK (density BETWEEN 1 AND 4 AND (
        (density = 1 AND dense_object_key IS NULL AND dense_width IS NULL
          AND dense_height IS NULL AND dense_bytes IS NULL AND dense_sha256 IS NULL)
        OR (density > 1 AND dense_object_key IS NOT NULL AND dense_width IS NOT NULL AND dense_width > 0
          AND dense_height IS NOT NULL AND dense_height > 0 AND dense_bytes IS NOT NULL AND dense_bytes >= 0
          AND dense_sha256 IS NOT NULL AND dense_sha256 ~ ''^[a-f0-9]{64}$''
          AND dense_object_key = ''media/sha256/'' || dense_sha256)))',
      t, t || '_density_check', t || '_density_check');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['check_run_media', 'session_visuals'] LOOP
    EXECUTE format('ALTER TABLE public.%I
      DROP CONSTRAINT %I, DROP COLUMN data,
      ALTER COLUMN object_key SET NOT NULL, ALTER COLUMN sha256 SET NOT NULL,
      ALTER COLUMN bytes SET NOT NULL, ALTER COLUMN legacy_etag SET NOT NULL,
      ADD CONSTRAINT %I CHECK (sha256 ~ ''^[a-f0-9]{64}$'' AND bytes >= 0
        AND object_key = ''media/sha256/'' || sha256)',
      t, t || '_media_check', t || '_media_check');
  END LOOP;
END
$media_drop$;
