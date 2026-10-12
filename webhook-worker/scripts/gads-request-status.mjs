#!/usr/bin/env node
/**
 * Retrieve Data Manager diagnostics for an events:ingest request.
 *
 * The HTTP 200 from events:ingest only means the request was accepted for
 * processing — whether the conversion survived processing is reported here,
 * and nowhere in the Google Ads UI. Google asks for a ~30 minute wait before
 * the first check; until then the status reads PROCESSING.
 *
 * Usage:
 *   GOOGLE_ADS_CLIENT_ID=... \
 *   GOOGLE_ADS_CLIENT_SECRET=... \
 *   GOOGLE_ADS_REFRESH_TOKEN=... \
 *   node scripts/gads-request-status.mjs <request-id> [<request-id> ...]
 *
 * The refresh token needs the datamanager scope; see
 * scripts/get-google-ads-refresh-token.mjs.
 */

const API = 'https://datamanager.googleapis.com/v1';

const REQUIRED = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN'];

async function getAccessToken(env) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: env.GOOGLE_ADS_CLIENT_ID,
            client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
            refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
        }).toString(),
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error(`oauth failed: ${JSON.stringify(j)}`);
    return j.access_token;
}

function describe(perDestination) {
    const d = perDestination.destination || {};
    const account = d.operatingAccount ? d.operatingAccount.accountId : '(unknown account)';
    const action = d.productDestinationId || '(unknown conversion action)';
    const lines = [`  ${account} / conversion action ${action}: ${perDestination.requestStatus}`];

    const events = perDestination.eventsIngestionStatus;
    if (events && events.recordCount !== undefined) {
        // Counts everything sent, successes and failures alike, so it confirms
        // Google received the rows rather than that it kept them.
        lines.push(`    records received: ${events.recordCount}`);
    }
    for (const [label, info] of [['error', perDestination.errorInfo], ['warning', perDestination.warningInfo]]) {
        if (!info) continue;
        const counts = info.errorCounts || info.warningCounts || [];
        if (!counts.length) lines.push(`    ${label}: ${JSON.stringify(info)}`);
        for (const c of counts) {
            const reason = c.reason || c.recordCount !== undefined ? (c.reason || '(unspecified)') : JSON.stringify(c);
            lines.push(`    ${label}: ${reason} x${c.recordCount ?? '?'}`);
        }
    }
    return lines.join('\n');
}

async function main() {
    const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    if (!ids.length) {
        console.error('usage: node scripts/gads-request-status.mjs <request-id> [...]');
        process.exit(2);
    }
    const missing = REQUIRED.filter((k) => !process.env[k]);
    if (missing.length) {
        console.error(`missing env: ${missing.join(', ')}`);
        process.exit(2);
    }

    const accessToken = await getAccessToken(process.env);
    let failed = 0;

    for (const id of ids) {
        const url = `${API}/requestStatus:retrieve?requestId=${encodeURIComponent(id)}`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        const text = await r.text();
        console.log(`\n${id}  HTTP ${r.status}`);

        if (!r.ok) { console.log(`  ${text.slice(0, 600)}`); failed++; continue; }

        let j;
        try { j = JSON.parse(text); } catch { console.log(`  unparseable: ${text.slice(0, 300)}`); failed++; continue; }

        const statuses = j.requestStatusPerDestination || [];
        if (!statuses.length) { console.log(`  ${text.slice(0, 600)}`); continue; }
        for (const s of statuses) {
            console.log(describe(s));
            if (s.requestStatus === 'FAILED' || s.requestStatus === 'PARTIAL_SUCCESS') failed++;
        }
    }
    console.log('');
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
