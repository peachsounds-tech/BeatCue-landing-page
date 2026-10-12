-- Free-key gate, part 2: per-device A/B arm and in-app registrations.
--
-- Control and existing devices stay on the keyless free tier as today; test
-- devices must register a free key from inside the app before editing.
--
-- Apply with:
--   wrangler d1 migrations apply beatcue-quota --local    # wrangler dev
--   wrangler d1 migrations apply beatcue-quota --remote    # remote

-- ─── Experiment arm per device ───────────────────────────────────────────────
-- Written by the first POST /install/resolve and never re-rolled, so a device
-- keeps its arm across reinstalls (device_id is a hardware hash) and across
-- changes to TEST_PERCENT.
CREATE TABLE IF NOT EXISTS install_resolutions (
    device_id        TEXT    PRIMARY KEY,

    -- 'existing' (account predates EXPERIMENT_START; never gated, excluded from
    -- analysis) | 'control' (keyless, as today) | 'test' (must register).
    arm              TEXT    NOT NULL,

    bcid             TEXT,
    platform         TEXT,
    app_version      TEXT,

    assigned_at      INTEGER NOT NULL,
    -- When a registered free key was first activated on this device.
    key_activated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_install_resolutions_arm
    ON install_resolutions (arm, assigned_at);

-- ─── In-app registrations ────────────────────────────────────────────────────
-- One row per "Activate free plan" click. The reg token rides the checkout as
-- checkout[custom][reg]; the license_key_created webhook uses it to park the
-- new key against the device that asked, and the app collects it on its next
-- /install/resolve. Nothing here depends on the browser matching the machine.
CREATE TABLE IF NOT EXISTS registrations (
    reg                 TEXT    PRIMARY KEY,
    device_id           TEXT    NOT NULL,
    created_at          INTEGER NOT NULL,

    -- Filled by the webhook. Kept until the device activates it so a restart
    -- mid-flow doesn't lose the key.
    pending_license_key TEXT,
    email_hash          TEXT,
    key_received_at     INTEGER,

    -- Set when the device activated the key.
    completed_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_registrations_device
    ON registrations (device_id, created_at);
