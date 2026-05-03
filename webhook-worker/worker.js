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

/** Hard upper bound on incoming JSON to keep KV writes cheap. */
const PAIRINGS_MAX_BODY_BYTES = 4 * 1024;

/** bcid shape contract — must match the page-side mint and the desktop
 *  applyPairing() validator. */
const BCID_RE = /^bc_[A-Za-z0-9-]{8,64}$/;

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
        'access-control-allow-methods': 'POST, OPTIONS',
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
            return new Response(JSON.stringify({ ok: false, error: 'forbidden_origin' }), {
                status: 403,
                headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
            });
        }

        const bcid = clampString(body.bcid, 96);
        if (!bcid || !BCID_RE.test(bcid)) {
            return new Response(JSON.stringify({ ok: false, error: 'invalid_bcid' }), {
                status: 400,
                headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
            });
        }

        const ua = request.headers.get('user-agent') || '';
        const os = osFamily(ua);
        const key = await buildClaimKey(coarseIp(request), os);

        const payload = {
            bcid,
            fbp:    clampString(body.fbp,    256),
            fbc:    clampString(body.fbc,    256),
            fbclid: clampString(body.fbclid, 256),
            utms:   clampUtms(body.utms),
            ts:     Date.now(),
            os,
        };

        await env.PAIRINGS.put(key, JSON.stringify(payload), {
            expirationTtl: PAIRING_TTL_SECONDS,
        });

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    // ── App → claim pending pairing ──────────────────────────────────────────
    if (url.pathname === '/pairings/claim') {
        const os = osFamily(request.headers.get('user-agent') || '', body.os);
        const key = await buildClaimKey(coarseIp(request), os);

        const raw = await env.PAIRINGS.get(key);
        if (!raw) {
            return new Response(JSON.stringify({ ok: false, error: 'no_pending_pairing' }), {
                status: 404,
                headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
            });
        }

        // Single-shot: delete on read so a second BeatCue install behind the
        // same NAT doesn't accidentally reuse this user's bcid.
        await env.PAIRINGS.delete(key);

        return new Response(raw, {
            status: 200,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    return new Response('not_found', { status: 404, headers: cors });
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

        return new Response('Not found', { status: 404 });
    }
};

