-- Threads, one loop (phase C1): a design is something any private thread in
-- a person's chat with Homeroom bot can hold, not only one opened from a
-- captured screen. The bot draws a screen from words (design-bot.js
-- write_screen) in a "+" thread, an idea, a thread about a request or a
-- change, or a draft, and the first version it writes there gives the
-- thread its design_threads row (services/design-threads.js ensureDesign).
-- A design for no project yet, a new one, is drawn with the native kit:
-- its surface is 'new'.

ALTER TABLE design_threads DROP CONSTRAINT IF EXISTS design_threads_surface_check;
ALTER TABLE design_threads ADD CONSTRAINT design_threads_surface_check
  CHECK (surface IN ('platform', 'app', 'new'));
