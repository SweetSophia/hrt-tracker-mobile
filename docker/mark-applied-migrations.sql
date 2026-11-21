-- Reconcile a database that predates `wrangler d1 migrations apply`.
--
-- Older deployments got their schema from schema.sql plus DDL the worker ran
-- lazily at request time, never from the numbered migrations, so wrangler's
-- ledger is empty even though the effects of 0001-0005 are present, and
-- 0002 / 0005 are ALTER TABLE ADD COLUMN, which fail on a column that exists.
-- Each statement records a migration as applied only when its effect is
-- already in the database. Safe to run any number of times, on any database;
-- a fresh one matches nothing and every migration runs normally. Run it
-- through docker/reconcile.mjs, which first adds users.totp_last_step to a
-- database that has only half of 0005, and creates the donation trade index
-- when the worker already added monero_payout_address.
CREATE TABLE IF NOT EXISTS d1_migrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0001_add_dosage_shares.sql'
    WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dosage_shares');
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0002_add_live_dosage_shares.sql'
    WHERE EXISTS (SELECT 1 FROM pragma_table_info('dosage_shares') WHERE name = 'updated_at');
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0003_add_content_user_index.sql'
    WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_content_user_created');
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0004_add_site_notice.sql'
    WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site_notice');
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0005_users_totp_columns.sql'
    WHERE EXISTS (SELECT 1 FROM pragma_table_info('users') WHERE name = 'totp_last_step');

-- 0017 adds monero_payout_address, donation_trades, and its created_at index.
-- ensureDonationSchema() can do the first two before this file is recorded,
-- and the ALTER then fails with a duplicate column. Reconcile creates the
-- index first. Record 0017 only when all three effects exist. Leave 0016
-- unmarked: its CREATE is IF NOT EXISTS, and its INSERT OR IGNORE still fills
-- donation_addresses.id = 1 without replacing stored addresses.
INSERT OR IGNORE INTO d1_migrations (name) SELECT '0017_donation_trocador.sql'
    WHERE EXISTS (SELECT 1 FROM pragma_table_info('donation_addresses') WHERE name = 'monero_payout_address')
      AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'donation_trades')
      AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_donation_trades_created_at');
