/**
 * BeatCue Webhook Worker
 *
 * Two responsibilities:
 *   1. Lemon Squeezy → PostHog: receive purchase webhooks and forward to PostHog
 *   2. Web ↔ desktop pairing: bridge the bcid + Meta attribution captured on
 *      the download page over to the freshly installed desktop app, without
 *      tripping Chrome's Local Network Access prompt.
 *
 * Deploy to Cloudflare Workers via `wrangler deploy`.
 */

// PostHog configuration
const POSTHOG_API_KEY = 'phc_glfQoJ0XvIyNUy1Q6baVxMLolADg69F9H262U0TiRuG';
const POSTHOG_HOST = 'https://us.i.posthog.com';

// ─── Pairing constants ────────────────────────────────────────────────────────

/** Origins that may POST /pairings from a browser (CORS allowlist).
 *  Includes localhost variants so we can run end-to-end tests against the
 *  live worker without standing up a separate dev deployment. The risk
 *  surface is "any process on a developer machine" — strictly smaller than
 *  what curl/scripts already enjoy via the no-Origin path. */
const PAIRINGS_ALLOWED_ORIGINS = new Set([
    'https://gocue.app',
    'https://www.gocue.app',
    'https://beatcue.app',
    'https://www.beatcue.app',
    'http://localhost:8000',
    'http://localhost:8001',
    'http://localhost:8080',
    'http://127.0.0.1:8000',
    'http://127.0.0.1:8001',
    'http://127.0.0.1:8080',
]);

/** How long a pending pairing record lingers before KV evicts it.
 *  15 minutes covers most install flows (download → run installer → first
 *  launch). Longer windows raise the chance of NAT misattribution. */
const PAIRING_TTL_SECONDS = 15 * 60;

/** How long a "claimed:<bcid>" marker survives so the download page can
 *  notice the desktop app paired and tick the launch checklist item. The
 *  page polls every few seconds and stops on its own well within this
 *  window — this is just the safety upper bound. */
const CLAIMED_TTL_SECONDS = 10 * 60;

/** Hard upper bound on incoming JSON to keep KV writes cheap. */
const PAIRINGS_MAX_BODY_BYTES = 4 * 1024;

/** bcid shape contract — must match the page-side mint and the desktop
 *  applyPairing() validator. */
const BCID_RE = /^bc_[A-Za-z0-9-]{8,64}$/;

// ─── Meta Conversions API constants ───────────────────────────────────────────

/** Graph API version pinned for predictable payload schema. Bump deliberately
 *  after testing — Meta deprecates ~2 years out, no need to chase the head. */
const META_GRAPH_VERSION = 'v19.0';

/** Hard upper bound on /capi request bodies. Generous compared to /pairings
 *  because custom_data can carry richer event context (cut indices, file
 *  metadata, etc.) without being a tracking risk. */
const CAPI_MAX_BODY_BYTES = 8 * 1024;

/** Whitelist of event_name values the worker is willing to forward. Stops a
 *  rogue caller from blasting random standard events at the pixel and skewing
 *  optimization. Custom names (anything else) are also accepted but logged
 *  separately so we can spot abuse. */
const CAPI_STANDARD_EVENTS = new Set([
    'PageView',
    'ViewContent',
    'Lead',
    'CompleteRegistration',
    'AddPaymentInfo',
    'InitiateCheckout',
    'Subscribe',
    'StartTrial',
    'Purchase',
]);

/** Custom event names BeatCue is allowed to send. Anything outside this set
 *  AND outside CAPI_STANDARD_EVENTS gets rejected — a soft schema lock. */
const CAPI_CUSTOM_EVENTS = new Set([
    'app_launched',
    'cut_played',
    'activation_started',
    // Keep this list in sync with MetaCapiClient call sites in the desktop app.
]);

/** action_source values Meta accepts. Anything else is rejected. */
const CAPI_ACTION_SOURCES = new Set([
    'website', 'email', 'app', 'phone_call', 'chat',
    'physical_store', 'system_generated', 'business_messaging', 'other',
]);

// Lemon Squeezy webhook secret (set this in Cloudflare dashboard as environment variable)
// const LEMONSQUEEZY_WEBHOOK_SECRET = env.LEMONSQUEEZY_WEBHOOK_SECRET;

/**
 * SHA-256 hash function (matches the JS landing page implementation)
 */
async function hashEmail(email) {
    const normalized = email.toLowerCase().trim();
    const encoder = new TextEncoder();
    const data = encoder.encode(normalized);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify Lemon Squeezy webhook signature
 */
async function verifySignature(payload, signature, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    
    return signature === expectedSignature;
}

/**
 * Send event to PostHog
 */
async function sendToPostHog(event, distinctId, properties) {
    const response = await fetch(`${POSTHOG_HOST}/capture/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            api_key: POSTHOG_API_KEY,
            event: event,
            distinct_id: distinctId,
            properties: {
                ...properties,
                $lib: 'cloudflare-worker'
            },
            timestamp: new Date().toISOString()
        })
    });
    
    return response.ok;
}

/**
 * Main webhook handler
 */
async function handleWebhook(request, env) {
    // Only accept POST requests
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }
    
    try {
        const payload = await request.text();
        const signature = request.headers.get('X-Signature');
        
        // Verify webhook signature (optional but recommended)
        if (env.LEMONSQUEEZY_WEBHOOK_SECRET && signature) {
            const isValid = await verifySignature(payload, signature, env.LEMONSQUEEZY_WEBHOOK_SECRET);
            if (!isValid) {
                console.error('Invalid webhook signature');
                return new Response('Invalid signature', { status: 401 });
            }
        }
        
        const data = JSON.parse(payload);
        const eventName = data.meta?.event_name;
        
        console.log('Received Lemon Squeezy event:', eventName);
        
        // Handle different Lemon Squeezy events
        if (eventName === 'order_created') {
            await handleOrderCreated(data);
        } else if (eventName === 'subscription_created') {
            await handleSubscriptionCreated(data);
        } else if (eventName === 'license_key_created') {
            await handleLicenseKeyCreated(data);
        }
        
        return new Response('OK', { status: 200 });
        
    } catch (error) {
        console.error('Webhook error:', error);
        return new Response('Internal error', { status: 500 });
    }
}

/**
 * Create alias to link anonymous user to identified user using PostHog's $create_alias
 * This links oldAnonymousId to newIdentifiedId (hashed email)
 */
async function mergeUsers(oldAnonymousId, newIdentifiedId) {
    if (!oldAnonymousId || !newIdentifiedId) {
        console.log('Cannot merge: missing oldAnonymousId or newIdentifiedId');
        return false;
    }
    
    // Don't merge if they're the same
    if (oldAnonymousId === newIdentifiedId) {
        console.log('Skipping merge: IDs are the same');
        return false;
    }
    
    console.log('Creating alias:', { oldAnonymousId, newIdentifiedId });
    
    // Use $create_alias to link the anonymous ID to the identified user
    // distinct_id = hashed email (the primary identity)
    // alias = anonymous UUID (gets linked to primary)
    const response = await fetch(`${POSTHOG_HOST}/batch/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            api_key: POSTHOG_API_KEY,
            batch: [
                {
                    event: '$create_alias',
                    properties: {
                        distinct_id: newIdentifiedId,
                        alias: oldAnonymousId,
                        $lib: 'cloudflare-worker'
                    },
                    timestamp: new Date().toISOString()
                }
            ]
        })
    });
    
    const responseText = await response.text();
    console.log('Alias response status:', response.status, 'body:', responseText);
    return response.ok;
}

/**
 * Handle order_created event (for one-time purchases or lead magnets)
 */
async function handleOrderCreated(data) {
    const order = data.data?.attributes;
    const email = order?.user_email;
    
    // Lemon Squeezy can put custom data in different places - check all of them
    const metaCustomData = data.meta?.custom_data || {};
    const orderCustomData = order?.custom_data || {};
    const firstOrderItemCustomData = order?.first_order_item?.custom_data || {};
    
    // Log all possible locations to debug
    console.log('=== DEBUG: Custom Data Locations ===');
    console.log('meta.custom_data:', JSON.stringify(metaCustomData));
    console.log('data.attributes.custom_data:', JSON.stringify(orderCustomData));
    console.log('first_order_item.custom_data:', JSON.stringify(firstOrderItemCustomData));
    
    if (!email) {
        console.error('No email in order');
        return;
    }
    
    const hashedEmail = await hashEmail(email);
    
    // Get PostHog anonymous ID - check all possible locations
    const posthogId = metaCustomData.posthog_id 
        || orderCustomData.posthog_id 
        || firstOrderItemCustomData.posthog_id 
        || null;
    
    console.log('=== Extracted Values ===');
    console.log('hashedEmail:', hashedEmail);
    console.log('posthogId:', posthogId);
    
    // Step 1: If we have the anonymous PostHog ID, merge it with the hashed email
    if (posthogId && posthogId !== hashedEmail) {
        console.log('Merging users: connecting OLD anonymous ID to NEW hashed email...');
        console.log(`  OLD (anonymous): ${posthogId}`);
        console.log(`  NEW (identified): ${hashedEmail}`);
        
        // Use the proper $identify event to merge users
        const mergeSuccess = await mergeUsers(posthogId, hashedEmail);
        console.log('Merge result:', mergeSuccess ? 'SUCCESS' : 'FAILED');
        
    } else if (!posthogId) {
        console.log('No posthog_id found in any custom_data location - cannot merge');
    }
    
    // Step 2: Send checkout_completed event (using hashed email as distinct_id)
    const properties = {
        order_id: data.data?.id,
        order_number: order?.order_number,
        total: order?.total,
        currency: order?.currency,
        status: order?.status,
        product_name: order?.first_order_item?.product_name,
        variant_name: order?.first_order_item?.variant_name,
        // Include anonymous PostHog ID for reference
        anonymous_posthog_id: posthogId,
        // Include hashed email for verification
        hashed_email: hashedEmail
    };
    
    console.log('Sending checkout_completed to PostHog with distinct_id:', hashedEmail);
    
    const success = await sendToPostHog('checkout_completed', hashedEmail, properties);
    
    if (success) {
        console.log('PostHog checkout_completed event sent successfully');
    } else {
        console.error('Failed to send PostHog event');
    }
    
    // Step 3: Set user_type based on product (useful if page view didn't capture it)
    const productName = order?.first_order_item?.product_name || '';
    const isEarlyAccess = productName.toLowerCase().includes('early access');
    
    await fetch(`${POSTHOG_HOST}/capture/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: POSTHOG_API_KEY,
            event: '$set',
            distinct_id: hashedEmail,
            properties: {
                $set: {
                    user_type: isEarlyAccess ? 'early_access' : 'standard',
                    purchase_product: productName,
                    purchase_date: new Date().toISOString()
                }
            },
            timestamp: new Date().toISOString()
        })
    });
    console.log(`User type set to: ${isEarlyAccess ? 'early_access' : 'standard'}`);
}

/**
 * Handle subscription_created event
 */
async function handleSubscriptionCreated(data) {
    const subscription = data.data?.attributes;
    const email = subscription?.user_email;
    
    if (!email) return;
    
    const hashedEmail = await hashEmail(email);
    
    const properties = {
        subscription_id: data.data?.id,
        status: subscription?.status,
        product_name: subscription?.product_name,
        variant_name: subscription?.variant_name,
        hashed_email: hashedEmail
    };
    
    await sendToPostHog('subscription_created', hashedEmail, properties);
}

/**
 * Handle license_key_created event
 */
async function handleLicenseKeyCreated(data) {
    const license = data.data?.attributes;
    const email = license?.user_email;
    
    if (!email) return;
    
    const hashedEmail = await hashEmail(email);
    
    const properties = {
        license_id: data.data?.id,
        license_key: license?.key,  // The actual license key
        status: license?.status,
        hashed_email: hashedEmail
    };
    
    await sendToPostHog('license_key_created', hashedEmail, properties);
}

// ─── Pairing helpers ──────────────────────────────────────────────────────────

/** Build CORS headers for a request. Returns the strict-mode set if the origin
 *  is on the allowlist, otherwise a deny header (browsers will fail-closed). */
function pairingsCorsHeaders(origin) {
    const allow = PAIRINGS_ALLOWED_ORIGINS.has(origin) ? origin : 'null';
    return {
        'access-control-allow-origin': allow,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        'vary': 'origin',
    };
}

/** Coarsen the connecting IP so minor rotation between page load and app
 *  launch (DHCP renewal, dual-stack toggling) doesn't break matching.
 *    - IPv4 → /24 (zero out the last octet)
 *    - IPv6 → /48 (keep first three hextets)
 *  Falls back to the raw value if parsing fails. */
function coarseIp(req) {
    const ip = req.headers.get('cf-connecting-ip') || '';
    if (!ip) return '';
    if (ip.includes(':')) {
        const parts = ip.split(':');
        return parts.slice(0, 3).join(':') + '::';
    }
    const parts = ip.split('.');
    if (parts.length !== 4) return ip;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

/** Derive a coarse OS family from a UA string, or accept an explicit value
 *  (the desktop app sends `{ os: "mac"|"win" }` — no UA there). */
function osFamily(ua, explicit) {
    if (explicit === 'mac' || explicit === 'win') return explicit;
    if (!ua) return 'other';
    if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
    if (/Windows NT/.test(ua))         return 'win';
    return 'other';
}

/** Hash (coarse_ip, os) → KV key prefix. 24 hex chars (96 bits) is plenty
 *  of entropy for the small key space we operate in, and short enough to
 *  keep KV reads cheap. */
async function buildClaimKey(ip, os) {
    const enc = new TextEncoder().encode(`${ip}|${os}`);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    const hex = [...new Uint8Array(buf)]
        .slice(0, 12)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return `pair:${hex}`;
}

/** Fallback key for dual-stack networks where the page may connect to the
 *  worker over IPv4 while the desktop app uses IPv6 (or vice-versa). The
 *  ip-coarsened primary key in that case lives under a different hash for
 *  the two requests, so the claim misses. ASN+country is independent of
 *  IP family and stays stable across the small download → first-launch
 *  window. Cross-user collision risk: two BeatCue downloads + first
 *  launches, same ASN+country+OS, both within ~15 minutes — accepted given
 *  current install volume. Returns null when Cloudflare didn't populate
 *  request.cf (local dev / pathological edge cases) so callers can skip
 *  the fallback gracefully. */
async function buildAsnKey(cf, os) {
    if (!cf || typeof cf.asn !== 'number' || cf.asn <= 0) return null;
    const country = (cf.country && typeof cf.country === 'string') ? cf.country : 'XX';
    const enc = new TextEncoder().encode(`asn:${cf.asn}|${country}|${os}`);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    const hex = [...new Uint8Array(buf)]
        .slice(0, 12)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return `pair:${hex}`;
}

function clampString(v, maxLen) {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function clampUtms(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    for (const k of keys) {
        const v = clampString(raw[k], 256);
        if (v) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
}

async function readJsonBounded(request) {
    const text = await request.text();
    if (text.length > PAIRINGS_MAX_BODY_BYTES) {
        const err = new Error('payload_too_large');
        err.statusCode = 413;
        throw err;
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        const err = new Error('invalid_json');
        err.statusCode = 400;
        throw err;
    }
}

/**
 * Pairing route handler.
 *
 *   POST /pairings        — page submits attribution payload (CORS-gated)
 *   POST /pairings/claim  — desktop app fetches the pending pairing on
 *                           first launch
 *   OPTIONS /pairings*    — CORS preflight
 */
async function handlePairings(request, env, url) {
    const origin = request.headers.get('origin') || '';
    const cors = pairingsCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
        return new Response('method_not_allowed', { status: 405, headers: cors });
    }

    if (!env.PAIRINGS) {
        console.error('PAIRINGS KV binding missing — did you bind it in wrangler.toml?');
        return new Response('kv_unavailable', { status: 503, headers: cors });
    }

    let body;
    try {
        body = await readJsonBounded(request);
    } catch (e) {
        console.log(JSON.stringify({
            evt: 'pair_bad_body',
            path: url.pathname,
            error: e.message,
            content_length: request.headers.get('content-length') || null,
            content_type: request.headers.get('content-type') || null,
            origin,
        }));
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: e.statusCode || 400,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    // ── Page → store pending pairing ─────────────────────────────────────────
    if (url.pathname === '/pairings') {
        // CORS gate: browsers must come from an allowed origin. Non-browser
        // calls (curl / scripts) won't have an origin header — those are
        // accepted so we can smoke-test from the command line.
        if (origin && !PAIRINGS_ALLOWED_ORIGINS.has(origin)) {
            console.log(JSON.stringify({ evt: 'pair_forbidden_origin', origin }));
            return new Response(JSON.stringify({ ok: false, error: 'forbidden_origin' }), {
                status: 403,
                headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
            });
        }

        const bcid = clampString(body.bcid, 96);
        if (!bcid || !BCID_RE.test(bcid)) {
            console.log(JSON.stringify({
                evt: 'pair_invalid_bcid',
                origin,
                bcid_present: typeof body.bcid !== 'undefined',
                bcid_type: typeof body.bcid,
                bcid_preview: typeof body.bcid === 'string' ? body.bcid.slice(0, 32) : null,
                bcid_length: typeof body.bcid === 'string' ? body.bcid.length : null,
                body_keys: Object.keys(body || {}),
            }));
            return new Response(JSON.stringify({ ok: false, error: 'invalid_bcid' }), {
                status: 400,
                headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
            });
        }

        const ua = request.headers.get('user-agent') || '';
        const os = osFamily(ua);
        const ipKey  = await buildClaimKey(coarseIp(request), os);
        const asnKey = await buildAsnKey(request.cf, os);

        // Cross-key linkage: store the sibling under `_alt` so the claim
        // path can delete-on-read both copies and avoid a stale fallback
        // entry leaking to the next install on the same ASN.
        const payload = {
            bcid,
            fbp:    clampString(body.fbp,    256),
            fbc:    clampString(body.fbc,    256),
            fbclid: clampString(body.fbclid, 256),
            utms:   clampUtms(body.utms),
            ts:     Date.now(),
            os,
            _alt:   asnKey && asnKey !== ipKey ? asnKey : null,
        };

        const json = JSON.stringify(payload);
        const writes = [
            env.PAIRINGS.put(ipKey, json, { expirationTtl: PAIRING_TTL_SECONDS }),
        ];
        if (asnKey && asnKey !== ipKey) {
            writes.push(env.PAIRINGS.put(asnKey, json, { expirationTtl: PAIRING_TTL_SECONDS }));
        }
        await Promise.all(writes);

        // Single-line structured log so `wrangler tail` shows what the
        // worker actually saw for this request — IP family, ASN, OS, key
        // hashes — without leaking the bcid or attribution payload.
        console.log(JSON.stringify({
            evt: 'pair_put',
            bcid_prefix: bcid.slice(0, 8),
            os,
            ip_family: (request.headers.get('cf-connecting-ip') || '').includes(':') ? 'v6' : 'v4',
            country: (request.cf && request.cf.country) || null,
            asn:     (request.cf && request.cf.asn)     || null,
            ip_key:  ipKey,
            asn_key: asnKey,
            wrote:   writes.length,
        }));

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    // ── App → claim pending pairing ──────────────────────────────────────────
    if (url.pathname === '/pairings/claim') {
        const os = osFamily(request.headers.get('user-agent') || '', body.os);
        const ipKey  = await buildClaimKey(coarseIp(request), os);
        const asnKey = await buildAsnKey(request.cf, os);

        // Try the IP-coarsened key first (zero collision risk within a
        // /24 + os), then fall back to ASN+country+os. The fallback
        // catches dual-stack v4/v6 mismatches between page and app — same
        // network, different IP family, otherwise different hashes.
        let raw = await env.PAIRINGS.get(ipKey);
        let hitKey = ipKey;
        let hitVia = 'ip';
        if (!raw && asnKey && asnKey !== ipKey) {
            raw = await env.PAIRINGS.get(asnKey);
            if (raw) { hitKey = asnKey; hitVia = 'asn'; }
        }

        if (!raw) {
            console.log(JSON.stringify({
                evt: 'pair_claim_miss',
                os,
                ip_family: (request.headers.get('cf-connecting-ip') || '').includes(':') ? 'v6' : 'v4',
                country: (request.cf && request.cf.country) || null,
                asn:     (request.cf && request.cf.asn)     || null,
                ip_key:  ipKey,
                asn_key: asnKey,
            }));
            return new Response(JSON.stringify({ ok: false, error: 'no_pending_pairing' }), {
                status: 404,
                headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
            });
        }

        // Single-shot: delete on read so a second BeatCue install behind the
        // same NAT doesn't accidentally reuse this user's bcid. Wipe both
        // copies (primary + ASN fallback) — best-effort, ignore failures.
        const deletions = [env.PAIRINGS.delete(hitKey)];
        let parsed = null;
        try {
            parsed = JSON.parse(raw);
            const sibling = parsed && parsed._alt;
            if (typeof sibling === 'string' && sibling && sibling !== hitKey) {
                deletions.push(env.PAIRINGS.delete(sibling));
            }
        } catch (_) { /* tolerate */ }
        await Promise.all(deletions.map(p => p.catch(() => {})));

        // Drop a short-lived breadcrumb so the still-open download page can
        // poll /pairings/claimed/<bcid> and tick its "Start editing"
        // checklist item. We extract the bcid from the stored payload — the
        // app already validates it before persisting, so this is trusted.
        const claimedBcid = clampString(parsed && parsed.bcid, 96);
        if (claimedBcid && BCID_RE.test(claimedBcid)) {
            await env.PAIRINGS.put(
                `claimed:${claimedBcid}`,
                JSON.stringify({ at: Date.now() }),
                { expirationTtl: CLAIMED_TTL_SECONDS },
            );
        }

        // Strip internal `_alt` linkage before returning to the desktop —
        // it's a server-only implementation detail.
        let responseBody = raw;
        if (parsed && Object.prototype.hasOwnProperty.call(parsed, '_alt')) {
            const { _alt, ...rest } = parsed;
            responseBody = JSON.stringify(rest);
        }

        console.log(JSON.stringify({
            evt: 'pair_claim_hit',
            via: hitVia,
            bcid_prefix: claimedBcid ? claimedBcid.slice(0, 8) : null,
            os,
            ip_family: (request.headers.get('cf-connecting-ip') || '').includes(':') ? 'v6' : 'v4',
            country: (request.cf && request.cf.country) || null,
            asn:     (request.cf && request.cf.asn)     || null,
            ip_key:  ipKey,
            asn_key: asnKey,
            payload_age_s: parsed && typeof parsed.ts === 'number' ? Math.round((Date.now() - parsed.ts) / 1000) : null,
        }));

        return new Response(responseBody, {
            status: 200,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    return new Response('not_found', { status: 404, headers: cors });
}

/**
 * GET /pairings/claimed/:bcid
 *
 * Lightweight poll endpoint for the download page. Returns 200 with the
 * timestamp once /pairings/claim has fired for this bcid; 404 otherwise.
 *
 * No auth: bcids are random 22+ char tokens, not enumerable. Worst case
 * leak is "this bcid was paired at time T" — same info the page already
 * knows for its own user.
 */
async function handleClaimedStatus(request, env, url) {
    const origin = request.headers.get('origin') || '';
    const cors = pairingsCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
        return new Response('method_not_allowed', { status: 405, headers: cors });
    }
    if (!env.PAIRINGS) {
        return new Response('kv_unavailable', { status: 503, headers: cors });
    }

    // /pairings/claimed/<bcid>  →  segments: ['', 'pairings', 'claimed', '<bcid>']
    const segments = url.pathname.split('/');
    const bcid = clampString(segments[3], 96);
    if (!bcid || !BCID_RE.test(bcid)) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid_bcid' }), {
            status: 400,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const raw = await env.PAIRINGS.get(`claimed:${bcid}`);
    if (!raw) {
        return new Response(JSON.stringify({ ok: false, claimed: false }), {
            status: 404,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    let payload = { claimed: true };
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.at === 'number') payload.at = parsed.at;
    } catch (_) { /* tolerate */ }
    payload.ok = true;

    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
    });
}

// ─── Meta Conversions API handler ─────────────────────────────────────────────

/** Lower-case + trim + sha256 → 64-char lowercase hex. Matches Meta's
 *  prescribed normalization for `em`, `ph`, `external_id`, etc. */
async function sha256LowerHex(s) {
    if (typeof s !== 'string') return null;
    const normalized = s.trim().toLowerCase();
    if (!normalized) return null;
    const buf = await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(normalized));
    return [...new Uint8Array(buf)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/** Validate that a string already looks like a 64-char hex sha256. We accept
 *  pre-hashed values from the desktop app (it has EmailHasher already) so we
 *  don't move plaintext email more times than necessary. */
function isHexSha256(s) {
    return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

/**
 * POST /capi  — desktop app or browser pushes a single Meta CAPI event.
 *
 * Body:
 *   {
 *     event_name:        string  (whitelisted: standard or custom),
 *     event_id:          string  (caller-generated UUID; for retry dedupe),
 *     event_source_url:  string  (https URL of the originating page; for app
 *                                 events use the canonical landing page URL),
 *     action_source:     string  (default "website"; see CAPI_ACTION_SOURCES),
 *     internal_name:     string  (optional, copied into custom_data for
 *                                 cross-checking against PostHog),
 *     user_data: {
 *       fbp, fbc, fbclid     (cookies / click ID),
 *       external_id          (bcid; worker hashes before forwarding),
 *       em_raw               (plaintext email; worker hashes),
 *       em_hashed            (already-hashed email; preferred over em_raw),
 *       client_user_agent    (override; falls back to request UA header)
 *     },
 *     custom_data: { value, currency, ... }
 *   }
 *
 * The worker injects `client_ip_address` from `cf-connecting-ip`, falls back
 * to the request's UA if no override is given, hashes anything Meta requires
 * to be hashed, and forwards a single-event `data:[…]` payload to
 * https://graph.facebook.com/<v>/<pixel_id>/events.
 *
 * Returns the Graph API status + a trimmed body so the caller can log
 * fbtrace_id when something goes wrong. Failures don't retry — Meta CAPI is
 * best-effort by design and double-firing would risk double-counting.
 */
async function handleCapi(request, env, url) {
    const origin = request.headers.get('origin') || '';
    const cors = pairingsCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
        return new Response('method_not_allowed', { status: 405, headers: cors });
    }

    // Browser CORS gate — same allowlist as /pairings. Non-browser callers
    // (the desktop app) have no Origin header and are accepted; the worker is
    // strictly a forwarder and the upstream (Meta) won't accept events
    // without a valid pixel id + access token, so abuse surface is bounded.
    if (origin && !PAIRINGS_ALLOWED_ORIGINS.has(origin)) {
        console.log(JSON.stringify({ evt: 'capi_forbidden_origin', origin }));
        return new Response(JSON.stringify({ ok: false, error: 'forbidden_origin' }), {
            status: 403,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) {
        console.error('CAPI: META_PIXEL_ID or META_CAPI_TOKEN missing — set via wrangler secret put');
        return new Response(JSON.stringify({ ok: false, error: 'server_not_configured' }), {
            status: 503,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    let body;
    try {
        const text = await request.text();
        if (text.length > CAPI_MAX_BODY_BYTES) {
            return new Response(JSON.stringify({ ok: false, error: 'payload_too_large' }), {
                status: 413,
                headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
            });
        }
        body = JSON.parse(text);
    } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid_json' }), {
            status: 400,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    // ── Validate envelope ────────────────────────────────────────────────────
    const eventName = clampString(body.event_name, 64);
    if (!eventName
        || (!CAPI_STANDARD_EVENTS.has(eventName) && !CAPI_CUSTOM_EVENTS.has(eventName))) {
        console.log(JSON.stringify({ evt: 'capi_rejected_event_name', event_name: eventName }));
        return new Response(JSON.stringify({ ok: false, error: 'event_name_not_allowed' }), {
            status: 400,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const eventId = clampString(body.event_id, 96);
    if (!eventId) {
        return new Response(JSON.stringify({ ok: false, error: 'event_id_required' }), {
            status: 400,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const actionSource = clampString(body.action_source, 32) || 'website';
    if (!CAPI_ACTION_SOURCES.has(actionSource)) {
        return new Response(JSON.stringify({ ok: false, error: 'bad_action_source' }), {
            status: 400,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const eventSourceUrl = clampString(body.event_source_url, 2048)
        || 'https://beatcue.app/download';

    // ── Build user_data ──────────────────────────────────────────────────────
    const ud = (body.user_data && typeof body.user_data === 'object') ? body.user_data : {};

    const ipHeader = request.headers.get('cf-connecting-ip');
    const uaOverride = clampString(ud.client_user_agent, 512);
    const uaHeader = request.headers.get('user-agent');

    // bcid is treated as a quasi-PII identifier — Meta wants external_id
    // hashed. Validate shape first so we never push a malformed token into
    // the matching pool.
    let externalIdHashed;
    const rawExternalId = clampString(ud.external_id, 96);
    if (rawExternalId) {
        if (!BCID_RE.test(rawExternalId) && !isHexSha256(rawExternalId)) {
            console.log(JSON.stringify({
                evt: 'capi_bad_external_id',
                preview: rawExternalId.slice(0, 16),
            }));
        } else {
            externalIdHashed = isHexSha256(rawExternalId)
                ? rawExternalId
                : await sha256LowerHex(rawExternalId);
        }
    }

    // em: prefer pre-hashed value, fall back to hashing em_raw. Either way
    // Meta receives a 64-char hex string. Multiple values are allowed (an
    // array) but we only ever ship one.
    let emHashed;
    const emHashedIn = clampString(ud.em_hashed, 128);
    if (isHexSha256(emHashedIn)) {
        emHashed = emHashedIn;
    } else {
        const emRaw = clampString(ud.em_raw, 256);
        if (emRaw) emHashed = await sha256LowerHex(emRaw);
    }

    const userData = {};
    if (ipHeader) userData.client_ip_address = ipHeader;
    const ua = uaOverride || uaHeader;
    if (ua) userData.client_user_agent = ua;

    const fbp    = clampString(ud.fbp,    256);
    const fbc    = clampString(ud.fbc,    256);
    const fbclid = clampString(ud.fbclid, 256);
    if (fbp)    userData.fbp = fbp;
    if (fbc)    userData.fbc = fbc;
    // fbclid is normally only used to synthesize an _fbc value when absent;
    // we forward it as-is when present and let Meta's matching do the rest.
    // It's not a documented user_data key, so stash under custom_data.
    if (externalIdHashed) userData.external_id = externalIdHashed;
    if (emHashed)         userData.em          = [emHashed];

    // Meta requires AT LEAST one user_data identifier beyond IP/UA, otherwise
    // the event is dropped from matching. IP+UA alone counts at lower
    // confidence, so we accept it but log so we can spot anonymous sends.
    const hasStrongMatch = !!(fbp || fbc || externalIdHashed || emHashed);

    // ── Build custom_data ────────────────────────────────────────────────────
    const cdIn = (body.custom_data && typeof body.custom_data === 'object') ? body.custom_data : {};
    const customData = { ...cdIn };
    if (typeof body.internal_name === 'string' && body.internal_name) {
        customData.internal_event_name = clampString(body.internal_name, 64);
    }
    if (fbclid) customData.fbclid = fbclid;

    // ── Build event ──────────────────────────────────────────────────────────
    const event = {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        event_source_url: eventSourceUrl,
        action_source: actionSource,
        user_data: userData,
        custom_data: customData,
    };

    const payload = { data: [event] };
    if (env.META_TEST_EVENT_CODE) {
        // Routes this single event into the "Test Events" tab in Events
        // Manager instead of into prod attribution. Set the secret while
        // verifying, then `wrangler secret delete META_TEST_EVENT_CODE`.
        payload.test_event_code = env.META_TEST_EVENT_CODE;
    }

    // ── Forward to Meta ──────────────────────────────────────────────────────
    const graphUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/`
        + encodeURIComponent(env.META_PIXEL_ID)
        + `/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`;

    let upstreamStatus = 0;
    let upstreamBody = '';
    let fbtraceId = null;
    let eventsReceived = null;
    try {
        const r = await fetch(graphUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        upstreamStatus = r.status;
        upstreamBody = await r.text();
        try {
            const j = JSON.parse(upstreamBody);
            fbtraceId = j.fbtrace_id || null;
            eventsReceived = typeof j.events_received === 'number' ? j.events_received : null;
        } catch (_) { /* non-JSON error body — passthrough */ }
    } catch (e) {
        console.log(JSON.stringify({
            evt: 'capi_upstream_error',
            event_name: eventName,
            error: String(e && e.message || e),
        }));
        return new Response(JSON.stringify({ ok: false, error: 'upstream_unreachable' }), {
            status: 502,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    console.log(JSON.stringify({
        evt: 'capi_forwarded',
        event_name: eventName,
        internal: customData.internal_event_name || null,
        action_source: actionSource,
        upstream_status: upstreamStatus,
        events_received: eventsReceived,
        fbtrace_id: fbtraceId,
        had_fbp: !!fbp,
        had_fbc: !!fbc,
        had_external_id: !!externalIdHashed,
        had_em: !!emHashed,
        strong_match: hasStrongMatch,
        test_mode: !!env.META_TEST_EVENT_CODE,
    }));

    return new Response(JSON.stringify({
        ok: upstreamStatus >= 200 && upstreamStatus < 300,
        upstream_status: upstreamStatus,
        events_received: eventsReceived,
        fbtrace_id: fbtraceId,
    }), {
        status: upstreamStatus >= 200 && upstreamStatus < 300 ? 200 : 502,
        headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
    });
}

/**
 * Cloudflare Worker entry point
 */
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/health') {
            return new Response('OK', { status: 200 });
        }

        if (url.pathname === '/webhook/lemonsqueezy') {
            return handleWebhook(request, env);
        }

        if (url.pathname === '/pairings' || url.pathname === '/pairings/claim') {
            return handlePairings(request, env, url);
        }

        if (url.pathname.startsWith('/pairings/claimed/')) {
            return handleClaimedStatus(request, env, url);
        }

        if (url.pathname === '/capi') {
            return handleCapi(request, env, url);
        }

        return new Response('Not found', { status: 404 });
    }
};

