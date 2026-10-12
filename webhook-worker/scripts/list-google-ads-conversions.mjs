#!/usr/bin/env node
/**
 * After OAuth secrets exist, list accessible customers + conversion actions
 * so you can build GOOGLE_ADS_CONV_ACTIONS.
 *
 * Usage:
 *   GOOGLE_ADS_CLIENT_ID=... \
 *   GOOGLE_ADS_CLIENT_SECRET=... \
 *   GOOGLE_ADS_REFRESH_TOKEN=... \
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID=... \   # optional MCC
 *   node scripts/list-google-ads-conversions.mjs
 *
 * Or pass --customer=1234567890 to skip discovery and only list actions.
 */

// Keep in sync with GOOGLE_ADS_API_VERSION in worker.js — a sunset version 404s.
const API = 'https://googleads.googleapis.com/v25';

async function getAccessToken(env) {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.GOOGLE_ADS_CLIENT_ID,
        client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
        refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) {
        throw new Error(`oauth failed: ${JSON.stringify(j)}`);
    }
    return j.access_token;
}

function headers(accessToken, env) {
    const h = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
    };
    // Deprecated 2026-09-09 and ignored by the API. Forwarded only if one is
    // still set, to match an older deployment.
    if (env.GOOGLE_ADS_DEVELOPER_TOKEN) h['developer-token'] = env.GOOGLE_ADS_DEVELOPER_TOKEN;
    if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
        h['login-customer-id'] = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, '');
    }
    return h;
}

async function listAccessibleCustomers(accessToken, env) {
    const r = await fetch(`${API}/customers:listAccessibleCustomers`, {
        headers: headers(accessToken, env),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`listAccessibleCustomers: ${JSON.stringify(j)}`);
    return (j.resourceNames || []).map((n) => n.replace('customers/', ''));
}

async function listConversionActions(accessToken, env, customerId) {
    const cid = String(customerId).replace(/-/g, '');
    const query = `
      SELECT
        conversion_action.id,
        conversion_action.name,
        conversion_action.type,
        conversion_action.status,
        conversion_action.resource_name,
        conversion_action.tag_snippets
      FROM conversion_action
      WHERE conversion_action.status != 'REMOVED'
      ORDER BY conversion_action.name
    `;
    const r = await fetch(`${API}/customers/${cid}/googleAds:searchStream`, {
        method: 'POST',
        headers: headers(accessToken, env),
        body: JSON.stringify({ query }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`searchStream ${cid}: ${text.slice(0, 500)}`);
    // searchStream returns NDJSON / JSON array depending on version — handle both
    let rows = [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            for (const chunk of parsed) {
                for (const row of chunk.results || []) rows.push(row);
            }
        } else if (parsed.results) {
            rows = parsed.results;
        }
    } catch (_) {
        // NDJSON
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const chunk = JSON.parse(line);
                for (const row of chunk.results || []) rows.push(row);
            } catch (_) {}
        }
    }
    return rows.map((row) => row.conversionAction).filter(Boolean);
}

/** The desktop app's conversion names (its ConversionCatalog), shared with
 *  Meta. Keep in sync with GADS_EVENT_NAMES in worker.js. An action named
 *  exactly after one maps to it unambiguously — checked before the fuzzy
 *  rules below, which would otherwise read "activation_finished" as a
 *  purchase and suggest checkout_clicked. */
const DESKTOP_EVENT_NAMES = new Set([
    'first_app_launched', 'first_premiere_installed_detected',
    'first_premiere_panel_connected', 'first_cut_played',
    'first_new_project_created', 'first_track_imported', 'first_export_intent',
    'first_activation_started', 'first_activation_finished',
    'first_free_registration_completed',
    'app_launched', 'premiere_installed_detected', 'new_project_created',
    'export_intent', 'activation_started', 'activation_finished',
]);

function matchHint(action) {
    const name = (action.name || '').toLowerCase();
    const exact = name.trim().replace(/\s+/g, '_');
    if (DESKTOP_EVENT_NAMES.has(exact)) return exact;

    const snippets = JSON.stringify(action.tagSnippets || action.tag_snippets || []).toLowerCase();
    if (name.includes('send') && (name.includes('desktop') || name.includes('computer'))) {
        return 'send_to_desktop';
    }
    if (snippets.includes('1x2-col5tnqceknv1j5e') || snippets.includes('1x2-col5')) {
        return 'send_to_desktop';
    }
    if (name.includes('download') || name.includes('request quote') || name.includes('trial')) {
        return 'trial_download';
    }
    if (snippets.includes('h-gbcktnnuceknv1j5e') || snippets.includes('h-gbck')) {
        return 'trial_download';
    }
    if (name.includes('checkout') || name.includes('purchase') || name.includes('buy')) {
        return 'checkout_clicked';
    }
    return null;
}

async function main() {
    const env = process.env;
    for (const k of [
        'GOOGLE_ADS_CLIENT_ID',
        'GOOGLE_ADS_CLIENT_SECRET',
        'GOOGLE_ADS_REFRESH_TOKEN',
    ]) {
        if (!env[k]) {
            console.error(`Missing env ${k}`);
            process.exit(1);
        }
    }

    const argCustomer = (process.argv.find((a) => a.startsWith('--customer=')) || '').split('=')[1];
    const accessToken = await getAccessToken(env);

    let customers = argCustomer ? [argCustomer] : await listAccessibleCustomers(accessToken, env);
    console.log('\nAccessible customers:', customers.join(', ') || '(none)');

    const suggested = {};
    let uploadables = 0;
    for (const cid of customers) {
        console.log(`\n── Conversion actions for ${cid} ──`);
        let actions;
        try {
            actions = await listConversionActions(accessToken, env, cid);
        } catch (e) {
            console.log(`  (skip) ${e.message}`);
            continue;
        }
        if (!actions.length) {
            console.log('  (none)');
            continue;
        }
        for (const a of actions) {
            const hint = matchHint(a);
            // uploadClickConversions only accepts UPLOAD_CLICKS actions. A
            // name match on a WEBPAGE action is the trap this script used to
            // walk into: it reads as the right target, maps cleanly into the
            // secret, and then every upload is rejected by Google.
            const uploadable = a.type === 'UPLOAD_CLICKS';
            const mark = !hint ? ''
                : uploadable ? `  ← likely ${hint}`
                : `  ← name matches ${hint}, but type ${a.type} cannot receive uploads`;
            console.log(`  ${a.resourceName || a.resource_name}`);
            console.log(`    name=${a.name}  type=${a.type}  status=${a.status}${mark}`);
            if (hint && uploadable && !suggested[hint]) {
                suggested[hint] = a.resourceName || a.resource_name;
            }
            if (uploadable) uploadables++;
        }
    }

    if (Object.keys(suggested).length) {
        console.log('\nSuggested GOOGLE_ADS_CONV_ACTIONS JSON:\n');
        console.log(JSON.stringify(suggested, null, 2));
        console.log('\nSet with:\n  npx wrangler secret put GOOGLE_ADS_CONV_ACTIONS\n');
    } else if (uploadables === 0) {
        console.log('\nNo UPLOAD_CLICKS conversion actions exist in these accounts, so nothing'
            + '\ncan receive an offline click conversion yet. Create them in Google Ads under'
            + '\nGoals > Conversions > New conversion action > Import > "Other data sources or'
            + '\nCRM" > "Track conversions from clicks", then re-run this script.');
    } else {
        console.log('\nNo automatic mapping guessed — copy resource names manually into GOOGLE_ADS_CONV_ACTIONS.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
