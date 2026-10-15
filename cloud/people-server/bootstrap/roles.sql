-- Run ONCE as a Postgres superuser by the deploy script, before migrations.
-- Idempotent. Passwords are NEVER in SQL: the deploy script sets them with
--   ALTER ROLE people_app PASSWORD :'pw'   (psql variable read from the env file).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'people_owner') THEN
    CREATE ROLE people_owner LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'people_app') THEN
    CREATE ROLE people_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'people_export') THEN
    CREATE ROLE people_export LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'people_backup') THEN
    -- pg_dump must read every row, so this one role bypasses RLS (read-only grants in 0004).
    CREATE ROLE people_backup LOGIN NOSUPERUSER BYPASSRLS;
  END IF;
END
$$;

GRANT CREATE, USAGE ON SCHEMA public TO people_owner;
GRANT USAGE ON SCHEMA public TO people_app, people_export, people_backup;
