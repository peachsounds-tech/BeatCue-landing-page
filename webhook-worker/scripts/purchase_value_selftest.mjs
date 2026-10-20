/**
 * Offline self-test for purchase values on conversions: the app fires the
 * activation conversion with the catalog's flat estimate, and the worker
 * replaces it with what the Lemon Squeezy order was actually worth.
 *
 * Same harness as identity_selftest.mjs: the real worker module over an
 * in-memory SQLite database with a D1-shaped adapter, everything upstream
 * mocked.
 *
 * Run with:
 *   node --experimental-sqlite scripts/purchase_value_selftest.mjs
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
    return { prepare: sql => wrap(sql), batch: async stmts => stmts.map(s => s.run()) };
}

const sqlite = new DatabaseSync(':memory:');
const migrationsDir = join(here, '..', 'migrations');
for (const f of readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(migrationsDir, f), 'utf8'));
}

// ─── Mocks ───────────────────────────────────────────────────────────────────
const metaEvents = [];
const googleEvents = [];

globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (obj, status = 200) => ({
        status, ok: status >= 200 && status < 300, json: async () => obj, text: async () => JSON.stringify(obj),
    });
    if (u.includes('graph.facebook.com')) {
        for (const e of JSON.parse(init.body).data) metaEvents.push(e);
        return json({ events_received: 1, fbtrace_id: 't' });
    }
    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'tok', expires_in: 3600 });
    if (u.includes('datamanager.googleapis.com')) {
        for (const e of JSON.parse(init.body).events) googleEvents.push(e);
        return json({ requestId: 'r' });
    }
    return json({});
};

const env = {
    QUOTA_DB: makeD1(sqlite),
    META_PIXEL_ID: '1',
    META_CAPI_TOKEN: 'test',
    GOOGLE_ADS_CLIENT_ID: 'id',
    GOOGLE_ADS_CLIENT_SECRET: 'secret',
    GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
    GOOGLE_ADS_CUSTOMER_ID: '1234567890',
    GOOGLE_ADS_CONV_ACTIONS: JSON.stringify({ funnel_value: '111', first_activation_finished: '222' }),
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

async function post(path, body) {
    const res = await worker.fetch(new Request(`https://example.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify(body),
    }), env, ctx);
    const out = { status: res.status, body: await res.json().catch(() => null) };
    await settle();
    return out;
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

/** A Lemon Squeezy order webhook, as the worker receives it. */
async function order({ id, email, bcid, totalCents, currency = 'USD', product = 'BeatCue Pro' }) {
    const res = await worker.fetch(new Request('https://example.test/webhook/lemonsqueezy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            meta: { event_name: 'order_created', custom_data: bcid ? { bcid } : {} },
            data: {
                id, attributes: {
                    user_email: email, total: totalCents, currency, order_number: 1, status: 'paid',
                    first_order_item: { product_id: '999', variant_id: '888', product_name: product, variant_name: 'v' },
                },
            },
        }),
    }), env, ctx);
    await settle();
    return res.status;
}

let seq = 0;
/** The app's activation conversion: flat $20 from the catalog. */
async function capi(wireName, ids) {
    const before = metaEvents.length;
    const r = await post('/capi', {
        event_name: wireName,
        event_id: 'ev_' + (++seq),
        action_source: 'website',
        internal_name: 'activation_finished',
        user_data: { external_id: ids },
        custom_data: { value: 20.0, currency: 'USD' },
    });
    return { r, event: metaEvents.slice(before).pop() };
}
async function gads(wireName, distinctId) {
    const before = googleEvents.length;
    const r = await post('/gads', {
        event_name: wireName,
        transaction_id: 'tx_' + (++seq),
        internal_name: 'activation_finished',
        distinct_id: distinctId,
        value: 20.0,
        currency: 'USD',
        user_data: { gclid: 'G1' },
    });
    return { r, event: googleEvents.slice(before).pop() };
}

const LIFETIME = 'bc_11111111-1111-1111-1111-111111111111';
const EARLY = 'bc_22222222-2222-2222-2222-222222222222';
const MONTHLY = 'bc_33333333-3333-3333-3333-333333333333';
const UNKNOWN = 'bc_99999999-9999-9999-9999-999999999999';

// ─── Lifetime licence ────────────────────────────────────────────────────────
console.log('\na lifetime licence converts at what it cost, not the estimate');
{
    check('order accepted', await order({ id: 'o1', email: 'life@example.com', bcid: LIFETIME, totalCents: 14900 }), 200);
    const { event } = await capi('first_activation_finished', [LIFETIME]);
    check('meta value is the order total', event.custom_data.value, 149);
    check('currency comes with it', event.custom_data.currency, 'USD');
    check('order id recorded on the event', event.custom_data.order_id, 'o1');
    const fv = await capi('funnel_value', [LIFETIME]);
    check('funnel_value carries it too', fv.event.custom_data.value, 149);
}

// ─── Monthly subscription, in another currency ───────────────────────────────
console.log('\na monthly plan converts at the first payment');
{
    await order({ id: 'o2', email: 'month@example.com', bcid: MONTHLY, totalCents: 7000, currency: 'ILS' });
    const { event } = await capi('funnel_value', [MONTHLY]);
    check('value', event.custom_data.value, 70);
    check('currency follows the order', event.custom_data.currency, 'ILS');
}

// ─── Early access ────────────────────────────────────────────────────────────
console.log('\na $0 early-access grant stops counting as a sale');
{
    await order({ id: 'o3', email: 'early@example.com', bcid: EARLY, totalCents: 0, product: 'BeatCue Early Access' });
    const fv = await capi('funnel_value', [EARLY]);
    check('funnel_value is skipped entirely', fv.r.body.skipped, 'zero_value');
    check('nothing reached Meta for it', fv.event, undefined);
    const named = await capi('first_activation_finished', [EARLY]);
    check('the named conversion still goes, worth 0', named.event.custom_data.value, 0);
}

// ─── No order on record ──────────────────────────────────────────────────────
console.log("\nan install with no order keeps the app's own value");
{
    const { event } = await capi('funnel_value', [UNKNOWN]);
    check('value untouched', event.custom_data.value, 20);
}

// ─── Google ──────────────────────────────────────────────────────────────────
console.log('\n/gads gets the same treatment');
{
    const { event } = await gads('first_activation_finished', LIFETIME);
    check('conversion value is the order total', event.conversionValue, 149);
    check('currency', event.currency, 'USD');
    const fv = await gads('funnel_value', EARLY);
    check('zero-value funnel_value skipped', fv.r.body.skipped, 'zero_value');
}

// ─── Other steps are left alone ──────────────────────────────────────────────
console.log('\nnon-purchase steps are not touched');
{
    const before = metaEvents.length;
    await post('/capi', {
        event_name: 'funnel_value', event_id: 'ev_launch', action_source: 'website',
        internal_name: 'app_launched',
        user_data: { external_id: [LIFETIME] },
        custom_data: { value: 0.14, currency: 'USD' },
    });
    check('first launch keeps $0.14', metaEvents.slice(before).pop().custom_data.value, 0.14);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
