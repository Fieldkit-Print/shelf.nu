-- =============================================================================
-- FDW setup on the Carbon side (Carbon reads from Shelf via `shelf_remote`)
--
-- Run AFTER:
--   1. CONTRACT_VIEWS_SHELF.sql has been applied on the Shelf database, AND
--   2. The `carbon_fdw_reader` role on Shelf has a real password set (rotate
--      out of the REPLACE_ME placeholder from the contract-views file).
--
-- Apply this on the Carbon Supabase project's SQL editor.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- ⚠️ Direct connection (port 5432), NOT the pgbouncer pool (6543). FDW
-- relies on session-level prepared statements that transaction-mode
-- pooling breaks.
--
-- ⚠️ Replace `<shelf-project-ref>` with the Shelf Supabase project ref.
-- Optionally set `sslmode=require` in `options` when running outside
-- Supabase's managed network.
CREATE SERVER IF NOT EXISTS shelf_db
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (
    host 'db.<shelf-project-ref>.supabase.co',
    port '5432',
    dbname 'postgres',
    fetch_size '500'
  );

-- The Carbon-side role(s) that will issue FDW queries. We map both
-- `authenticated` (for any Supabase auth user) and `service_role` (for
-- backend jobs). Replace `<password>` with the actual password from
-- Shelf's `carbon_fdw_reader` role (stored in Carbon's Supabase Vault).
DROP USER MAPPING IF EXISTS FOR authenticated SERVER shelf_db;
CREATE USER MAPPING FOR authenticated
  SERVER shelf_db
  OPTIONS (user 'carbon_fdw_reader', password '<password>');

DROP USER MAPPING IF EXISTS FOR service_role SERVER shelf_db;
CREATE USER MAPPING FOR service_role
  SERVER shelf_db
  OPTIONS (user 'carbon_fdw_reader', password '<password>');

CREATE SCHEMA IF NOT EXISTS shelf_remote;

-- Re-import on each run so view additions / column changes on Shelf flow
-- through. `DROP ... CASCADE` cleans stale foreign tables.
DROP SCHEMA IF EXISTS shelf_remote CASCADE;
CREATE SCHEMA shelf_remote;

IMPORT FOREIGN SCHEMA public_api
  FROM SERVER shelf_db
  INTO shelf_remote;

-- Carbon-side grants. By default Postgres needs USAGE on the schema and
-- SELECT on each foreign table.
GRANT USAGE ON SCHEMA shelf_remote TO authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA shelf_remote
  TO authenticated, service_role;

-- Sanity-check query (run manually after applying):
--   SELECT count(*) FROM shelf_remote.v1_assets;
