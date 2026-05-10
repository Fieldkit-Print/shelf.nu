-- =============================================================================
-- FDW setup on the Shelf side (Shelf reads from Carbon via `carbon_remote`)
--
-- Run AFTER:
--   1. CONTRACT_VIEWS_CARBON.sql has been applied on the Carbon database, AND
--   2. The `shelf_fdw_reader` role on Carbon has a real password set (rotate
--      out of the REPLACE_ME placeholder from the contract-views file).
--
-- Apply this on the Shelf Supabase project's SQL editor.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- ⚠️ Direct connection (port 5432), NOT the pgbouncer pool (6543).
-- ⚠️ Replace `<carbon-project-ref>` with the Carbon Supabase project ref.
CREATE SERVER IF NOT EXISTS carbon_db
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (
    host 'db.<carbon-project-ref>.supabase.co',
    port '5432',
    dbname 'postgres',
    fetch_size '500'
  );

-- Map the Shelf application's roles. Replace `<password>` with the actual
-- password from Carbon's `shelf_fdw_reader` role (stored in Shelf's
-- Supabase Vault).
DROP USER MAPPING IF EXISTS FOR authenticated SERVER carbon_db;
CREATE USER MAPPING FOR authenticated
  SERVER carbon_db
  OPTIONS (user 'shelf_fdw_reader', password '<password>');

DROP USER MAPPING IF EXISTS FOR service_role SERVER carbon_db;
CREATE USER MAPPING FOR service_role
  SERVER carbon_db
  OPTIONS (user 'shelf_fdw_reader', password '<password>');

DROP SCHEMA IF EXISTS carbon_remote CASCADE;
CREATE SCHEMA carbon_remote;

IMPORT FOREIGN SCHEMA public_api
  FROM SERVER carbon_db
  INTO carbon_remote;

GRANT USAGE ON SCHEMA carbon_remote TO authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA carbon_remote
  TO authenticated, service_role;

-- Sanity-check query (run manually after applying):
--   SELECT count(*) FROM carbon_remote.v1_customers
--     WHERE company_id = 'd742au0gqeb4g2dcj3rg';
