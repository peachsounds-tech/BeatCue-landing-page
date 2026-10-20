/**
 * Offline self-test for conversion email enrichment: once the hand-off form
 * ties a bcid to an email, /capi and /gads attach that email to conversions
 * that arrive with only the bcid, under the hand-off's consent rule.
 *
 * Same harness as identity_selftest.mjs: the real worker module over an
 * in-memory SQLite database with a D1-shaped adapter, everything upstream
 * mocked.
 *
 * Run with:
 *   node --experimental-sqlite scripts/email_enrichment_selftest.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

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

const signingPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const SIGNING_PKCS8_B64 = Buffer.from(await crypto.subtle.exportKey('pkcs8', signingPair.privateKey)).toString('base64');

// ─── Mocks ───────────────────────────────────────────────────────────────────
const PRO_KEY = 'pro-key-0000-1111-2222-333344445555';
const BUYER_EMAIL = 'Buyer.Name+beatcue@googlemail.com';
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
    if (u.includes('api.resend.com')) return json({ id: 'em_1' });
    if (u.includes('api.lemonsqueezy.com/v1/licenses/')) {
        const params = new URLSearchParams(init && init.body || '');
        const meta = { customer_email: BUYER_EMAIL, order_id: 42, product_id: 1295253, variant_id: 2146438 };
        return json({
            activated: true, valid: true, license_key: { status: 'active', expires_at: null },
            instance: { id: params.get('instance_id') || 'inst-1' }, meta,
        });
    }
    return json({});
};

const env = {
    QUOTA_DB: makeD1(sqlite),
    ENTITLEMENT_SIGNING_KEY: SIGNING_PKCS8_B64,
    EXPERIMENT_SALT: 'selftest',
    RESEND_API_KEY: 'test',
    META_PIXEL_ID: '1',
    META_CAPI_TOKEN: 'test',
    GOOGLE_ADS_CLIENT_ID: 'id',
    GOOGLE_ADS_CLIENT_SECRET: 'secret',
    GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
    GOOGLE_ADS_CUSTOMER_ID: '1234567890',
    GOOGLE_ADS_CONV_ACTIONS: JSON.stringify({ funnel_value: '111', send_to_desktop: '222' }),
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

async function post(path, body, cf) {
    const req = new Request(`https://example.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify(body),
    });
    Object.defineProperty(req, 'cf', { value: cf });
    const res = await worker.fetch(req, env, ctx);
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

const sha = s => createHash('sha256').update(s).digest('hex');
const EMAIL = 'First.Last+ads@gmail.com';
const META_HASH = sha(EMAIL.toLowerCase());
const GOOGLE_HASH = sha('firstlast@gmail.com');
const BCID = 'bc_11111111-2222-3333-4444-555555555555';
const STRANGER = 'bc_99999999-2222-3333-4444-555555555555';
const US = { country: 'US' };
const DE = { country: 'DE' };

let seq = 0;
async function capi(bcid, extra = {}, cf = US) {
    const before = metaEvents.length;
    await post('/capi', {
        event_name: 'funnel_value', event_id: 'fv_' + (++seq), action_source: 'website',
        user_data: { external_id: bcid }, custom_data: { value: 0.09, currency: 'USD' }, ...extra,
    }, cf);
    return metaEvents.slice(before).pop();
}
async function gads(body, cf = US) {
    const before = googleEvents.length;
    const r = await post('/gads', {
        event_name: 'funnel_value', transaction_id: 'fv_' + (++seq), value: 0.09, currency: 'USD', ...body,
    }, cf);
    return { r, event: googleEvents.slice(before).pop() };
}
const googleEm = e => e && e.userData && e.userData.userIdentifiers[0].emailAddress;

// ─── Before the hand-off ─────────────────────────────────────────────────────
console.log('\nbefore any email is known');
check('meta event has no em', (await capi(BCID)).user_data.em, undefined);

// ─── Hand-off ties bcid ↔ email ──────────────────────────────────────────────
console.log('\nhand-off email links the bcid to the email');
{
    const r = await post('/handoff/email', { email: EMAIL, bcid: BCID, ad_consent: 'granted' }, US);
    check('hand-off sent', r.body && r.body.ok, true);
}

// ─── Meta ────────────────────────────────────────────────────────────────────
console.log('\n/capi fills in the email by bcid');
check('meta em from the identity graph', (await capi(BCID)).user_data.em, [META_HASH]);
check('array external_id (the app) works too', (await capi([STRANGER, BCID])).user_data.em, [META_HASH]);
check('an em on the request wins', (await capi(BCID, { user_data: { external_id: BCID, em_raw: 'other@x.com' } })).user_data.em, [sha('other@x.com')]);
check('unknown bcid gets none', (await capi(STRANGER)).user_data.em, undefined);
check('explicit "no" gets none', (await capi(BCID, { ad_consent: 'denied' })).user_data.em, undefined);
check('banner country without a "yes" gets none', (await capi(BCID, {}, DE)).user_data.em, undefined);
check('banner country with a "yes" gets it', (await capi(BCID, { ad_consent: 'granted' }, DE)).user_data.em, [META_HASH]);

// ─── Google ──────────────────────────────────────────────────────────────────
console.log('\n/gads fills in the email by bcid, with Google normalization');
{
    const { event } = await gads({ distinct_id: BCID, user_data: { gclid: 'G1' } });
    check('google em via distinct_id, gmail dots and +tag stripped', googleEm(event), GOOGLE_HASH);
}
{
    const { event } = await gads({ user_data: { gclid: 'G2', external_id: [BCID] } });
    check('google em via external_id', googleEm(event), GOOGLE_HASH);
}
{
    const { event } = await gads({ distinct_id: BCID, user_data: {} });
    check('email alone makes it matchable (no click id)', googleEm(event), GOOGLE_HASH);
}
{
    const { r } = await gads({ distinct_id: STRANGER, user_data: {} });
    check('unknown bcid without a click id still skips', r.body.skipped, 'no_click_id');
}
{
    const { event } = await gads({ distinct_id: BCID, ad_consent: 'denied', user_data: { gclid: 'G3' } });
    check('explicit "no" sends the click without the email', googleEm(event), undefined);
}

// ─── Checkout / license email, no hand-off ───────────────────────────────────
console.log('\na license email reaches Google too, without the address being stored');
{
    const device = 'd'.repeat(64);
    const installId = 'bc_77777777-2222-3333-4444-555555555555';
    await post('/identity/resolve', { nodes: [{ kind: 'device', value: device }, { kind: 'install', value: installId }] }, US);
    const act = await post('/license/activate', {
        device_id: device, machine_id: '0123456789abcdef0123456789abcdef', nonce: 'nonce-1', license_key: PRO_KEY,
    }, US);
    check('activation ok', act.body && act.body.valid, true);

    const { event } = await gads({ user_data: { gclid: 'G4', external_id: [installId] } });
    check('google em from the license, googlemail dots and +tag stripped', googleEm(event), sha('buyername@googlemail.com'));
    check('meta em from the license', (await capi(installId)).user_data.em, [sha(BUYER_EMAIL.toLowerCase())]);
    check('no plaintext stored for it', sqlite.prepare(`SELECT COUNT(*) AS n FROM handoff_emails WHERE email = ?`).get(BUYER_EMAIL.toLowerCase()).n, 0);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
