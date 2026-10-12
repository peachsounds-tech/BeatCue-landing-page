#!/usr/bin/env node
/**
 * One-shot helper: exchange a Google OAuth auth code for a refresh token
 * suitable for GOOGLE_ADS_REFRESH_TOKEN.
 *
 * Prerequisites (do these in the browser first):
 *   1. Google Cloud Console project with "Google Ads API" enabled
 *   2. OAuth consent screen configured (External or Internal)
 *   3. OAuth client type "Desktop app" → copy client id + secret
 *
 * Usage:
 *   node scripts/get-google-ads-refresh-token.mjs
 *   # or with env already set:
 *   GOOGLE_ADS_CLIENT_ID=... GOOGLE_ADS_CLIENT_SECRET=... node scripts/get-google-ads-refresh-token.mjs
 *
 * Opens a browser, listens on http://127.0.0.1:4173/oauth2callback,
 * prints the refresh token, then exits. Never commits the printed values.
 */

import http from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { exec } from 'node:child_process';

const PORT = 4173;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;
// datamanager is what /gads actually needs — offline click conversions go
// through the Data Manager API. adwords is kept so the same token still works
// for scripts/list-google-ads-conversions.mjs, which reads conversion action
// resource names through the Google Ads API.
const SCOPE = [
    'https://www.googleapis.com/auth/datamanager',
    'https://www.googleapis.com/auth/adwords',
].join(' ');

function openBrowser(url) {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? `open "${url}"`
        : platform === 'win32' ? `start "" "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, () => {});
}

async function ask(rl, label, fallback = '') {
    const hint = fallback ? ` [${fallback.slice(0, 8)}…]` : '';
    const answer = (await rl.question(`${label}${hint}: `)).trim();
    return answer || fallback;
}

async function main() {
    const rl = createInterface({ input, output });

    console.log(`
Google Ads OAuth — refresh token helper
=======================================
Redirect URI that must be allowed on the OAuth client:
  ${REDIRECT_URI}

For a Desktop app client, Google allows http://127.0.0.1 automatically.
If you created a Web client instead, add the redirect URI above.
`);

    const clientId = await ask(rl, 'OAuth Client ID', process.env.GOOGLE_ADS_CLIENT_ID || '');
    const clientSecret = await ask(rl, 'OAuth Client Secret', process.env.GOOGLE_ADS_CLIENT_SECRET || '');
    rl.close();

    if (!clientId || !clientSecret) {
        console.error('Client ID and Client Secret are required.');
        process.exit(1);
    }

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPE);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent'); // force refresh_token every time

    const token = await new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
                if (u.pathname !== '/oauth2callback') {
                    res.writeHead(404); res.end('not found'); return;
                }
                const err = u.searchParams.get('error');
                const code = u.searchParams.get('code');
                if (err || !code) {
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end(`<h1>Auth failed</h1><pre>${err || 'no code'}</pre>`);
                    server.close();
                    reject(new Error(err || 'no_code'));
                    return;
                }

                const body = new URLSearchParams({
                    code,
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uri: REDIRECT_URI,
                    grant_type: 'authorization_code',
                });
                const r = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: body.toString(),
                });
                const json = await r.json();
                if (!r.ok || !json.refresh_token) {
                    res.writeHead(500, { 'Content-Type': 'text/html' });
                    res.end(`<h1>Token exchange failed</h1><pre>${JSON.stringify(json, null, 2)}</pre>
<p>If refresh_token is missing, revoke prior access at
https://myaccount.google.com/permissions and re-run with prompt=consent.</p>`);
                    server.close();
                    reject(new Error(JSON.stringify(json)));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<h1>Success</h1><p>Refresh token captured. You can close this tab and return to the terminal.</p>');
                server.close();
                resolve(json);
            } catch (e) {
                try { res.writeHead(500); res.end(String(e)); } catch (_) {}
                server.close();
                reject(e);
            }
        });

        server.listen(PORT, '127.0.0.1', () => {
            console.log(`\nListening on ${REDIRECT_URI}`);
            console.log('Opening browser for Google consent…\n');
            console.log(authUrl.toString());
            openBrowser(authUrl.toString());
        });
    });

    console.log(`
────────────────────────────────────────
Paste these into wrangler secrets (do NOT commit):

  GOOGLE_ADS_CLIENT_ID=${clientId}
  GOOGLE_ADS_CLIENT_SECRET=${clientSecret}
  GOOGLE_ADS_REFRESH_TOKEN=${token.refresh_token}

Access token (short-lived, for smoke tests only):
  ${token.access_token}
────────────────────────────────────────
`);
}

main().catch((e) => {
    console.error('\nFailed:', e.message || e);
    process.exit(1);
});
