-- Mobile → desktop hand-off by email.
--
-- A phone visitor on the landing page can't install BeatCue, so the page asks
-- for their email and POST /handoff/email mails them a /download link carrying
-- their bcid and ad click ids. One row per request: the lead list, the
-- per-email / per-IP rate limit, and the delivery record.
--
-- Apply with:
--   wrangler d1 migrations apply beatcue-quota --local    # wrangler dev
--   wrangler d1 migrations apply beatcue-quota --remote    # remote

CREATE TABLE IF NOT EXISTS handoff_emails (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT    NOT NULL,
    email_hash   TEXT    NOT NULL,
    bcid         TEXT    NOT NULL,
    ip_hash      TEXT,
    country      TEXT,
    device       TEXT,
    placement    TEXT,
    utms         TEXT,
    click_ids    TEXT,
    download_url TEXT    NOT NULL,
    sent         INTEGER NOT NULL DEFAULT 0,
    provider_id  TEXT,
    error        TEXT,
    created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoff_emails_hash ON handoff_emails (email_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_handoff_emails_ip   ON handoff_emails (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_handoff_emails_bcid ON handoff_emails (bcid);
