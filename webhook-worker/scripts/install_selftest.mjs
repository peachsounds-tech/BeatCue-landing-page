/**
 * Offline self-test for the free-key gate: licence tiers, /install/resolve arm
 * assignment, in-app registration via the webhook, and /quota/claim
 * enforcement.
 *
 * Same harness as quota_selftest.mjs: the real worker module over an in-memory
 * SQLite database with a D1-shaped adapter, Lemon Squeezy and PostHog mocked.
 *
 * Run with:
 *   node --experimental-sqlite scripts/install_selftest.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const workerSource = readFileSync(join(here, '..', 'worker.js'), 'utf8');
const worker = (await import(
    'data:text/javascript;base64,' + Buffer.from(workerSource, 'utf8').toString('base64')
)).default;

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
    });
    return {
        prepare: sql => wrap(sql),
        batch: async stmts => stmts.map(s => s.run()),
    };
}

const sqlite = new DatabaseSync(':memory:');
for (const f of ['0001_quota.sql', '0002_license.sql', '0003_default_limit_3.sql', '0004_install_resolutions.sql', '0005_install_tables.sql']) {
    sqlite.exec(readFileSync(join(here, '..', 'migrations', f), 'utf8'));
}

const signingPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const SIGNING_PKCS8_B64 = Buffer.from(await crypto.subtle.exportKey('pkcs8', signingPair.privateKey)).toString('base64');

function b64uToBuf(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

async function verifyJws(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, signingPair.publicKey, b64uToBuf(parts[2]),
                                          new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) return null;
    try { return JSON.parse(b64uToBuf(parts[1]).toString('utf8')); } catch (e) { return null; }
}

// ─── Mocks ───────────────────────────────────────────────────────────────────
const FREE_KEY = 'free-key-0000-1111-2222-333344445555';
const PRO_KEY  = 'pro-key-0000-1111-2222-333344445555';

const KEY_PRODUCTS = {
    [FREE_KEY]: { product_id: 1385673, variant_id: 2164536 },
    [PRO_KEY]:  { product_id: 1295253, variant_id: 2146438 },
};

let lsCalls = [];
const posthogEvents = [];
let instanceSeq = 0;

globalThis.fetch = async (url, init) => {
    const u = String(url);
    const jsonResponse = (obj, status = 200) => ({
        status, ok: status >= 200 && status < 300, json: async () => obj, text: async () => JSON.stringify(obj),
    });

    if (u.includes('api.lemonsqueezy.com/v1/licenses/')) {
        const params = new URLSearchParams(init && init.body || '');
        const key = params.get('license_key');
        const action = u.split('/licenses/')[1];
        lsCalls.push({ action, key });

        const product = KEY_PRODUCTS[key];
        if (!product) {
            return jsonResponse({ valid: false, error: 'license_key not found', license_key: null, meta: null }, 404);
        }
        const lk = { status: 'active', expires_at: null };
        const meta = { customer_email: 'buyer@example.com', order_id: 42, ...product };
        if (action === 'activate') {
            return jsonResponse({ activated: true, license_key: lk, instance: { id: `inst-${++instanceSeq}` }, meta });
        }
        if (action === 'validate') {
            return jsonResponse({ valid: true, license_key: lk, instance: { id: params.get('instance_id') }, meta });
        }
        if (action === 'deactivate') return jsonResponse({ deactivated: true });
        return jsonResponse({ error: 'unknown_action' }, 400);
    }

    if (u.includes('posthog.com')) {
        try { posthogEvents.push(JSON.parse(init.body)); } catch (e) { /* ignore */ }
    }
    return jsonResponse({});
};

const env = {
    QUOTA_DB: makeD1(sqlite),
    ENTITLEMENT_SIGNING_KEY: SIGNING_PKCS8_B64,
    EXPERIMENT_SALT: 'selftest',
};
const ctx = { waitUntil: () => {} };

async function post(path, body) {
    const res = await worker.fetch(new Request(`https://example.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }), env, ctx);
    return { status: res.status, body: await res.json() };
}

async function webhook(payload) {
    const res = await worker.fetch(new Request('https://example.test/webhook/lemonsqueezy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    }), env, ctx);
    return res.status;
}

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
    checks++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
}

let devSeq = 0;
function newDevice() {
    devSeq++;
    return devSeq.toString(16).padStart(64, 'a');
}
const MACHINE = '0123456789abcdef0123456789abcdef';
const SONG = 'b'.repeat(64);

// ─── Tiers ───────────────────────────────────────────────────────────────────
console.log('\nlicence tiers come from the Lemon Squeezy product');
{
    const d = newDevice();
    const free = await post('/license/activate', { device_id: d, machine_id: MACHINE, nonce: 'nonce-free-1', license_key: FREE_KEY });
    check('free-product key activates', free.body.valid, true);
    check('free-product key reports tier free', free.body.tier, 'free');
    check('free-product token is signed tier free', (await verifyJws(free.body.signed))?.tier, 'free');

    const d2 = newDevice();
    const pro = await post('/license/activate', { device_id: d2, machine_id: MACHINE, nonce: 'nonce-pro-1', license_key: PRO_KEY });
    check('pro-product token is signed tier pro', (await verifyJws(pro.body.signed))?.tier, 'pro');

    const val = await post('/license/validate', { device_id: d, machine_id: MACHINE, nonce: 'nonce-free-2' });
    check('validate keeps a free key free', (await verifyJws(val.body.signed))?.tier, 'free');

    const saved = { ...env };
    env.FREE_PRODUCT_IDS = '';
    env.FREE_VARIANT_IDS = '';
    const d3 = newDevice();
    const floor = await post('/license/activate', { device_id: d3, machine_id: MACHINE, nonce: 'nonce-free-3', license_key: FREE_KEY });
    check('compiled-in floor keeps free key free without vars', floor.body.tier, 'free');
    Object.assign(env, saved);
}

// ─── Experiment off ──────────────────────────────────────────────────────────
console.log('\nexperiment off: everyone resolves to existing, keyless');
{
    const d = newDevice();
    const r = await post('/install/resolve', { device_id: d });
    check('arm existing while EXPERIMENT_START unset', r.body.arm, 'existing');
    check('existing → none (keyless free tier)', r.body.action, 'none');
    check('no key handed out', r.body.license_key, undefined);

    const r2 = await post('/install/resolve', { device_id: d });
    check('arm is sticky', r2.body.arm, 'existing');
}

// ─── Assignment ──────────────────────────────────────────────────────────────
console.log('\nassignment once the experiment starts');
{
    // An account from before the start is existing, even at 100% test.
    const old = newDevice();
    await post('/quota/state', { device_id: old });
    env.EXPERIMENT_START = String(Date.now() + 1000);
    env.TEST_PERCENT = '100';
    const r = await post('/install/resolve', { device_id: old });
    check('pre-start account → existing', r.body.arm, 'existing');

    env.EXPERIMENT_START = String(Date.now() - 1000);
    env.TEST_PERCENT = '0';
    const c = newDevice();
    await post('/quota/state', { device_id: c });
    const rc = await post('/install/resolve', { device_id: c });
    check('TEST_PERCENT 0 → control', rc.body.arm, 'control');
    check('control → none (keyless, as today)', rc.body.action, 'none');

    env.TEST_PERCENT = '100';
    const rc2 = await post('/install/resolve', { device_id: c });
    check('arm does not re-roll when TEST_PERCENT changes', rc2.body.arm, 'control');
}

// ─── Test arm: gate → register → activate ────────────────────────────────────
console.log('\ntest arm: gate, register in-app, key arrives by webhook');
{
    env.TEST_PERCENT = '100';
    const d = newDevice();
    const state = await post('/quota/state', { device_id: d });
    check('state before resolve is not gated (no arm yet)', state.body.registration_required, false);

    const r = await post('/install/resolve', { device_id: d });
    check('new device at 100% → test', r.body.arm, 'test');
    check('test without key → gate', r.body.action, 'gate');
    check('gate hands out no key', r.body.license_key, undefined);

    const state2 = await post('/quota/state', { device_id: d });
    check('state now reports registration_required', state2.body.registration_required, true);

    const claim = await post('/quota/claim', { device_id: d, song_hash: SONG, nonce: 'nonce-claim-1' });
    check('claim refused', claim.body.allowed, false);
    check('refusal reason', claim.body.reason, 'registration_required');
    const claimTok = await verifyJws(claim.body.signed);
    check('refusal is signed', claimTok?.decision?.reason, 'registration_required');

    const reg1 = await post('/install/registration', { device_id: d });
    check('registration mints a reg token', /^rg_/.test(reg1.body.reg), true);
    const reg2 = await post('/install/registration', { device_id: d });
    check('repeat click reuses the reg token', reg2.body.reg, reg1.body.reg);

    const unresolved = await post('/install/registration', { device_id: newDevice() });
    check('unresolved device cannot register', unresolved.status, 409);

    posthogEvents.length = 0;
    await webhook({
        meta: { event_name: 'license_key_created', custom_data: { reg: reg1.body.reg, bcid: 'bc_selftest-0001' } },
        data: { id: 99, attributes: { key: FREE_KEY, key_short: 'XXXX-5555', user_email: 'new@example.com',
                                      status: 'inactive', product_id: 1385673 } },
    });
    const leaked = JSON.stringify(posthogEvents).includes(FREE_KEY);
    check('raw key is not sent to PostHog', leaked, false);

    const r2 = await post('/install/resolve', { device_id: d });
    check('parked key → activate', r2.body.action, 'activate');
    check('returns the user key', r2.body.license_key, FREE_KEY);

    const act = await post('/license/activate', { device_id: d, machine_id: MACHINE, nonce: 'nonce-user-1', license_key: FREE_KEY });
    check('user key activates as free', act.body.tier, 'free');

    const r3 = await post('/install/resolve', { device_id: d });
    check('activated device resolves to none', r3.body.action, 'none');
    check('arm stays test', r3.body.arm, 'test');

    const claim2 = await post('/quota/claim', { device_id: d, song_hash: SONG, nonce: 'nonce-claim-2' });
    check('claim granted after registration', claim2.body.allowed, true);

    const reg = sqlite.prepare('SELECT completed_at FROM registrations WHERE reg = ?').get(reg1.body.reg);
    check('registration closed', reg.completed_at > 0, true);
    const link = sqlite.prepare("SELECT device_id FROM quota_identity_links WHERE kind = 'license'").get();
    check('key linked to the quota account', link?.device_id, d);
}

console.log('\nwebhook ignores pro keys and unknown regs');
{
    const d = newDevice();
    await post('/quota/state', { device_id: d });
    await post('/install/resolve', { device_id: d });
    const reg = (await post('/install/registration', { device_id: d })).body.reg;

    await webhook({
        meta: { event_name: 'license_key_created', custom_data: { reg } },
        data: { id: 100, attributes: { key: PRO_KEY, user_email: 'p@example.com', product_id: 1295253 } },
    });
    check('pro key is not parked', (await post('/install/resolve', { device_id: d })).body.action, 'gate');

    await webhook({
        meta: { event_name: 'license_key_created', custom_data: { reg: 'rg_doesnotexist0000000000' } },
        data: { id: 101, attributes: { key: FREE_KEY, user_email: 'x@example.com', product_id: 1385673 } },
    });
    check('unknown reg parks nothing', (await post('/install/resolve', { device_id: d })).body.action, 'gate');
}

// ─── Kill switch ─────────────────────────────────────────────────────────────
console.log('\nGATE_ENABLED=false releases gated devices');
{
    env.TEST_PERCENT = '100';
    const d = newDevice();
    await post('/quota/state', { device_id: d });
    check('gated first', (await post('/install/resolve', { device_id: d })).body.action, 'gate');

    env.GATE_ENABLED = 'false';
    const r = await post('/install/resolve', { device_id: d });
    check('gate off → none (keyless free tier)', r.body.action, 'none');
    const claim = await post('/quota/claim', { device_id: d, song_hash: 'c'.repeat(64), nonce: 'nonce-claim-3' });
    check('claim allowed with gate off', claim.body.allowed, true);
    env.GATE_ENABLED = 'true';

    const owned = await post('/quota/claim', { device_id: d, song_hash: 'c'.repeat(64), nonce: 'nonce-claim-4' });
    check('gate back on: an owned song is refused too', owned.body.reason, 'registration_required');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
