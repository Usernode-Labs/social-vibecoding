-- SEC-09 (3 Nov 2026): every change to who is an administrator is recorded
-- where neither runtime login can change the record.
--
-- Web authenticates every person and names who asks for each action, so a
-- compromised web process can act as any of them, an administrator
-- included (docs/security/database-roles.md, "Web is the authentication
-- boundary"). What this log adds is that such a process cannot also make a
-- lasting grant quietly: making someone a platform admin, a view-only admin
-- or a project's admin, or taking it away, writes a row here, with the
-- database login that made the change. Web and the conductor may read the
-- log and write none of it (database-role-grants.js EVIDENCE): only these
-- triggers, running as the log's owner, append to it, and only the owner
-- could disable them.

CREATE TABLE IF NOT EXISTS privilege_changes (
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- The database login whose statement made the change (session_user: the
  -- trigger runs as the log's owner, the statement as its caller).
  login      TEXT NOT NULL,
  change     TEXT NOT NULL CHECK (change IN ('platform_admin', 'app_admin')),
  user_id    INTEGER NOT NULL,
  app_id     INTEGER,
  -- users: { is_admin, admin_readonly }; app_admins: { app_id, user_id }.
  -- NULL before a row was made, and after it was removed.
  before     JSONB,
  after      JSONB
);
CREATE INDEX IF NOT EXISTS privilege_changes_changed_at_idx ON privilege_changes (changed_at);

CREATE OR REPLACE FUNCTION record_privilege_change() RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    INSERT INTO public.privilege_changes (login, change, user_id, before, after)
    VALUES (session_user, 'platform_admin', COALESCE(NEW.id, OLD.id),
      CASE WHEN TG_OP = 'INSERT' THEN NULL
        ELSE pg_catalog.jsonb_build_object('is_admin', OLD.is_admin, 'admin_readonly', OLD.admin_readonly) END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL
        ELSE pg_catalog.jsonb_build_object('is_admin', NEW.is_admin, 'admin_readonly', NEW.admin_readonly) END);
  ELSE
    INSERT INTO public.privilege_changes (login, change, user_id, app_id, before, after)
    VALUES (session_user, 'app_admin', COALESCE(NEW.user_id, OLD.user_id), COALESCE(NEW.app_id, OLD.app_id),
      CASE WHEN TG_OP = 'INSERT' THEN NULL
        ELSE pg_catalog.jsonb_build_object('app_id', OLD.app_id, 'user_id', OLD.user_id) END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL
        ELSE pg_catalog.jsonb_build_object('app_id', NEW.app_id, 'user_id', NEW.user_id) END);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
-- Only its triggers call it (a trigger function cannot be called directly);
-- nobody needs EXECUTE, and a definer function anyone may execute is one the
-- debug login's policy refuses (services/debug-role-policy.js).
REVOKE ALL ON FUNCTION record_privilege_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS users_record_admin_insert ON users;
CREATE TRIGGER users_record_admin_insert AFTER INSERT ON users
  FOR EACH ROW WHEN (NEW.is_admin) EXECUTE FUNCTION record_privilege_change();
DROP TRIGGER IF EXISTS users_record_admin_change ON users;
CREATE TRIGGER users_record_admin_change AFTER UPDATE OF is_admin, admin_readonly ON users
  FOR EACH ROW WHEN (OLD.is_admin IS DISTINCT FROM NEW.is_admin OR OLD.admin_readonly IS DISTINCT FROM NEW.admin_readonly)
  EXECUTE FUNCTION record_privilege_change();
DROP TRIGGER IF EXISTS users_record_admin_delete ON users;
CREATE TRIGGER users_record_admin_delete AFTER DELETE ON users
  FOR EACH ROW WHEN (OLD.is_admin) EXECUTE FUNCTION record_privilege_change();
DROP TRIGGER IF EXISTS app_admins_record_change ON app_admins;
CREATE TRIGGER app_admins_record_change AFTER INSERT OR UPDATE OR DELETE ON app_admins
  FOR EACH ROW EXECUTE FUNCTION record_privilege_change();

-- The owner's default privileges gave the runtime logins writes on the new
-- table as it was made; take every grant but SELECT now, so there is no
-- window before the release's grants run (which keep it so).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_class c
             CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
            WHERE c.oid = 'public.privilege_changes'::regclass AND a.grantee <> c.relowner AND a.grantee <> 0
  LOOP
    EXECUTE pg_catalog.format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.privilege_changes FROM %I',
      pg_catalog.pg_get_userbyid(r.grantee));
  END LOOP;
END $$;
REVOKE ALL ON public.privilege_changes FROM PUBLIC;
