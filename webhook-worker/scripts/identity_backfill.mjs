/**
 * One-time backfill of the identity graph from everything we already know.
 *
 * Collects groups of identifiers that are provably one person, from:
 *   D1      — quota_accounts, quota_identity_links, install_resolutions,
 *             registrations, license_activations, handoff_emails
 *   PostHog — persons that already carry several distinct_ids, distinct_ids
 *             sharing a hashed_email, distinct_ids sharing an ad click id,
 *             and app → web hand-offs (`?bcid=` / `?ph_id=` on a pageview)
 *
 * Groups are unioned locally into components and written to a CSV for review.
 * Nothing is changed unless --execute is given, in which case each component
 * is sent to POST /identity/backfill, which mints, links and merges exactly as
 * live traffic would (including the PostHog $merge_dangerously calls).
 *
 * Usage:
 *   POSTHOG_PERSONAL_API_KEY=phx_... node scripts/identity_backfill.mjs
 *       [--execute] [--skip-d1] [--skip-posthog] [--allow-large]
 *       [--out identity_backfill.csv] [--verify id1,id2,...]
 *
 * --execute needs WORKER_URL (e.g. https://peachsounds-webhook.<acct>.workers.dev)
 * and QUOTA_ADMIN_TOKEN in the environment. Migration 0007 must be applied.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const EXECUTE      = flag('--execute');
const SKIP_D1      = flag('--skip-d1');
const SKIP_POSTHOG = flag('--skip-posthog');
const ALLOW_LARGE  = flag('--allow-large');
const OUT          = opt('--out', join(here, '..', 'identity_backfill.csv'));
const VERIFY       = (opt('--verify', '') || '').split(',').map(s => s.trim()).filter(Boolean);

const D1_NAME        = process.env.D1_NAME || 'beatcue-quota';
const PH_HOST        = process.env.POSTHOG_APP_HOST || 'https://us.posthog.com';
const PH_PROJECT     = process.env.POSTHOG_PROJECT_ID || '304734';
const PH_KEY         = process.env.POSTHOG_PERSONAL_API_KEY || '';
const WORKER_URL     = (process.env.WORKER_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN    = process.env.QUOTA_ADMIN_TOKEN || '';

/** A component this big is almost certainly a shared click id or a test
 *  machine, not one human. Reported, never merged without --allow-large. */
const LARGE_COMPONENT = 40;
/** Must stay under the worker's IDENTITY_MAX_NODES. */
const NODES_PER_GROUP = 20;
const GROUPS_PER_REQUEST = 50;

// ─── Node classification (mirrors IDENTITY_NODE_RULES in worker.js) ──────────
const BCID_RE    = /^bc_[A-Za-z0-9-]{8,64}$/;
const HW_RE      = /^hw_[0-9a-f]{16}$/;
const HEX64_RE   = /^[0-9a-f]{64}$/;
const PANEL_RE   = /^panel_[A-Za-z0-9_-]{4,96}$/;
const ACCOUNT_RE = /^acct_[0-9a-f]{32}$/;
const PH_RE      = /^[A-Za-z0-9_.:@~-]{1,200}$/;
const ANCHORS    = new Set(['hw', 'device', 'email_hash', 'license']);

const sha256 = s => createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');

/** Node for a PostHog distinct_id, or null when it can't be one. */
function distinctNode(id) {
    if (typeof id !== 'string' || !id) return null;
    if (ACCOUNT_RE.test(id)) return null;
    if (BCID_RE.test(id))  return { kind: 'bcid', value: id };
    if (HW_RE.test(id))    return { kind: 'hw', value: id };
    if (PANEL_RE.test(id)) return { kind: 'panel', value: id };
    if (HEX64_RE.test(id)) return { kind: 'email_hash', value: id };
    if (PH_RE.test(id))    return { kind: 'ph_distinct', value: id };
    return null;
}

// ─── Union-find over node keys ───────────────────────────────────────────────
const parent = new Map();
const nodeOf = new Map();
const sources = new Map();

const keyOf = n => `${n.kind}:${n.value}`;
function find(k) {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(k) !== r) { const next = parent.get(k); parent.set(k, r); k = next; }
    return r;
}
function addGroup(nodes, source) {
    const valid = nodes.filter(Boolean);
    if (valid.length < 2) return;
    const keys = valid.map(n => {
        const k = keyOf(n);
        if (!parent.has(k)) { parent.set(k, k); nodeOf.set(k, n); sources.set(k, new Set()); }
        sources.get(k).add(source);
        return k;
    });
    for (let i = 1; i < keys.length; i++) {
        const a = find(keys[0]);
        const b = find(keys[i]);
        if (a !== b) parent.set(b, a);
    }
}

// ─── D1 ──────────────────────────────────────────────────────────────────────
function d1(sql) {
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', D1_NAME, '--remote', '--json', '--command', sql], {
        cwd: join(here, '..'),
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap(r => r.results || []);
}

function collectD1() {
    const device = d => (HEX64_RE.test(d || '') ? { kind: 'device', value: d } : null);
    const bcid = b => (BCID_RE.test(b || '') ? { kind: 'bcid', value: b } : null);
    let n = 0;

    for (const r of d1(`SELECT device_id, bcid FROM quota_accounts WHERE bcid IS NOT NULL`)) {
        addGroup([device(r.device_id), bcid(r.bcid)], 'd1:quota_accounts'); n++;
    }
    for (const r of d1(`SELECT kind, value, device_id FROM quota_identity_links`)) {
        const node = r.kind === 'bcid' ? bcid(r.value)
            : r.kind === 'email_hash' && HEX64_RE.test(r.value) ? { kind: 'email_hash', value: r.value }
            : r.kind === 'store_cid' ? { kind: 'store_cid', value: String(r.value).slice(0, 200) }
            : null;
        addGroup([device(r.device_id), node], 'd1:quota_identity_links'); n++;
    }
    for (const r of d1(`SELECT device_id, bcid FROM install_resolutions WHERE bcid IS NOT NULL`)) {
        addGroup([device(r.device_id), bcid(r.bcid)], 'd1:install_resolutions'); n++;
    }
    for (const r of d1(`SELECT device_id, email_hash FROM registrations WHERE email_hash IS NOT NULL`)) {
        addGroup([device(r.device_id), HEX64_RE.test(r.email_hash) ? { kind: 'email_hash', value: r.email_hash } : null],
                 'd1:registrations'); n++;
    }
    for (const r of d1(`SELECT device_id, license_key, email FROM license_activations`)) {
        addGroup([
            device(r.device_id),
            r.license_key ? { kind: 'license', value: sha256(r.license_key) } : null,
            r.email ? { kind: 'email_hash', value: sha256(r.email) } : null,
        ], 'd1:license_activations'); n++;
    }
    for (const r of d1(`SELECT bcid, email_hash FROM handoff_emails`)) {
        addGroup([bcid(r.bcid), HEX64_RE.test(r.email_hash || '') ? { kind: 'email_hash', value: r.email_hash } : null],
                 'd1:handoff_emails'); n++;
    }
    console.log(`d1: ${n} rows read`);
}

// ─── PostHog ─────────────────────────────────────────────────────────────────
async function hogql(query) {
    const res = await fetch(`${PH_HOST}/api/projects/${PH_PROJECT}/query/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${PH_KEY}` },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    });
    if (!res.ok) throw new Error(`hogql ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()).results || [];
}

async function collectPostHog() {
    if (!PH_KEY) throw new Error('POSTHOG_PERSONAL_API_KEY is required (or pass --skip-posthog)');

    // Persons PostHog already merged: the graph has to know about them too, or
    // a later link to one of their ids would look like a brand-new person.
    const persons = await hogql(`
        SELECT person_id, groupUniqArray(distinct_id)
          FROM person_distinct_ids
         GROUP BY person_id
        HAVING count() > 1
         LIMIT 100000`);
    for (const [, ids] of persons) addGroup(ids.map(distinctNode), 'posthog:person');

    const byEmail = await hogql(`
        SELECT toString(properties.hashed_email) AS h, groupUniqArray(distinct_id)
          FROM events
         WHERE timestamp > now() - INTERVAL 400 DAY
           AND match(toString(properties.hashed_email), '^[0-9a-f]{64}$')
         GROUP BY h
         LIMIT 100000`);
    for (const [h, ids] of byEmail) {
        addGroup([{ kind: 'email_hash', value: h }, ...ids.map(distinctNode)], 'posthog:hashed_email');
    }

    for (const prop of ['fbclid', 'gclid']) {
        const byClick = await hogql(`
            SELECT toString(properties.${prop}) AS c, groupUniqArray(distinct_id) AS ids
              FROM events
             WHERE timestamp > now() - INTERVAL 400 DAY
               AND length(toString(properties.${prop})) > 10
             GROUP BY c
            HAVING length(ids) > 1
             LIMIT 100000`);
        for (const [, ids] of byClick) addGroup(ids.map(distinctNode), `posthog:${prop}`);
    }

    // The app opened the site with its own id in the URL; the pageview's
    // distinct_id is the browser that received it.
    const handoffs = await hogql(`
        SELECT DISTINCT distinct_id,
               extract(toString(properties.$current_url), '[?&](?:bcid|ph_id)=([A-Za-z0-9_-]+)') AS u
          FROM events
         WHERE event = '$pageview'
           AND timestamp > now() - INTERVAL 400 DAY
           AND match(toString(properties.$current_url), '[?&](bcid|ph_id)=')
         LIMIT 100000`);
    for (const [d, u] of handoffs) {
        if (u && u !== d) addGroup([distinctNode(d), distinctNode(u)], 'posthog:url_handoff');
    }

    console.log(`posthog: ${persons.length} merged persons, ${byEmail.length} email groups, ${handoffs.length} url hand-offs`);
}

// ─── Components ──────────────────────────────────────────────────────────────
function components() {
    const byRoot = new Map();
    for (const k of parent.keys()) {
        const r = find(k);
        if (!byRoot.has(r)) byRoot.set(r, []);
        byRoot.get(r).push(k);
    }
    return [...byRoot.values()].map(keys => keys.map(k => nodeOf.get(k)));
}

/** Split a component into worker-sized groups that all share one anchor, so
 *  resolving them in order still lands everything on a single account. */
function toGroups(nodes) {
    const anchor = nodes.find(n => ANCHORS.has(n.kind));
    const rest = nodes.filter(n => n !== anchor);
    const groups = [];
    for (let i = 0; i < rest.length; i += NODES_PER_GROUP - 1) {
        groups.push([anchor, ...rest.slice(i, i + NODES_PER_GROUP - 1)]);
    }
    return groups;
}

async function postGroups(groups) {
    const results = [];
    for (let i = 0; i < groups.length; i += GROUPS_PER_REQUEST) {
        const chunk = groups.slice(i, i + GROUPS_PER_REQUEST);
        const res = await fetch(`${WORKER_URL}/identity/backfill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ admin_token: ADMIN_TOKEN, groups: chunk }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !body.ok) throw new Error(`backfill ${res.status}: ${JSON.stringify(body)}`);
        results.push(...body.results);
        process.stdout.write(`\r  sent ${Math.min(i + GROUPS_PER_REQUEST, groups.length)}/${groups.length} groups`);
    }
    process.stdout.write('\n');
    return results;
}

async function verify(ids) {
    for (const id of ids) {
        const rows = await hogql(`
            SELECT groupUniqArray(distinct_id)
              FROM person_distinct_ids
             WHERE person_id = (SELECT person_id FROM person_distinct_ids WHERE distinct_id = '${id.replace(/'/g, '')}' LIMIT 1)`);
        const all = (rows[0] && rows[0][0]) || [];
        const acct = all.find(d => ACCOUNT_RE.test(d));
        console.log(`  ${acct ? 'ok  ' : 'MISS'} ${id} → ${acct || 'no account'} (${all.length} distinct_ids: ${all.slice(0, 8).join(', ')}${all.length > 8 ? ', …' : ''})`);
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────
if (EXECUTE && (!WORKER_URL || !ADMIN_TOKEN)) {
    console.error('--execute needs WORKER_URL and QUOTA_ADMIN_TOKEN');
    process.exit(2);
}

if (!SKIP_D1) collectD1();
if (!SKIP_POSTHOG) await collectPostHog();

const comps = components();
const rows = ['component,size,status,kind,value,sources'];
const toSend = [];
const stats = { components: comps.length, nodes: 0, sendable: 0, no_anchor: 0, large: 0 };

comps.forEach((nodes, i) => {
    stats.nodes += nodes.length;
    const hasAnchor = nodes.some(n => ANCHORS.has(n.kind));
    const large = nodes.length > LARGE_COMPONENT;
    const status = !hasAnchor ? 'skipped_no_anchor' : large && !ALLOW_LARGE ? 'skipped_large' : 'merge';
    if (!hasAnchor) stats.no_anchor++;
    else if (large && !ALLOW_LARGE) stats.large++;
    else { stats.sendable++; toSend.push(...toGroups(nodes)); }
    for (const n of nodes) {
        rows.push([i, nodes.length, status, n.kind, n.value, [...sources.get(keyOf(n))].join('|')].join(','));
    }
});

writeFileSync(OUT, rows.join('\n') + '\n');
console.log(`\n${stats.components} components over ${stats.nodes} nodes`);
console.log(`  ${stats.sendable} to merge (${toSend.length} groups)`);
console.log(`  ${stats.no_anchor} skipped: no device / hw / email / licence to anchor an account`);
console.log(`  ${stats.large} skipped: larger than ${LARGE_COMPONENT} nodes (review, then --allow-large)`);
console.log(`plan written to ${OUT}`);

if (!EXECUTE) {
    console.log('\ndry run — nothing changed. Re-run with --execute to apply.');
} else {
    const results = await postGroups(toSend);
    console.log(`resolved ${results.filter(Boolean).length}/${results.length} groups`);
}

if (VERIFY.length) {
    console.log('\nverify');
    await verify(VERIFY);
}
