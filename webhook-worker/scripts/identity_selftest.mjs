/**
 * Offline self-test for the identity graph: account minting, node linking,
 * account merges, and the PostHog merges they produce, through the real
 * routes (/identity/resolve, /pairings/claim, /quota/state, /license/activate
 * and the Lemon Squeezy webhook).
 *
 * Same harness as install_selftest.mjs: the real worker module over an
 * in-memory SQLite database with a D1-shaped adapter, everything upstream
 * mocked.
 *
 * Run with:
 *   node --experimental-sqlite scripts/identity_selftest.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
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

function makeKV() {
    const m = new Map();
    return {
        get: async k => (m.has(k) ? m.get(k) : null),
        put: async (k, v) => { m.set(k, v); },
        delete: async k => { m.delete(k); },
    };
}

const sqlite = new DatabaseSync(':memory:');
const migrationsDir = join(here, '..', 'migrations');
for (const f of readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(migrationsDir, f), 'utf8'));
}

const signingPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const SIGNING_PKCS8_B64 = Buffer.from(await crypto.subtle.exportKey('pkcs8', signingPair.privateKey)).toString('base64');

// ─── Mocks ───────────────────────────────────────────────────────────────────
const PRO_KEY = 'pro-key-0000-1111-2222-333344445555';
const BUYER_EMAIL = 'buyer@example.com';

const posthogEvents = [];

globalThis.fetch = async (url, init) => {
    const u = String(url);
    const jsonResponse = (obj, status = 200) => ({
        status, ok: status >= 200 && status < 300, json: async () => obj, text: async () => JSON.stringify(obj),
    });

    if (u.includes('api.lemonsqueezy.com/v1/licenses/')) {
        const params = new URLSearchParams(init && init.body || '');
        const action = u.split('/licenses/')[1];
        const lk = { status: 'active', expires_at: null };
        const meta = { customer_email: BUYER_EMAIL, order_id: 42, product_id: 1295253, variant_id: 2146438 };
        if (action === 'activate') {
            return jsonResponse({ activated: true, license_key: lk, instance: { id: 'inst-1' }, meta });
        }
        if (action === 'validate') {
            return jsonResponse({ valid: true, license_key: lk, instance: { id: params.get('instance_id') }, meta });
        }
        return jsonResponse({ deactivated: true });
    }

    if (u.includes('posthog.com')) {
        try {
            const body = JSON.parse(init.body);
            for (const e of (body.batch || [body])) posthogEvents.push(e);
        } catch (e) { /* ignore */ }
    }
    return jsonResponse({});
};

const env = {
    QUOTA_DB: makeD1(sqlite),
    PAIRINGS: makeKV(),
    ENTITLEMENT_SIGNING_KEY: SIGNING_PKCS8_B64,
    EXPERIMENT_SALT: 'selftest',
};

let pending = [];
const ctx = { waitUntil: p => { pending.push(p); } };
async function settle() {
    while (pending.length) {
        const batch = pending;
        pending = [];
        await Promise.all(batch);
    }
}

async function post(path, body, headers = {}) {
    const res = await worker.fetch(new Request(`https://example.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
        body: JSON.stringify(body),
    }), env, ctx);
    const out = { status: res.status, body: await res.json().catch(() => null) };
    await settle();
    return out;
}

async function resolve(nodes, extra = {}) {
    return (await post('/identity/resolve', { nodes, client: 'test', ...extra })).body;
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
    return devSeq.toString(16).padStart(64, 'c');
}
const hwOf = d => 'hw_' + d.slice(0, 16);
const merges = () => posthogEvents.filter(e => e.event === '$merge_dangerously');
const mergedInto = acct => merges().filter(e => e.distinct_id === acct).map(e => e.properties.alias);
const ACCT_RE = /^acct_[0-9a-f]{32}$/;

// ─── Store-direct install ────────────────────────────────────────────────────
console.log('\nstore-direct install gets an account from its device alone');
const devA = newDevice();
let acctA;
{
    const r = await resolve([{ kind: 'device', value: devA }], { evidence: 'device' });
    acctA = r.account_id;
    check('account minted', ACCT_RE.test(acctA || ''), true);
    check('same device resolves to the same account', (await resolve([{ kind: 'device', value: devA }])).account_id, acctA);
    check('hw_ seed folded into the account person', mergedInto(acctA).includes(hwOf(devA)), true);
    check('device id itself is never sent to PostHog', mergedInto(acctA).includes(devA), false);
}

// ─── Web visitor ─────────────────────────────────────────────────────────────
console.log('\nan unlinked web visitor does not mint an account');
const webBcid = 'bc_11111111-2222-3333-4444-555555555555';
{
    check('bcid alone resolves to nothing', (await resolve([{ kind: 'bcid', value: webBcid }])).account_id, null);
    check('...and nothing was stored', sqlite.prepare(`SELECT COUNT(*) AS n FROM identity_nodes WHERE value = ?`).get(webBcid).n, 0);
}

// ─── URL hand-off ────────────────────────────────────────────────────────────
console.log('\na ?aid= hand-off attaches the browser to the account');
{
    const r = await resolve([{ kind: 'bcid', value: webBcid }], { account_id: acctA, evidence: 'url_handoff' });
    check('bcid resolves to the hinted account', r.account_id, acctA);
    check('bcid now resolves on its own', (await resolve([{ kind: 'bcid', value: webBcid }])).account_id, acctA);
    check('bcid person folded into the account', mergedInto(acctA).includes(webBcid), true);
    check('unknown account hint is ignored', (await resolve([], { account_id: 'acct_' + '0'.repeat(32) })).account_id, null);
}

// ─── Heuristic pairing ───────────────────────────────────────────────────────
console.log('\nan IP-matched pairing claim links the install to the visitor');
const devB = newDevice();
const pairBcid = 'bc_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let acctB;
{
    await post('/pairings', { bcid: pairBcid }, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' });
    const claim = await post('/pairings/claim', { device_id: devB, os: 'win' },
                             { 'user-agent': 'BeatCue/3.3 (Windows)' });
    check('claim hit via ip', claim.body.via, 'ip');
    acctB = claim.body.account_id;
    check('claim returns an account', ACCT_RE.test(acctB || ''), true);
    check('device and bcid share the account', (await resolve([{ kind: 'bcid', value: pairBcid }])).account_id, acctB);
    const ev = sqlite.prepare(`SELECT evidence FROM identity_nodes WHERE kind = 'bcid' AND value = ?`).get(pairBcid);
    check('heuristic link is tagged ip_asn', ev && ev.evidence, 'ip_asn');
}

// ─── Quota keeps working and reports the account ─────────────────────────────
console.log('\n/quota/state carries the account');
{
    const q = await post('/quota/state', { device_id: devB, machine_id: '0123456789abcdef0123456789abcdef', nonce: 'nonce-q-1' });
    check('quota ok', q.body.ok, true);
    check('quota reports the account', q.body.account_id, acctB);
}

// ─── Purchase with lost ids, then licence activation ─────────────────────────
console.log('\nan order that lost every id still lands on the buyer after activation');
const emailHash = await (async () => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BUYER_EMAIL));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
})();
let orderAcct;
{
    posthogEvents.length = 0;
    const status = (await worker.fetch(new Request('https://example.test/webhook/lemonsqueezy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            meta: { event_name: 'order_created', custom_data: {} },
            data: { id: '9001', attributes: {
                user_email: BUYER_EMAIL, total: 2400, currency: 'USD', status: 'paid',
                first_order_item: { product_id: 1295253, variant_id: 2146438, product_name: 'BeatCue Pro' },
            } },
        }),
    }), env, ctx)).status;
    await settle();
    check('webhook ok', status, 200);
    const order = posthogEvents.find(e => e.event === 'checkout_completed');
    orderAcct = order && order.distinct_id;
    check('order recorded under an account (from the email)', ACCT_RE.test(orderAcct || ''), true);
    check('legacy hashed-email person folded in', mergedInto(orderAcct).includes(emailHash), true);

    // devB (acctB) activates the key bought with that email.
    posthogEvents.length = 0;
    const act = await post('/license/activate', {
        device_id: devB, machine_id: '0123456789abcdef0123456789abcdef', nonce: 'nonce-l-1', license_key: PRO_KEY,
    });
    check('activation ok', act.body.valid, true);
    const older = [acctB, orderAcct].sort((a, b) => {
        const at = id => sqlite.prepare(`SELECT created_at FROM accounts WHERE account_id = ?`).get(id).created_at;
        return (at(a) - at(b)) || (a < b ? -1 : 1);
    })[0];
    check('activation merges the order account and the install account', act.body.account_id, older);
    const younger = older === acctB ? orderAcct : acctB;
    check('younger account folded into the older person', mergedInto(older).includes(younger), true);
    check('merge recorded', !!sqlite.prepare(`SELECT 1 FROM identity_merges WHERE loser = ? AND winner = ?`).get(younger, older), true);
    check('merge announced', posthogEvents.some(e => e.event === 'identity_accounts_merged'), true);
    check('client holding the losing id is redirected', (await resolve([], { account_id: younger })).account_id, older);
    check('device, bcid and email all resolve to one account',
        new Set([
            (await resolve([{ kind: 'device', value: devB }])).account_id,
            (await resolve([{ kind: 'bcid', value: pairBcid }])).account_id,
            (await resolve([{ kind: 'email_hash', value: emailHash }])).account_id,
        ]).size, 1);
}

// ─── Merging two established accounts ────────────────────────────────────────
console.log('\nevidence tying two accounts together merges them into the oldest');
{
    const before = (await resolve([{ kind: 'device', value: devB }])).account_id;
    const r = await resolve([{ kind: 'device', value: devA }, { kind: 'device', value: devB }], { evidence: 'backfill' });
    const root = [acctA, before].sort((a, b) => {
        const at = id => sqlite.prepare(`SELECT created_at FROM accounts WHERE account_id = ?`).get(id).created_at;
        return (at(a) - at(b)) || (a < b ? -1 : 1);
    })[0];
    check('both devices end on the oldest account', r.account_id, root);
    check('every account chain ends at that root',
        new Set([acctA, acctB, orderAcct].map(a => {
            let cur = a;
            for (;;) {
                const row = sqlite.prepare(`SELECT merged_into FROM accounts WHERE account_id = ?`).get(cur);
                if (!row.merged_into) return cur;
                cur = row.merged_into;
            }
        })).size, 1);
    const flushed = sqlite.prepare(`SELECT COUNT(*) AS n FROM identity_nodes WHERE ph_linked = 0`).get().n;
    check('every node has been folded into PostHog', flushed, 0);
}

// ─── Backfill endpoint ───────────────────────────────────────────────────────
console.log('\n/identity/backfill links historical groups behind the admin token');
{
    env.QUOTA_ADMIN_TOKEN = 'admin-secret';
    const devC = newDevice();
    const oldBcid = 'bc_99999999-8888-7777-6666-555555555555';
    const denied = await post('/identity/backfill', { admin_token: 'wrong', groups: [] });
    check('wrong token refused', denied.status, 403);
    const r = await post('/identity/backfill', {
        admin_token: 'admin-secret',
        groups: [
            [{ kind: 'hw', value: hwOf(devC) }, { kind: 'bcid', value: oldBcid }],
            [{ kind: 'bcid', value: 'bc_00000000-0000-0000-0000-000000000000' }],
        ],
    });
    check('anchored group resolves, bcid-only group does not', [ACCT_RE.test(r.body.results[0] || ''), r.body.results[1]], [true, null]);
    check('later device resolve joins the backfilled account',
        (await resolve([{ kind: 'device', value: devC }])).account_id, r.body.results[0]);
    const ev = sqlite.prepare(`SELECT evidence FROM identity_nodes WHERE kind = 'bcid' AND value = ?`).get(oldBcid);
    check('backfilled link is tagged', ev && ev.evidence, 'backfill');
}

// ─── Garbage in ──────────────────────────────────────────────────────────────
console.log('\ninvalid nodes are dropped');
{
    const r = await resolve([{ kind: 'device', value: 'nothex' }, { kind: 'nope', value: 'x' }, 'str', null]);
    check('nothing resolves', r.account_id, null);
    const bad = await post('/identity/resolve', 'not an object');
    check('non-object body is not a crash', bad.status, 200);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
