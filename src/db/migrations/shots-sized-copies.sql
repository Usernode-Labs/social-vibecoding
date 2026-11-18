-- 18 Nov 2026 (#6825): a before/after still is saved with two smaller copies
-- beside it, so a picture slot loads a file its own size instead of the
-- whole screen shot, and a tiny blurred preview it can draw at once.
--
--   thumb_*   WebP, at most 600 px on the long side (a card and the change
--             header strip, at 3x)
--   screen_*  WebP, at most 1200 px wide (the largest slot, about 400 CSS
--             px, at 3x)
--   placeholder  a data URI, about 20 px wide, sent inside the shots view so
--                a slot draws it with no request of its own
--
-- The original PNG stays the artifact's own `object_key` (and `dense_*` its
-- device-density copy): zoom and the full view still open it. Every column
-- is nullable, so a still saved before this change reads exactly as it did.
-- services/shots-sized.js makes the copies once, when the still is saved
-- (never while someone waits for a picture), and a copy that fails or would
-- not be smaller than its source is left out.
ALTER TABLE shot_run_files
  ADD COLUMN IF NOT EXISTS thumb_object_key TEXT REFERENCES media_objects(object_key),
  ADD COLUMN IF NOT EXISTS thumb_width INTEGER,
  ADD COLUMN IF NOT EXISTS thumb_height INTEGER,
  ADD COLUMN IF NOT EXISTS thumb_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS thumb_sha256 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS screen_object_key TEXT REFERENCES media_objects(object_key),
  ADD COLUMN IF NOT EXISTS screen_width INTEGER,
  ADD COLUMN IF NOT EXISTS screen_height INTEGER,
  ADD COLUMN IF NOT EXISTS screen_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS screen_sha256 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS placeholder TEXT;

ALTER TABLE shot_artifacts
  ADD COLUMN IF NOT EXISTS thumb_object_key TEXT REFERENCES media_objects(object_key),
  ADD COLUMN IF NOT EXISTS thumb_width INTEGER,
  ADD COLUMN IF NOT EXISTS thumb_height INTEGER,
  ADD COLUMN IF NOT EXISTS thumb_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS thumb_sha256 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS screen_object_key TEXT REFERENCES media_objects(object_key),
  ADD COLUMN IF NOT EXISTS screen_width INTEGER,
  ADD COLUMN IF NOT EXISTS screen_height INTEGER,
  ADD COLUMN IF NOT EXISTS screen_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS screen_sha256 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS placeholder TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'shot_run_files'::regclass AND conname = 'shot_run_files_placeholder_check'
  ) THEN
    ALTER TABLE shot_run_files
      ADD CONSTRAINT shot_run_files_placeholder_check
      CHECK (placeholder IS NULL OR (length(placeholder) <= 1400 AND placeholder LIKE 'data:image/webp;base64,%'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'shot_artifacts'::regclass AND conname = 'shot_artifacts_placeholder_check'
  ) THEN
    ALTER TABLE shot_artifacts
      ADD CONSTRAINT shot_artifacts_placeholder_check
      CHECK (placeholder IS NULL OR (length(placeholder) <= 1400 AND placeholder LIKE 'data:image/webp;base64,%'));
  END IF;
END $$;
