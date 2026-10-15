-- Run as superuser after roles.sql, connected to the agenthydra database.
-- Kept apart because PGlite (tests) refuses REVOKE CONNECT ("tuple concurrently deleted").
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO agenthydra_owner, agenthydra_app, agenthydra_export, agenthydra_backup', current_database());
END
$$;
