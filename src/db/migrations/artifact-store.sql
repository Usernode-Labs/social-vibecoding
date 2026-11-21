-- Artifacts, stage 1 (docs/plans/artifacts.md): the design tables become the
-- one store of every page Homeroom bot writes with a person
-- (services/artifacts.js). A design is one kind of artifact; a plain page is
-- another. Three columns say what the old shape left implied:
--
--   kind      what the artifact is. Every row from before is a design.
--   viewport  the size it is drawn at, by name ('phone', 'desktop'). NULL on
--             a row from before, which is read by its width as it always was.
--   place     where it lives. 'thread': its author's private thread with the
--             bot, the only place there is (nothing publishes one).
--
-- The tables keep their names (design_threads, design_versions). A release
-- runs the build from before and this one side by side for some minutes, and
-- every preview boots from a copy of production: a rename would break the
-- older build's every read. So this only ADDS. Each new column has a default
-- or is nullable, so the older build's INSERT (which names none of them)
-- still writes a valid design, and its SELECTs (which name their columns)
-- are untouched. A page written by this build is, to the older one, a
-- design of a project not made yet (surface 'new'): it can still be read,
-- drawn and edited there.

-- Each check is written with its column, so a second run adds neither and
-- nothing is ever dropped.

ALTER TABLE design_threads ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'design'
  CHECK (kind IN ('design', 'page'));
ALTER TABLE design_threads ADD COLUMN IF NOT EXISTS viewport VARCHAR(8)
  CHECK (viewport IS NULL OR viewport IN ('phone', 'desktop'));
ALTER TABLE design_threads ADD COLUMN IF NOT EXISTS place VARCHAR(16) NOT NULL DEFAULT 'thread'
  CHECK (place IN ('thread'));
