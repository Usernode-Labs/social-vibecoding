-- 20 Nov 2026: a still's smaller copies say their own type. The screen copy
-- is now a progressive JPEG (services/shots-sized.js), so a copy is no
-- longer always WebP, and routes/shots.js serves each copy with the type it
-- was saved as. NULL is every copy saved before this: WebP, and still served
-- as WebP. Those are left as they are rather than re-encoded, because their
-- addresses (?size=thumb, ?size=screen) are cached by browsers as immutable,
-- and new bytes under the same address would never reach them.
ALTER TABLE shot_run_files
  ADD COLUMN IF NOT EXISTS thumb_content_type VARCHAR(32),
  ADD COLUMN IF NOT EXISTS screen_content_type VARCHAR(32);

ALTER TABLE shot_artifacts
  ADD COLUMN IF NOT EXISTS thumb_content_type VARCHAR(32),
  ADD COLUMN IF NOT EXISTS screen_content_type VARCHAR(32);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'shot_run_files'::regclass AND conname = 'shot_run_files_copy_types_check'
  ) THEN
    ALTER TABLE shot_run_files
      ADD CONSTRAINT shot_run_files_copy_types_check
      CHECK ((thumb_content_type IS NULL OR thumb_content_type IN ('image/webp', 'image/jpeg'))
         AND (screen_content_type IS NULL OR screen_content_type IN ('image/webp', 'image/jpeg')));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'shot_artifacts'::regclass AND conname = 'shot_artifacts_copy_types_check'
  ) THEN
    ALTER TABLE shot_artifacts
      ADD CONSTRAINT shot_artifacts_copy_types_check
      CHECK ((thumb_content_type IS NULL OR thumb_content_type IN ('image/webp', 'image/jpeg'))
         AND (screen_content_type IS NULL OR screen_content_type IN ('image/webp', 'image/jpeg')));
  END IF;
END $$;
