-- #7215: the project a Homeroom report was filed from.
--
-- A report sent with Suggest while another project's page was open (its hub,
-- Workshop, a change or a request) keeps that project as an app id. The
-- platform's own board is public and the project may be private, so the id is
-- all the request says: no name or slug is ever written to its body.
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS about_app_id INTEGER REFERENCES apps(id) ON DELETE SET NULL;
