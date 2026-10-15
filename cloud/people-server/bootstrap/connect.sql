-- Run as superuser after roles.sql, connected to the people database.
-- Kept apart because PGlite (tests) refuses REVOKE CONNECT ("tuple concurrently deleted").
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO people_owner, people_app, people_export, people_backup', current_database());
END
$$;
