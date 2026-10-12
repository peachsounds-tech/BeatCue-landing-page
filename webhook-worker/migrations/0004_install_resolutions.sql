-- Free-key gate, part 1: licence tiers.
--
-- Until now every valid Lemon Squeezy key signed tier "pro". The free tier
-- becomes key-gated for part of the new-device population, so a key now has a
-- tier, derived from the product/variant it was sold under. The per-device A/B
-- arm and in-app registrations live in 0005_install_tables.sql.
--
-- Apply with:
--   wrangler d1 migrations apply beatcue-quota --local    # wrangler dev
--   wrangler d1 migrations apply beatcue-quota --remote    # remote

-- Existing rows predate free keys, so they are all paid: default 'pro'.
ALTER TABLE license_activations ADD COLUMN tier       TEXT NOT NULL DEFAULT 'pro';
ALTER TABLE license_activations ADD COLUMN product_id TEXT;
ALTER TABLE license_activations ADD COLUMN variant_id TEXT;
