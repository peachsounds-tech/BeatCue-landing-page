-- What each order was actually worth, so a conversion can carry the real
-- amount instead of a flat estimate.
--
-- The desktop app fires the purchase conversion on licence activation, where
-- it knows only that the licence is Pro — not the plan, not the price, and not
-- whether anything was paid at all. Lemon Squeezy's order_created webhook is
-- the one moment that knows, so the amount is recorded here and stamped onto
-- the conversion when it arrives (see purchaseValueFor in worker.js).
--
-- Apply with:
--   wrangler d1 migrations apply beatcue-quota --local
--   wrangler d1 migrations apply beatcue-quota --remote

CREATE TABLE IF NOT EXISTS order_values (
    order_id    TEXT    PRIMARY KEY,

    -- Whoever the order resolved to. Both are kept: the account can be null
    -- when the checkout carried no ids, and the email hash still finds it once
    -- the buyer activates with the same address.
    account_id  TEXT,
    email_hash  TEXT    NOT NULL,

    -- As charged, after discounts, in the order's own currency. A $0
    -- early-access grant is stored as 0 — that is the point.
    total       REAL    NOT NULL,
    currency    TEXT    NOT NULL,

    product_name TEXT,
    variant_name TEXT,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_values_account
    ON order_values (account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_order_values_email
    ON order_values (email_hash, created_at);
