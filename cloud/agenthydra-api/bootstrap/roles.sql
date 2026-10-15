-- Run ONCE as a Postgres superuser by the deploy script, before migrations.
-- Idempotent. Passwords are NEVER in SQL: the deploy script sets them with
--   ALTER ROLE agenthydra_app PASSWORD :'pw'   (psql variable read from the env file).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agenthydra_owner') THEN
    CREATE ROLE agenthydra_owner LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agenthydra_app') THEN
    CREATE ROLE agenthydra_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agenthydra_export') THEN
    CREATE ROLE agenthydra_export LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agenthydra_backup') THEN
    -- pg_dump must read every row, so this one role bypasses RLS (read-only grants in 0004).
    CREATE ROLE agenthydra_backup LOGIN NOSUPERUSER BYPASSRLS;
  END IF;
END
$$;

GRANT CREATE, USAGE ON SCHEMA public TO agenthydra_owner;
GRANT USAGE ON SCHEMA public TO agenthydra_app, agenthydra_export, agenthydra_backup;
