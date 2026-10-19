-- ─── Identity graph ──────────────────────────────────────────────────────────
--
-- One canonical account per human (`acct_<uuid>`), minted here and nowhere
-- else. Every other identifier any surface has ever produced — web bcid,
-- hardware seed, device id, install id, Premiere panel id, email hash,
-- licence, Store campaign id — is a node pointing at an account. It is the
-- only PostHog distinct_id that is ever identified; the rest stay anonymous
-- aliases, so merging them into it can never be refused.
--
-- Accounts that turn out to be the same person are merged by pointing the
-- younger one at the older (`merged_into`), never by deleting rows: a client
-- still holding the losing id is redirected on its next resolve, and the
-- history of every merge stays auditable through identity_merges.

CREATE TABLE IF NOT EXISTS accounts (
    account_id  TEXT    PRIMARY KEY,   -- acct_<uuid>
    merged_into TEXT,                  -- NULL = live root; else follow to root
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_merged_into
    ON accounts (merged_into);

CREATE TABLE IF NOT EXISTS identity_nodes (
    kind        TEXT    NOT NULL,      -- bcid|hw|device|install|panel|email_hash|license|store_cid|ph_distinct
    value       TEXT    NOT NULL,
    account_id  TEXT    NOT NULL,
    evidence    TEXT    NOT NULL,      -- what tied this node to the account
    ph_linked   INTEGER NOT NULL DEFAULT 0,  -- folded into the PostHog person yet
    created_at  INTEGER NOT NULL,

    PRIMARY KEY (kind, value)
);

CREATE INDEX IF NOT EXISTS idx_identity_nodes_account
    ON identity_nodes (account_id);

CREATE TABLE IF NOT EXISTS identity_merges (
    loser       TEXT    NOT NULL,
    winner      TEXT    NOT NULL,
    evidence    TEXT    NOT NULL,
    ph_linked   INTEGER NOT NULL DEFAULT 0,
    at          INTEGER NOT NULL,

    PRIMARY KEY (loser)
);

CREATE INDEX IF NOT EXISTS idx_identity_merges_winner
    ON identity_merges (winner);
