/**
 * Offline self-test for the /quota/* routes.
 *
 * Runs the real worker module against an in-memory SQLite database wearing a
 * D1-shaped adapter, so the claim logic, period rollover and limit resolution
 * can be exercised without a Cloudflare account or a deploy. Covers the cases
 * that motivated the server-side ledger in the first place — chiefly that a
 * wiped install can no longer talk its way back to a full quota.
 *
 * Run with:
 *   node --experimental-sqlite scripts/quota_selftest.mjs
 *
 * Requires the migration file to be the single source of schema truth; it is
 * read from disk rather than duplicated here so the two can't drift.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// worker.js is an ES module, but package.json declares the folder as
// commonjs (wrangler does its own detection, Node does not). Loading the
// source through a data: URL sidesteps that without changing the package type
// or keeping a duplicate .mjs copy around to drift.
const workerSource = readFileSync(join(here, '..', 'worker.js'), 'utf8');
const worker = (await import(
    'data:text/javascript;base64,' + Buffer.from(workerSource, 'utf8').toString('base64')
)).default;

// ─── D1 adapter over node:sqlite ─────────────────────────────────────────────
// Implements exactly the surface the quota code uses: prepare().bind().first()
// / .all() / .run(), plus batch(). Numbered ?N placeholders bind positionally,
// which matches both SQLite's parameter indexing and D1's behaviour.
function makeD1(db) {
    const wrap = (sql, args = []) => ({
        bind: (...next) => wrap(sql, next),
        first: () => {
            const row = db.prepare(sql).get(...args);
            return row === undefined ? null : row;
        },
        all: () => ({ results: db.prepare(sql).all(...args) }),
        run: () => {
            const r = db.prepare(sql).run(...args);
            return { success: true, meta: { changes: Number(r.changes) } };
        },
        __sql: sql,
        __args: args,
    });

    return {
        prepare: sql => wrap(sql),
        batch: async stmts => stmts.map(s => s.run()),
    };
}

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(join(here, '..', 'migrations', '0001_quota.sql'), 'utf8'));
sqlite.exec(readFileSync(join(here, '..', 'migrations', '0002_license.sql'), 'utf8'));
sqlite.exec(readFileSync(join(here, '..', 'migrations', '0004_install_resolutions.sql'), 'utf8'));
sqlite.exec(readFileSync(join(here, '..', 'migrations', '0005_install_tables.sql'), 'utf8'));

// ─── Signing key for the test env ─────────────────────────────────────────────
// A throwaway Ed25519 pair: the worker signs with the private half (via the
// ENTITLEMENT_SIGNING_KEY env var it expects), and this file verifies the
// tokens with the public half, exactly as the desktop client will.
const signingPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const SIGNING_PKCS8_B64 = Buffer.from(await crypto.subtle.exportKey('pkcs8', signingPair.privateKey)).toString('base64');
const verifyKey = signingPair.publicKey;

function b64uToBuf(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

/** Verify a compact JWS the way the client will: signature over the exact
 *  header.payload bytes, then hand back the decoded claims. Returns null on any
 *  failure so a test can assert "no valid token". */
async function verifyJws(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const signingInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const sig = b64uToBuf(parts[2]);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey, sig, signingInput);
    if (!ok) return null;
    try { return JSON.parse(b64uToBuf(parts[1]).toString('utf8')); }
    catch (e) { return null; }
}

// ─── Lemon Squeezy mock ───────────────────────────────────────────────────────
// The licence routes call api.lemonsqueezy.com; intercept those (and PostHog
// captures) so the suite stays offline. `lsMock` lets a test steer the verdict.
const GOOD_KEY = 'good-key-0000-1111-2222-333344445555';
const BAD_KEY  = 'bad-key-0000-1111-2222-333344445555';

const lsMock = {
    fail: false,       // when true, simulate an unreachable upstream (throw)
    instanceSeq: 0,
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    const u = String(url);

    if (u.includes('api.lemonsqueezy.com/v1/licenses/')) {
        if (lsMock.fail) throw new Error('simulated network failure');
        const params = new URLSearchParams(init && init.body || '');
        const key = params.get('license_key');
        const action = u.split('/licenses/')[1];

        const jsonResponse = (obj, status = 200) => ({
            status,
            ok: status >= 200 && status < 300,
            json: async () => obj,
        });

        if (key !== GOOD_KEY) {
            return jsonResponse({ valid: false, error: 'license_key not found', license_key: null, meta: null }, 404);
        }

        const lk   = { status: 'active', expires_at: null };
        const meta = { customer_email: 'buyer@example.com', customer_name: 'Buyer', order_id: 42 };

        if (action === 'activate') {
            return jsonResponse({ activated: true, error: null, license_key: lk,
                                  instance: { id: `inst-${++lsMock.instanceSeq}` }, meta });
        }
        if (action === 'validate') {
            return jsonResponse({ valid: true, error: null, license_key: lk,
                                  instance: { id: params.get('instance_id') || 'inst-x' }, meta });
        }
        if (action === 'deactivate') {
            return jsonResponse({ deactivated: true, error: null });
        }
        return jsonResponse({ error: 'unknown_action' }, 400);
    }

    // PostHog capture and anything else: swallow.
    return { status: 200, ok: true, json: async () => ({}), text: async () => '' };
};

const env = {
    QUOTA_DB: makeD1(sqlite),
    ENTITLEMENT_SIGNING_KEY: SIGNING_PKCS8_B64,
    // No PAIRINGS binding: the per-IP account budget degrades to "allow", which
    // is the intended behaviour when KV is unavailable.
};

const ctx = { waitUntil: () => {} };

async function post(path, body) {
    const res = await worker.fetch(
        new Request(`https://example.test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        env,
        ctx,
    );
    return { status: res.status, body: await res.json() };
}

// ─── Tiny assertion helpers ──────────────────────────────────────────────────
let failures = 0;
let checks = 0;

function check(label, actual, expected) {
    checks++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ok   ${label}`);
    } else {
        failures++;
        console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

const hex = (seed) => seed.padEnd(64, '0').slice(0, 64);
const DEVICE = hex('d1');
const OTHER  = hex('d2');
const song   = n => hex(`ab${n}`);

// ─── Validation ──────────────────────────────────────────────────────────────
section('rejects malformed input');
{
    const r1 = await post('/quota/claim', { device_id: 'not-hex', song_hash: song(1) });
    check('bad device_id → 400', [r1.status, r1.body.error], [400, 'invalid_device_id']);

    const r2 = await post('/quota/claim', { device_id: DEVICE, song_hash: 'nope' });
    check('bad song_hash → 400', [r2.status, r2.body.error], [400, 'invalid_song_hash']);

    // Route payloads are validated before any write, so a junk claim must not
    // leave an account row behind (which would also spend the caller's per-IP
    // account-creation budget on a request that achieved nothing).
    const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM quota_accounts').get();
    check('malformed claim created no account row', Number(rows.n), 0);

    const r3 = await worker.fetch(
        new Request('https://example.test/quota/state', { method: 'GET' }), env, ctx);
    check('GET → 405', r3.status, 405);
}

// ─── First contact ───────────────────────────────────────────────────────────
section('first contact creates an account at the configured limit');
{
    const r = await post('/quota/state', { device_id: DEVICE, bcid: 'bc_abcdef12345', platform: 'windows', app_version: '3.2.0', first_launch: true });
    check('account created', r.body.account_created, true);
    check('limit from quota_config', r.body.limit, 5);
    check('nothing used yet', [r.body.used, r.body.remaining], [0, 5]);
    check('owned list empty', r.body.owned, []);
    check('bcid echoed back as canonical', r.body.bcid, 'bc_abcdef12345');
}

// ─── Claiming ────────────────────────────────────────────────────────────────
section('claims consume slots up to the limit, then refuse');
{
    for (let i = 1; i <= 5; i++) {
        const r = await post('/quota/claim', { device_id: DEVICE, song_hash: song(i) });
        check(`claim ${i} granted, remaining ${5 - i}`,
              [r.body.allowed, r.body.reason, r.body.used, r.body.remaining],
              [true, 'granted', i, 5 - i]);
    }

    const over = await post('/quota/claim', { device_id: DEVICE, song_hash: song(6) });
    check('6th claim refused', [over.body.allowed, over.body.reason, over.body.used],
          [false, 'quota_exhausted', 5]);
}

section('re-claiming an owned song is free (grandfathering)');
{
    const r = await post('/quota/claim', { device_id: DEVICE, song_hash: song(3) });
    check('already_owned, no slot consumed',
          [r.body.allowed, r.body.reason, r.body.used], [true, 'already_owned', 5]);
}

section('owned songs come back for the offline cache');
{
    const r = await post('/quota/state', { device_id: DEVICE });
    check('5 owned hashes returned', r.body.owned.length, 5);
    check('not truncated', r.body.owned_truncated, false);
}

// ─── The original exploit ────────────────────────────────────────────────────
section('a wiped install cannot reset its quota');
{
    // Same machine, but the app lost BeatCue.settings and trial.dat: no bcid,
    // reports a first launch, and tries to seed an empty history.
    const r = await post('/quota/state', {
        device_id: DEVICE,
        first_launch: true,
        seed: { hashes: [] },
    });

    check('still exhausted after "reinstall"', [r.body.used, r.body.remaining], [5, 0]);
    check('no new account row', r.body.account_created, false);
    check('seed ignored on an existing account', r.body.seeded, 0);
    check('bcid recovered for the wiped install', r.body.bcid, 'bc_abcdef12345');

    const claim = await post('/quota/claim', { device_id: DEVICE, song_hash: song(7) });
    check('new song still refused', [claim.body.allowed, claim.body.reason],
          [false, 'quota_exhausted']);
}

// ─── Migration seed ──────────────────────────────────────────────────────────
section('migration seed grants ownership without consuming the period');
{
    const seeded = [song(50), song(51), song(52)];
    const r = await post('/quota/state', {
        device_id: OTHER,
        first_launch: true,
        seed: { hashes: seeded },
    });

    check('seeded 3 songs', r.body.seeded, 3);
    check('period untouched by the seed', [r.body.used, r.body.remaining], [0, 5]);
    check('seeded songs are owned', r.body.owned.length, 3);

    const reopen = await post('/quota/claim', { device_id: OTHER, song_hash: song(50) });
    check('a seeded song opens for free', [reopen.body.allowed, reopen.body.reason],
          [true, 'already_owned']);

    const second = await post('/quota/state', { device_id: OTHER, seed: { hashes: [song(53)] } });
    check('a second seed is refused', second.body.seeded, 0);
}

// ─── Limit changes ───────────────────────────────────────────────────────────
section('raising the limit applies immediately');
{
    sqlite.exec(`UPDATE quota_config SET value='8' WHERE key='default_limit'`);
    const r = await post('/quota/state', { device_id: DEVICE });
    check('limit raised to 8 mid-period', r.body.limit, 8);
    check('3 slots freed up', r.body.remaining, 3);

    const claim = await post('/quota/claim', { device_id: DEVICE, song_hash: song(8) });
    check('claim now granted', [claim.body.allowed, claim.body.used], [true, 6]);
}

section('lowering the limit does not strand a user mid-period');
{
    // The 10 → 5 change that took a real user from "7 left" to "1 left"
    // overnight. period_limit was snapshotted at 5, usage is 6, and the new
    // default of 2 must not apply until the period rolls.
    sqlite.exec(`UPDATE quota_config SET value='2' WHERE key='default_limit'`);
    const r = await post('/quota/state', { device_id: DEVICE });
    check('still on the snapshotted limit', r.body.limit, 5);
    check('remaining floors at 0, never negative', r.body.remaining, 0);
}

section('a lowered limit takes effect at the next rollover');
{
    // Backdate the anchor by two months so the next request rolls the period.
    const twoMonthsAgo = Date.now() - 62 * 86400000;
    sqlite.exec(`UPDATE quota_accounts SET period_start=${twoMonthsAgo} WHERE device_id='${DEVICE}'`);

    const r = await post('/quota/state', { device_id: DEVICE });
    check('period rolled, limit now the configured 2', r.body.limit, 2);
    check('usage reset by the rollover', [r.body.used, r.body.remaining], [0, 2]);
    check('previously owned songs survive the rollover', r.body.owned.length >= 6, true);

    const reopen = await post('/quota/claim', { device_id: DEVICE, song_hash: song(1) });
    check('old song still free in the new period',
          [reopen.body.allowed, reopen.body.reason, reopen.body.used],
          [true, 'already_owned', 0]);
}

section('period_end is one calendar month after period_start');
{
    const r = await post('/quota/state', { device_id: DEVICE });
    const start = new Date(r.body.period_start);
    const end   = new Date(r.body.period_end);
    const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12
                 + (end.getUTCMonth() - start.getUTCMonth());
    check('exactly one month apart', months, 1);
    check('period contains now', start.getTime() <= r.body.server_time
                                 && r.body.server_time < end.getTime(), true);
}

// ─── Admin ───────────────────────────────────────────────────────────────────
section('support overrides');
{
    const noToken = await post('/quota/grant', { device_id: DEVICE, limit_override: 50 });
    check('inert without QUOTA_ADMIN_TOKEN', [noToken.status, noToken.body.error],
          [503, 'admin_disabled']);

    env.QUOTA_ADMIN_TOKEN = 'test-token';

    const wrong = await post('/quota/grant', { device_id: DEVICE, admin_token: 'nope', limit_override: 50 });
    check('wrong token → 403', wrong.status, 403);

    const unknown = await post('/quota/grant', { device_id: hex('ff'), admin_token: 'test-token', reset_period: true });
    check('unknown device → 404', unknown.status, 404);

    const ok = await post('/quota/grant', {
        device_id: DEVICE, admin_token: 'test-token',
        limit_override: 9, notes: 'support: lost work to a reinstall',
    });
    check('override applied', ok.body.ok, true);

    const after = await post('/quota/state', { device_id: DEVICE });
    check('override raises the limit', after.body.limit, 9);

    delete env.QUOTA_ADMIN_TOKEN;
}

section('config guard rails');
{
    sqlite.exec(`UPDATE quota_config SET value='banana' WHERE key='default_limit'`);
    const r = await post('/quota/state', { device_id: hex('c1'), first_launch: true });
    check('junk config falls back, never to zero', r.body.limit, 5);

    sqlite.exec(`UPDATE quota_config SET value='0' WHERE key='default_limit'`);
    const r2 = await post('/quota/state', { device_id: hex('c2'), first_launch: true });
    check('zero is clamped to the floor', r2.body.limit >= 1, true);

    sqlite.exec(`UPDATE quota_config SET value='999999' WHERE key='default_limit'`);
    const r3 = await post('/quota/state', { device_id: hex('c3'), first_launch: true });
    check('absurd config clamped to the ceiling', r3.body.limit, 1000);

    sqlite.exec(`UPDATE quota_config SET value='5' WHERE key='default_limit'`);
}

section('devices are isolated from one another');
{
    const a = await post('/quota/state', { device_id: hex('e1'), first_launch: true });
    await post('/quota/claim', { device_id: hex('e1'), song_hash: song(90) });
    const b = await post('/quota/state', { device_id: hex('e2'), first_launch: true });
    check('one device claiming does not touch another', b.body.used, 0);
    check('and ownership does not leak', b.body.owned, []);
    check('sanity: the first device did consume', a.body.used, 0);
}

// ─── Signed quota tokens ──────────────────────────────────────────────────────
section('quota responses carry a verifiable signed token');
{
    const dev = hex('51');
    const nonce = 'quota-nonce-0001';
    const machine = 'a'.repeat(32);

    const state = await post('/quota/state', {
        device_id: dev, machine_id: machine, nonce, first_launch: true,
    });
    const stok = await verifyJws(state.body.signed);
    check('state token present and verifies', stok !== null, true);
    check('token binds the device_id', stok && stok.device_id, dev);
    check('token echoes the machine_id', stok && stok.machine_id, machine);
    check('token echoes the nonce', stok && stok.nonce, nonce);
    check('token tier is free', stok && stok.tier, 'free');
    check('token quota mirrors the body', stok && [stok.quota.used, stok.quota.limit], [0, 5]);
    check('owned is inside the signed payload', Array.isArray(stok && stok.owned), true);
    check('token expires ~7 days out',
          stok && Math.round((stok.exp - stok.iat) / 86400000), 7);

    await post('/quota/claim', { device_id: dev, machine_id: machine, nonce, song_hash: song(1) });
    const claim = await post('/quota/claim', { device_id: dev, machine_id: machine, nonce, song_hash: song(2) });
    const ctok = await verifyJws(claim.body.signed);
    check('claim token present and verifies', ctok !== null, true);
    check('decision is inside the signed payload',
          ctok && [ctok.decision.song_hash, ctok.decision.allowed], [song(2), true]);
    check('signed quota matches plaintext body',
          ctok && [ctok.quota.used, ctok.quota.remaining], [claim.body.used, claim.body.remaining]);

    // A body whose numbers were edited in flight must not match the token — the
    // client trusts the token, so this is the property that matters.
    const forged = { ...claim.body, remaining: 999 };
    check('a client trusting the token ignores a forged body',
          forged.remaining !== (ctok && ctok.quota.remaining), true);
}

// ─── Licence routes ───────────────────────────────────────────────────────────
section('licence activate → validate → deactivate');
{
    const dev = hex('71');
    const machine = 'c'.repeat(32);
    const nonce = 'lic-nonce-0001';

    const bad = await post('/license/activate', {
        device_id: dev, machine_id: machine, nonce, license_key: BAD_KEY,
    });
    check('bad key is denied', [bad.body.valid, !!bad.body.signed], [false, false]);

    const act = await post('/license/activate', {
        device_id: dev, machine_id: machine, nonce, license_key: GOOD_KEY,
    });
    check('good key activates', act.body.valid, true);
    const atok = await verifyJws(act.body.signed);
    check('activation token verifies and is pro', atok && atok.tier, 'pro');
    check('activation token binds device + nonce',
          atok && [atok.device_id, atok.nonce], [dev, nonce]);
    check('activation records an instance', !!act.body.instance_id, true);
    check('licence claims inside the token',
          atok && atok.license.status, 'active');

    const row = sqlite.prepare('SELECT status, license_key FROM license_activations WHERE device_id=?').get(dev);
    check('activation cached in D1', [row.status, row.license_key], ['active', GOOD_KEY]);

    const val = await post('/license/validate', { device_id: dev, machine_id: machine, nonce });
    check('validate succeeds off the cached row', val.body.valid, true);
    check('validate returns a fresh pro token', (await verifyJws(val.body.signed))?.tier, 'pro');

    // Upstream outage: a still-active cached row keeps the user working.
    lsMock.fail = true;
    const offline = await post('/license/validate', { device_id: dev, machine_id: machine, nonce });
    check('cached token served when Lemon Squeezy is unreachable',
          [offline.body.valid, offline.body.cached], [true, true]);
    check('cached token still verifies', (await verifyJws(offline.body.signed))?.tier, 'pro');
    lsMock.fail = false;

    const deact = await post('/license/deactivate', { device_id: dev, nonce });
    check('deactivate reports success', deact.body.deactivated, true);
    const gone = sqlite.prepare('SELECT COUNT(*) AS n FROM license_activations WHERE device_id=?').get(dev);
    check('deactivate clears the D1 row', Number(gone.n), 0);
}

section('licence migration: an old key with no row validates via activate');
{
    // A user upgrading from the direct-to-Lemon-Squeezy build: no D1 row yet,
    // client sends its stored key (and old instance id) to /license/validate.
    const dev = hex('72');
    const machine = 'd'.repeat(32);
    const nonce = 'lic-nonce-0002';

    const val = await post('/license/validate', {
        device_id: dev, machine_id: machine, nonce,
        license_key: GOOD_KEY, instance_id: 'legacy-instance-1',
    });
    check('legacy key validates and issues a token', val.body.valid, true);
    check('migration token is pro', (await verifyJws(val.body.signed))?.tier, 'pro');
    const row = sqlite.prepare('SELECT status FROM license_activations WHERE device_id=?').get(dev);
    check('migration created the cache row', row && row.status, 'active');
}

section('licence input validation');
{
    const badDev = await post('/license/validate', { device_id: 'nope', nonce: 'x'.repeat(8), license_key: GOOD_KEY });
    check('bad device_id → 400', [badDev.status, badDev.body.error], [400, 'invalid_device_id']);

    const noKey = await post('/license/validate', { device_id: hex('73') });
    check('no key and no row → invalid_license_key', noKey.body.error, 'invalid_license_key');
}

console.log(`\n${checks - failures}/${checks} checks passed`);

globalThis.fetch = realFetch;
process.exit(failures ? 1 : 0);
