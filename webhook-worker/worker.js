/**
 * BeatCue Webhook Worker
 *
 * Responsibilities:
 *   1. Lemon Squeezy → PostHog: receive purchase webhooks and forward to PostHog
 *   2. Web ↔ desktop pairing: bridge the bcid + Meta attribution captured on
 *      the download page over to the freshly installed desktop app, without
 *      tripping Chrome's Local Network Access prompt.
 *   3. Meta Conversions API proxy (`/capi`) and Google Ads click-conversion
 *      upload proxy (`/gads`) so browser + desktop keep tokens off-client.
 *   4. Free-tier song quota (`/quota/*`): the authoritative ledger of which
 *      songs each install owns and how many it may still claim this period.
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

/** How long IP/ASN-keyed pending pairing records linger before KV evicts
 *  them. 24 hours covers most install funnels (download → installer
 *  cooldown → first launch). Longer windows raise the chance of NAT
 *  misattribution — these keys are collision-prone by design. */
const PAIRING_TTL_SECONDS = 24 * 60 * 60;

/** How long the deterministic `pair:bcid:<bcid>` mirror lingers. This key
 *  cannot mis-attribute (lookup is by the page-minted bcid the Store
 *  round-trips end-to-end), so it can outlive the heuristic keys and cover
 *  deferred Store installs / reboots / cross-device installs that land
 *  days after the click. Desktop identity no longer depends on this TTL
 *  (Store cid → adoptBcidIdentity is offline), but Meta IDs still do. */
const PAIRING_BCID_TTL_SECONDS = 30 * 24 * 60 * 60;

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

// ─── Free-tier quota constants ────────────────────────────────────────────────

/** Fallback when `quota_config.default_limit` is missing or unparseable.
 *  Deliberately a real number rather than 0: a bad config write should degrade
 *  to "the limit we shipped" and not to "nobody on the free tier can work". */
const QUOTA_FALLBACK_LIMIT = 5;

/** Sanity bounds applied to any limit we resolve, from config or override.
 *  Stops a fat-fingered UPDATE from either locking out the free tier or
 *  handing out effectively unlimited songs. */
const QUOTA_MIN_LIMIT = 1;
const QUOTA_MAX_LIMIT = 1000;

/** Body ceiling for /quota/*. Larger than the pairing ceiling because the
 *  migration seed carries one 64-char hash per song the user already owns;
 *  64 KB is ~900 songs, far beyond anything a real free-tier install has. */
const QUOTA_MAX_BODY_BYTES = 64 * 1024;

/** How many owned hashes a state/claim response returns. The client uses these
 *  to populate its offline cache, so the cap is really "how many songs can a
 *  user open without being online". Newest first. */
const QUOTA_OWNED_PAGE_SIZE = 500;

/** Hashes accepted per seed call. Anything beyond this is almost certainly not
 *  a real free-tier history. */
const QUOTA_MAX_SEED_HASHES = 200;

/** device_id / song_hash wire shape: 64 lowercase hex chars (SHA-256 or an
 *  HMAC-SHA256 of the machine fingerprint). Enforced so a malformed or
 *  hostile client can't create junk account rows with arbitrary keys. */
const QUOTA_ID_RE = /^[0-9a-f]{64}$/;

// ─── Entitlement token constants ──────────────────────────────────────────────

/** Key id stamped into every token header. Must match ENTITLEMENT_KEY_ID in
 *  the client's LicenseConfig.h. Bump alongside a key rotation. */
const ENTITLEMENT_KEY_ID = 'e1';

/** How long a signed token is valid. This is the offline window: a licensed
 *  user keeps working this long with no network before a re-sync is required,
 *  and it bounds how long a revoked or refunded licence keeps functioning.
 *  Mirrors ENTITLEMENT_TOKEN_TTL_MS on the client (display only there; the
 *  server's `exp` is what's enforced). */
const ENTITLEMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** machine_id wire shape: 32 lowercase hex chars (MachineId::generate). Empty
 *  is allowed for the free tier, which is keyed on device_id alone. */
const MACHINE_ID_RE = /^[0-9a-f]{32}$/;

/** nonce wire shape: an opaque client-generated string echoed into the token so
 *  a captured response can't be replayed for a different request. Kept short. */
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

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
    // Current once-per-person names. A count of any of these is a count of
    // people — MetaCapiClient (desktop) and the landing-page callers send
    // each at most once. The first_ prefix is a clean Events Manager history
    // after the older per-action / per-song spellings.
    'first_app_launched',
    'first_premiere_installed_detected',
    'first_premiere_panel_connected',
    'first_cut_played',
    'first_new_project_created',
    'first_track_imported',
    'first_export_intent',
    'first_activation_started',
    'first_activation_finished',
    'first_checkout_clicked',
    'first_send_to_desktop_clicked',

    // Repeatable, unlike everything above it: the /plans chooser fires this on
    // every Pro / Studios click, so a count of these is a count of clicks, not
    // of people. It carries the plan in custom_data.content_name so campaigns
    // can optimize on the tier that was picked.
    'plan_clicked',

    // Pre-first_ spellings. In-field builds still send these; keep them
    // accepted so a 400 does not burn a conversion during the cutover.
    'app_launched',
    'premiere_installed_detected',
    'cut_played',
    'new_project_created',
    'export_intent',
    'activation_started',
    'activation_finished',
    'checkout_clicked',
    'send_to_desktop_clicked',
    // NOTE: download-page Pixel still fires "StartTrial" (standard) — kept
    // as-is because existing campaigns optimize against it. Don't add a
    // custom mirror here unless we also flip the Pixel call.
    // Keep this list in sync with MetaCapiClient call sites in the desktop app.
]);

/** action_source values Meta accepts. Anything else is rejected. */
const CAPI_ACTION_SOURCES = new Set([
    'website', 'email', 'app', 'phone_call', 'chat',
    'physical_store', 'system_generated', 'business_messaging', 'other',
]);

// ─── Google Ads conversion upload constants ───────────────────────────────────

/** Ads API version pinned for predictable schema. Bump deliberately after
 *  testing — Google sunsets versions on a rolling schedule. */
const GOOGLE_ADS_API_VERSION = 'v19';

/** Hard upper bound on /gads request bodies. */
const GADS_MAX_BODY_BYTES = 8 * 1024;

/**
 * event_name values the worker will upload. Each must map to a conversion
 * action resource name via the GOOGLE_ADS_CONV_ACTIONS JSON secret
 * (e.g. {"send_to_desktop":"customers/123/conversionActions/456"}).
 * Keep in sync with landing-page dual-fire call sites.
 */
const GADS_EVENT_NAMES = new Set([
    'send_to_desktop',
    'trial_download',
    'checkout_clicked',
]);

/** Module-scoped OAuth access-token cache. Workers may reuse the isolate
 *  across requests; a miss just means one extra token round-trip. */
let gadsAccessToken = null;
let gadsAccessTokenExpiresAt = 0;

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
 * Send event to PostHog.
 *
 * `clientIp` is the *end user's* IP (Cloudflare's `cf-connecting-ip`), not the
 * worker's. PostHog geolocates server-side events from the request IP, which
 * for a worker-originated capture is a Cloudflare data-centre IP — so without
 * this the `$geoip_*` properties describe Cloudflare's PoP, not the user, and
 * country-based filters (e.g. an "internal user = Israel" rule) silently miss
 * these events. Passing `$ip` overrides that so GeoIP resolves the real user,
 * lining these up with the events the desktop app sends from the same machine.
 * Only pass it for events that actually originate from a user request; webhook
 * -driven events (Lemon Squeezy) have no user IP and must omit it.
 */
async function sendToPostHog(event, distinctId, properties, clientIp) {
    const props = {
        ...properties,
        $lib: 'cloudflare-worker'
    };
    if (clientIp) {
        props.$ip = clientIp;
    }

    const response = await fetch(`${POSTHOG_HOST}/capture/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            api_key: POSTHOG_API_KEY,
            event: event,
            distinct_id: distinctId,
            properties: props,
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
            await handleLicenseKeyCreated(data, env);
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
 * Pull the bcid out of wherever Lemon Squeezy put the checkout custom data.
 * Returns null when the checkout carried no identity, in which case callers fall
 * back to the hashed email and the order has to be merged in afterwards.
 */
function extractBcid(data) {
    const attrs = data.data?.attributes;
    return data.meta?.custom_data?.bcid
        || attrs?.custom_data?.bcid
        || attrs?.first_order_item?.custom_data?.bcid
        || null;
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
    
    // The bcid is the identity the plugin and the landing page both already key
    // on. When the checkout carried one we can record the order straight onto
    // that person, which removes the merge step instead of capturing against a
    // hashed email and depending on a later $create_alias landing.
    const bcid = extractBcid(data);
    
    // Who the order gets recorded against.
    const distinctId = bcid || hashedEmail;
    
    console.log('=== Extracted Values ===');
    console.log('hashedEmail:', hashedEmail);
    console.log('posthogId:', posthogId);
    console.log('bcid:', bcid);
    console.log('recording order against:', distinctId);
    
    // Step 1: Merge only when we fell back to the hashed email. A bcid means the
    // events already land on the buyer and there is nothing to reconcile.
    if (bcid) {
        console.log('bcid present - attributing directly, no merge required');
    } else if (posthogId && posthogId !== hashedEmail) {
        console.log('Merging users: connecting OLD anonymous ID to NEW hashed email...');
        console.log(`  OLD (anonymous): ${posthogId}`);
        console.log(`  NEW (identified): ${hashedEmail}`);
        
        // Use the proper $identify event to merge users
        const mergeSuccess = await mergeUsers(posthogId, hashedEmail);
        console.log('Merge result:', mergeSuccess ? 'SUCCESS' : 'FAILED');
        
    } else if (!posthogId) {
        console.log('No bcid or posthog_id in any custom_data location - cannot merge');
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
        hashed_email: hashedEmail,
        // Which identity the order was attributed to, so a bcid-less order is
        // visible as such rather than silently looking the same as a good one.
        bcid: bcid,
        attributed_via: bcid ? 'bcid' : (posthogId ? 'posthog_id_merge' : 'hashed_email_only')
    };
    
    console.log('Sending checkout_completed to PostHog with distinct_id:', distinctId);
    
    const success = await sendToPostHog('checkout_completed', distinctId, properties);
    
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
            distinct_id: distinctId,
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
    const bcid = extractBcid(data);
    
    const properties = {
        subscription_id: data.data?.id,
        status: subscription?.status,
        product_name: subscription?.product_name,
        variant_name: subscription?.variant_name,
        hashed_email: hashedEmail,
        bcid: bcid
    };
    
    await sendToPostHog('subscription_created', bcid || hashedEmail, properties);
}

/** The in-app registration token, from wherever Lemon Squeezy put the checkout
 *  custom data. */
function extractReg(data) {
    const attrs = data.data?.attributes;
    const reg = data.meta?.custom_data?.reg
        || attrs?.custom_data?.reg
        || attrs?.first_order_item?.custom_data?.reg
        || null;
    return reg && REG_RE.test(reg) ? reg : null;
}

/**
 * Handle license_key_created event
 *
 * For the Free product bought from an in-app registration, park the key
 * against the device that minted the reg token; the app collects it on its
 * next /install/resolve. The raw key never goes to PostHog.
 */
async function handleLicenseKeyCreated(data, env) {
    const license = data.data?.attributes;
    const email = license?.user_email;
    
    if (!email) return;
    
    const hashedEmail = await hashEmail(email);
    const bcid = extractBcid(data);
    const reg = extractReg(data);
    const tier = licenseTierFor(env, {
        productId: license?.product_id != null ? String(license.product_id) : null,
        variantId: license?.variant_id != null ? String(license.variant_id) : null,
    });

    let arm = null;
    let parked = false;
    if (tier === 'free' && reg && env.QUOTA_DB && license?.key) {
        const db = env.QUOTA_DB;
        await db.prepare(
            `UPDATE registrations
                SET pending_license_key = ?2, email_hash = ?3, key_received_at = ?4
              WHERE reg = ?1 AND completed_at IS NULL`
        ).bind(reg, license.key, hashedEmail, Date.now()).run();

        const row = await db.prepare(
            `SELECT r.pending_license_key AS parked_key, i.arm AS arm
               FROM registrations r
               LEFT JOIN install_resolutions i ON i.device_id = r.device_id
              WHERE r.reg = ?1`
        ).bind(reg).first();
        parked = !!row && row.parked_key === license.key;
        arm = row ? row.arm : null;
    }
    console.log(JSON.stringify({ evt: 'license_key_created', tier, has_reg: !!reg, parked }));
    
    const properties = {
        license_id: data.data?.id,
        license_key_short: license?.key_short || null,
        status: license?.status,
        tier,
        registration_parked: parked,
        free_gate_arm: arm,
        hashed_email: hashedEmail,
        bcid: bcid
    };
    
    await sendToPostHog('license_key_created', bcid || hashedEmail, properties);
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
 *  launches, same ASN+country+OS, both within the 24h PAIRING_TTL_SECONDS
 *  window — accepted given current install volume. Returns null when
 *  Cloudflare didn't populate
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

async function readJsonBounded(request, maxBytes = PAIRINGS_MAX_BODY_BYTES) {
    const text = await request.text();
    if (text.length > maxBytes) {
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
        // bcid-keyed mirror. Lets a Windows app that pulled the bcid out of
        // the Microsoft Store cid (GetAppPurchaseCampaignIdAsync → WinRT)
        // claim attribution directly, bypassing the IP/ASN heuristic that
        // gets unreliable behind deferred Store installs, cross-device
        // installs on the same MS account, or roaming networks.
        const bcidKey = `pair:bcid:${bcid}`;

        // Collect every key we wrote so the claim path can delete-on-read
        // ALL of them atomically. Otherwise a successful bcid lookup would
        // leave the IP/ASN keys behind to NAT-collide with the next install.
        const allKeys = [ipKey];
        if (asnKey && asnKey !== ipKey) allKeys.push(asnKey);
        allKeys.push(bcidKey);

        const payload = {
            bcid,
            fbp:    clampString(body.fbp,    256),
            fbc:    clampString(body.fbc,    256),
            fbclid: clampString(body.fbclid, 256),
            // Google Ads click IDs — mirror the Meta fields so the desktop app
            // can attribute the install to a Google click captured on the
            // web download page (or forwarded from a mobile hand-off link).
            gclid:  clampString(body.gclid,  256),
            gbraid: clampString(body.gbraid, 256),
            wbraid: clampString(body.wbraid, 256),
            utms:   clampUtms(body.utms),
            ts:     Date.now(),
            os,
            // Sibling keys for delete-on-read fan-out. Replaces the older
            // `_alt: <single key>` field; we still read that on the claim
            // side for backward compat with any in-flight payloads written
            // by the previous worker version.
            _alts:  allKeys,
        };

        const json = JSON.stringify(payload);
        // Deterministic bcid key gets the long TTL; heuristic IP/ASN keys
        // stay short so a delayed claim can't NAT-collide with a later
        // install on the same coarse network.
        await Promise.all(allKeys.map(k =>
            env.PAIRINGS.put(k, json, {
                expirationTtl: k === bcidKey
                    ? PAIRING_BCID_TTL_SECONDS
                    : PAIRING_TTL_SECONDS,
            })
        ));

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
            bcid_key: bcidKey,
            wrote:   allKeys.length,
        }));

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    // ── App → claim pending pairing ──────────────────────────────────────────
    if (url.pathname === '/pairings/claim') {
        // The Windows app can now pre-resolve its own bcid by reading the
        // Microsoft Store cid via GetAppPurchaseCampaignIdAsync. When it
        // does, it sends the bcid here and we do a direct KV lookup — no
        // IP coarsening, no ASN fallback, zero NAT collision risk. The
        // old IP+ASN lookup remains as the fallback for callers that
        // don't have a bcid (older app versions, sideloaded installs, or
        // Store installs where the cid round-trip failed).
        const requestedBcid = clampString(body && body.bcid, 96);
        const hasValidBcid = requestedBcid && BCID_RE.test(requestedBcid);

        const os = osFamily(request.headers.get('user-agent') || '', body.os);
        const ipKey  = await buildClaimKey(coarseIp(request), os);
        const asnKey = await buildAsnKey(request.cf, os);
        const bcidKey = hasValidBcid ? `pair:bcid:${requestedBcid}` : null;

        let raw = null;
        let hitKey = null;
        let hitVia = null;

        if (bcidKey) {
            raw = await env.PAIRINGS.get(bcidKey);
            if (raw) { hitKey = bcidKey; hitVia = 'bcid'; }
        }

        // Fall back to IP-coarsened lookup (primary for legacy callers),
        // then ASN+country+os for dual-stack v4/v6 mismatches.
        if (!raw) {
            raw = await env.PAIRINGS.get(ipKey);
            if (raw) { hitKey = ipKey; hitVia = 'ip'; }
        }
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
                bcid_key: bcidKey,
                had_bcid_hint: !!hasValidBcid,
            }));
            return new Response(JSON.stringify({ ok: false, error: 'no_pending_pairing' }), {
                status: 404,
                headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
            });
        }

        let parsed = null;
        try {
            parsed = JSON.parse(raw);
        } catch (_) { /* tolerate */ }

        // Delete-on-read fan-out. Prefer the explicit `_alts` array (new
        // shape); fall back to `_alt` single-string (old shape) so
        // payloads written by the previous worker version still get
        // fully cleaned up. Always include the key we actually hit, even
        // if it isn't in the sibling list (e.g. claim arrived via bcid
        // for an old-shape payload that doesn't list bcidKey).
        const deletions = new Set();
        deletions.add(hitKey);
        if (parsed) {
            if (Array.isArray(parsed._alts)) {
                for (const k of parsed._alts) {
                    if (typeof k === 'string' && k) deletions.add(k);
                }
            } else if (typeof parsed._alt === 'string' && parsed._alt) {
                deletions.add(parsed._alt);
            }
        }
        await Promise.all(
            [...deletions].map(k => env.PAIRINGS.delete(k).catch(() => {}))
        );

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
            bcid_key: bcidKey,
            payload_age_s: parsed && typeof parsed.ts === 'number' ? Math.round((Date.now() - parsed.ts) / 1000) : null,
        }));

        // Always return a JSON object that includes `via`, so the desktop
        // `pairing_completed.pair_via` property actually populates. Older
        // workers only logged hitVia — the stored KV payload has no via
        // field, so PairingClient.parseString("via") always yielded "".
        // Strip `_alts`/`_alt` (server-only sibling-key linkage) before
        // handing the payload to the desktop.
        const outObj = (parsed && typeof parsed === 'object') ? parsed : {};
        const { _alts, _alt, ...publicFields } = outObj;
        const responseJson = JSON.stringify({ ...publicFields, via: hitVia });

        return new Response(responseJson, {
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
 *  prescribed normalization for `em`, `ph`, etc. (PII only — not external_id). */
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
 *       external_id          (raw bcid; forwarded as-is to match Pixel),
 *       em_raw               (plaintext email; worker hashes),
 *       em_hashed            (already-hashed email; preferred over em_raw),
 *       client_user_agent    (override; falls back to request UA header)
 *     },
 *     custom_data: { value, currency, ... }
 *   }
 *
 * The worker injects `client_ip_address` from `cf-connecting-ip`, falls back
 * to the request's UA if no override is given, hashes PII (email) only,
 * and forwards a single-event `data:[…]` payload to
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

    // bcid / external_id — forward raw (same as landing-page Pixel Advanced
    // Matching). Meta does not require hashing for external_id. Accept a single
    // string or an array (app sends [local_install_id, web_bcid] post-pair).
    const externalIdsRaw = Array.isArray(ud.external_id)
        ? ud.external_id
        : (ud.external_id ? [ud.external_id] : []);
    const externalIds = [];
    for (const raw of externalIdsRaw) {
        const v = clampString(raw, 96);
        if (!v) continue;
        if (!BCID_RE.test(v)) {
            console.log(JSON.stringify({
                evt: 'capi_bad_external_id',
                preview: v.slice(0, 16),
            }));
            continue;
        }
        externalIds.push(v);
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
    if (externalIds.length === 1) {
        userData.external_id = externalIds[0];
    } else if (externalIds.length > 1) {
        userData.external_id = externalIds;
    }
    if (emHashed)         userData.em          = [emHashed];

    // Meta requires AT LEAST one user_data identifier beyond IP/UA, otherwise
    // the event is dropped from matching. IP+UA alone counts at lower
    // confidence, so we accept it but log so we can spot anonymous sends.
    const hasStrongMatch = !!(fbp || fbc || externalIds.length > 0 || emHashed);

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
        external_id_count: externalIds.length,
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

// ─── Google Ads click-conversion upload handler ───────────────────────────────

/** UTC timestamp in the format Google Ads requires:
 *  `yyyy-mm-dd hh:mm:ss+00:00`. */
function formatGoogleAdsDateTime(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
        + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+00:00`;
}

/** Parse GOOGLE_ADS_CONV_ACTIONS secret (JSON object of event_name → resource). */
function parseGadsConvActions(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

const GADS_CONV_ACTION_RE = /^customers\/\d+\/conversionActions\/\d+$/;

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 * Caches on the isolate so warm requests skip the OAuth round-trip.
 */
async function getGoogleAdsAccessToken(env) {
    const now = Date.now();
    if (gadsAccessToken && now < gadsAccessTokenExpiresAt - 60_000) {
        return gadsAccessToken;
    }

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
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = null; }

    if (!r.ok || !json || !json.access_token) {
        console.log(JSON.stringify({
            evt: 'gads_oauth_error',
            status: r.status,
            error: json && (json.error || json.error_description) || text.slice(0, 200),
        }));
        throw new Error('oauth_failed');
    }

    gadsAccessToken = json.access_token;
    const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    gadsAccessTokenExpiresAt = now + expiresInSec * 1000;
    return gadsAccessToken;
}

/**
 * POST /gads  — browser (or desktop) pushes a single Google Ads click conversion.
 *
 * Body:
 *   {
 *     event_name:       string  (whitelisted: send_to_desktop | trial_download | checkout_clicked),
 *     transaction_id:   string  (UUID; must match gtag transaction_id for dedupe),
 *     event_source_url: string  (optional; logged only),
 *     internal_name:    string  (optional; logged),
 *     value:            number  (optional),
 *     currency:         string  (optional; default ILS to match existing gtag),
 *     user_data: {
 *       gclid, gbraid, wbraid   (at least one required to upload; else skipped)
 *     }
 *   }
 *
 * Maps event_name → conversion action via GOOGLE_ADS_CONV_ACTIONS JSON secret,
 * refreshes an OAuth access token, and calls
 * customers:uploadClickConversions. Returns skipped when no click id is
 * present (organic traffic) so the client can always dual-fire safely.
 */
async function handleGads(request, env, url) {
    const origin = request.headers.get('origin') || '';
    const cors = pairingsCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
        return new Response('method_not_allowed', { status: 405, headers: cors });
    }

    if (origin && !PAIRINGS_ALLOWED_ORIGINS.has(origin)) {
        console.log(JSON.stringify({ evt: 'gads_forbidden_origin', origin }));
        return new Response(JSON.stringify({ ok: false, error: 'forbidden_origin' }), {
            status: 403,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const configured = !!(
        env.GOOGLE_ADS_DEVELOPER_TOKEN
        && env.GOOGLE_ADS_CLIENT_ID
        && env.GOOGLE_ADS_CLIENT_SECRET
        && env.GOOGLE_ADS_REFRESH_TOKEN
        && env.GOOGLE_ADS_CUSTOMER_ID
        && env.GOOGLE_ADS_CONV_ACTIONS
    );
    if (!configured) {
        console.error('GADS: missing Google Ads secrets — see README § Google Ads API');
        return new Response(JSON.stringify({ ok: false, error: 'server_not_configured' }), {
            status: 503,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    let body;
    try {
        const text = await request.text();
        if (text.length > GADS_MAX_BODY_BYTES) {
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

    const eventName = clampString(body.event_name, 64);
    if (!eventName || !GADS_EVENT_NAMES.has(eventName)) {
        console.log(JSON.stringify({ evt: 'gads_rejected_event_name', event_name: eventName }));
        return new Response(JSON.stringify({ ok: false, error: 'event_name_not_allowed' }), {
            status: 400,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const transactionId = clampString(body.transaction_id, 96);
    if (!transactionId) {
        return new Response(JSON.stringify({ ok: false, error: 'transaction_id_required' }), {
            status: 400,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const convActions = parseGadsConvActions(env.GOOGLE_ADS_CONV_ACTIONS);
    if (!convActions) {
        return new Response(JSON.stringify({ ok: false, error: 'conv_actions_invalid' }), {
            status: 503,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const conversionAction = clampString(convActions[eventName], 128);
    if (!conversionAction || !GADS_CONV_ACTION_RE.test(conversionAction)) {
        console.log(JSON.stringify({
            evt: 'gads_unmapped_event',
            event_name: eventName,
            has_key: !!(convActions && convActions[eventName]),
        }));
        // Soft-skip: allowlist includes events we may not have wired yet
        // (e.g. checkout_clicked before a conversion action exists).
        return new Response(JSON.stringify({
            ok: true,
            skipped: 'conversion_action_unmapped',
            event_name: eventName,
        }), {
            status: 200,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const ud = (body.user_data && typeof body.user_data === 'object') ? body.user_data : {};
    const gclid  = clampString(ud.gclid,  256);
    const gbraid = clampString(ud.gbraid, 256);
    const wbraid = clampString(ud.wbraid, 256);

    if (!gclid && !gbraid && !wbraid) {
        console.log(JSON.stringify({
            evt: 'gads_skipped_no_click_id',
            event_name: eventName,
            transaction_id: transactionId,
        }));
        return new Response(JSON.stringify({
            ok: true,
            skipped: 'no_click_id',
            event_name: eventName,
        }), {
            status: 200,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const customerId = String(env.GOOGLE_ADS_CUSTOMER_ID).replace(/-/g, '');
    if (!/^\d{6,12}$/.test(customerId)) {
        return new Response(JSON.stringify({ ok: false, error: 'bad_customer_id' }), {
            status: 503,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const conversion = {
        conversionAction,
        conversionDateTime: formatGoogleAdsDateTime(),
        orderId: transactionId,
    };
    if (gclid)  conversion.gclid  = gclid;
    if (gbraid) conversion.gbraid = gbraid;
    if (wbraid) conversion.wbraid = wbraid;

    const value = typeof body.value === 'number' && Number.isFinite(body.value)
        ? body.value
        : (typeof body.value === 'string' && body.value !== '' && Number.isFinite(Number(body.value))
            ? Number(body.value) : null);
    if (value !== null) conversion.conversionValue = value;
    const currency = clampString(body.currency, 8) || 'ILS';
    if (value !== null) conversion.currencyCode = currency;

    let accessToken;
    try {
        accessToken = await getGoogleAdsAccessToken(env);
    } catch (_) {
        return new Response(JSON.stringify({ ok: false, error: 'oauth_failed' }), {
            status: 502,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'Content-Type': 'application/json',
    };
    const loginCustomerId = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
        ? String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, '')
        : '';
    if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

    const adsUrl = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/`
        + `customers/${encodeURIComponent(customerId)}:uploadClickConversions`;

    const payload = {
        conversions: [conversion],
        partialFailure: true,
    };
    // Optional: validate-only mode for dry runs (no attribution).
    if (env.GOOGLE_ADS_VALIDATE_ONLY === '1' || env.GOOGLE_ADS_VALIDATE_ONLY === 'true') {
        payload.validateOnly = true;
    }

    let upstreamStatus = 0;
    let upstreamBody = '';
    let partialFailure = null;
    let results = null;
    try {
        const r = await fetch(adsUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        upstreamStatus = r.status;
        upstreamBody = await r.text();
        try {
            const j = JSON.parse(upstreamBody);
            partialFailure = j.partialFailureError || null;
            results = j.results || null;
        } catch (_) { /* non-JSON */ }
    } catch (e) {
        console.log(JSON.stringify({
            evt: 'gads_upstream_error',
            event_name: eventName,
            error: String(e && e.message || e),
        }));
        return new Response(JSON.stringify({ ok: false, error: 'upstream_unreachable' }), {
            status: 502,
            headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const httpOk = upstreamStatus >= 200 && upstreamStatus < 300;
    // partialFailureError present means the conversion itself was rejected
    // even on HTTP 200 (e.g. CLICK_NOT_FOUND when debug is on). Treat as soft
    // failure for logging; still return 200 so the browser nav isn't blocked.
    const hasPartialFailure = !!(partialFailure && (
        partialFailure.code || partialFailure.message || (partialFailure.details && partialFailure.details.length)
    ));

    console.log(JSON.stringify({
        evt: 'gads_forwarded',
        event_name: eventName,
        internal: clampString(body.internal_name, 64) || null,
        transaction_id: transactionId,
        upstream_status: upstreamStatus,
        had_gclid: !!gclid,
        had_gbraid: !!gbraid,
        had_wbraid: !!wbraid,
        partial_failure: hasPartialFailure,
        validate_only: !!(payload.validateOnly),
        partial_failure_message: hasPartialFailure
            ? clampString(partialFailure.message, 200)
            : null,
    }));

    return new Response(JSON.stringify({
        ok: httpOk && !hasPartialFailure,
        skipped: null,
        upstream_status: upstreamStatus,
        partial_failure: hasPartialFailure,
        results_count: Array.isArray(results) ? results.length : 0,
    }), {
        // Always 200 on a successful upstream round-trip so keepalive fetches
        // from the landing page don't surface as network errors; ok/partial
        // flags carry the real outcome.
        status: httpOk ? 200 : 502,
        headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
    });
}

// ─── Free-tier quota ──────────────────────────────────────────────────────────
//
// The desktop app used to own the free-tier counter in an encrypted local file.
// Encryption stopped anyone editing the number down, but nothing stopped them
// deleting the file, and a missing file read as "new install, full quota". On
// Microsoft Store builds the AppData container is wiped by an ordinary
// uninstall, so the reset needed no intent at all.
//
// So the count lives here now. The app holds a cache of the songs it owns (so
// existing work opens offline) and asks before starting anything new. It never
// computes the decision itself, and it never sees the limit except as a number
// to render.
//
// What this does and does not buy: a stock client sends its real hardware
// fingerprint, so uninstall/reinstall no longer resets anything. A patched
// client can still send a random device_id and mint a fresh account — that is
// unavoidable when the client controls the request, and the point is that the
// bar moves from "uninstall the app" to "patch the binary". The per-IP account
// cap below and the `quota_device_wiped` signal exist so that farming shows up
// in analytics rather than passing silently.

/** Advance a timestamp by one calendar month in UTC, clamping the day for
 *  shorter months (Jan 31 → Feb 28/29) so an anchor late in the month doesn't
 *  drift forward over a year. Mirrors the client's previous local rollover so
 *  users don't perceive a change in when their month turns over. */
function addOneCalendarMonthUtc(ms) {
    const d = new Date(ms);
    const year  = d.getUTCFullYear();
    const month = d.getUTCMonth();

    const targetYear  = month === 11 ? year + 1 : year;
    const targetMonth = (month + 1) % 12;

    // Day 0 of the following month is the last day of the target month.
    const daysInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const targetDay    = Math.min(d.getUTCDate(), daysInTarget);

    return Date.UTC(targetYear, targetMonth, targetDay,
                    d.getUTCHours(), d.getUTCMinutes(),
                    d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** Walk the period anchor forward until it contains `nowMs`. Uses the server
 *  clock exclusively — the old client-side version advanced on the local clock,
 *  so setting the system date forward a month cleared the period for free.
 *
 *  The iteration guard covers a corrupt or absurd anchor; without it a bad row
 *  could spin the isolate until Cloudflare kills the request. */
function rollPeriodForward(periodStartMs, nowMs) {
    let start = periodStartMs;
    let rolled = false;

    for (let i = 0; i < 600 && nowMs >= addOneCalendarMonthUtc(start); i++) {
        start = addOneCalendarMonthUtc(start);
        rolled = true;
    }

    return { periodStart: start, rolled };
}

function clampLimit(n) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) return QUOTA_FALLBACK_LIMIT;
    return Math.min(QUOTA_MAX_LIMIT, Math.max(QUOTA_MIN_LIMIT, v));
}

/** Global default limit, changeable with a single UPDATE and no app release.
 *  Falls back to the shipped number on a missing or junk row. */
async function readDefaultLimit(db) {
    try {
        const row = await db.prepare(
            `SELECT value FROM quota_config WHERE key = 'default_limit'`
        ).first();

        if (!row || row.value === null || row.value === undefined) return QUOTA_FALLBACK_LIMIT;

        const parsed = Number(row.value);
        if (!Number.isFinite(parsed)) return QUOTA_FALLBACK_LIMIT;

        return clampLimit(parsed);
    } catch (e) {
        console.log(JSON.stringify({ evt: 'quota_config_read_failed', error: String(e && e.message || e) }));
        return QUOTA_FALLBACK_LIMIT;
    }
}

/** The limit actually enforced for a period in progress.
 *
 *  `period_limit` is snapshotted when the period starts, so taking the global
 *  default down can't strand someone who is already above the new number — the
 *  cut lands at their next rollover. Putting it up applies right away, because
 *  there's no reason to make a user wait for good news. This is the rule whose
 *  absence produced the original support case: a 10 → 5 change mid-period took
 *  one user from "7 songs left" to "1 song left" overnight. */
function resolveEffectiveLimit(periodLimit, configuredLimit) {
    return Math.max(clampLimit(periodLimit), clampLimit(configuredLimit));
}

async function quotaCountUsed(db, deviceId, periodStart) {
    const row = await db.prepare(
        `SELECT COUNT(*) AS n FROM quota_songs
          WHERE device_id = ?1 AND period_start = ?2`
    ).bind(deviceId, periodStart).first();

    return row ? Number(row.n) || 0 : 0;
}

async function quotaIsOwned(db, deviceId, songHash) {
    const row = await db.prepare(
        `SELECT 1 AS hit FROM quota_songs WHERE device_id = ?1 AND song_hash = ?2`
    ).bind(deviceId, songHash).first();

    return !!row;
}

/** Newest-first page of owned hashes, for the client's offline cache. */
async function quotaFetchOwned(db, deviceId) {
    const res = await db.prepare(
        `SELECT song_hash FROM quota_songs
          WHERE device_id = ?1
          ORDER BY granted_at DESC
          LIMIT ?2`
    ).bind(deviceId, QUOTA_OWNED_PAGE_SIZE).all();

    return (res && res.results ? res.results : []).map(r => r.song_hash);
}

/** Approximate per-IP ceiling on *new* account rows per day.
 *
 *  KV has no atomic increment, so two simultaneous creations can both read the
 *  same counter — this is a speed bump against scripted device_id farming, not
 *  a guarantee. Set high enough that a shared studio, a classroom or a NAT'd
 *  office never trips it; the point is to make farming visible and slow, and
 *  the log line below is as valuable as the block. */
const QUOTA_NEW_ACCOUNTS_PER_IP_PER_DAY = 20;

async function quotaCheckAccountCreationBudget(env, request) {
    if (!env.PAIRINGS) return { allowed: true, count: 0 };

    const ip = coarseIp(request);
    if (!ip) return { allowed: true, count: 0 };

    const day = new Date().toISOString().slice(0, 10);
    const key = `qacct:${day}:${ip}`;

    let count = 0;
    try {
        const raw = await env.PAIRINGS.get(key);
        count = raw ? Number(raw) || 0 : 0;
    } catch (e) {
        return { allowed: true, count: 0 };
    }

    if (count >= QUOTA_NEW_ACCOUNTS_PER_IP_PER_DAY) {
        return { allowed: false, count, key };
    }

    return { allowed: true, count, key };
}

async function quotaBumpAccountCreationBudget(env, key, count) {
    if (!env.PAIRINGS || !key) return;
    try {
        await env.PAIRINGS.put(key, String(count + 1), { expirationTtl: 2 * 24 * 60 * 60 });
    } catch (e) { /* best effort */ }
}

/** Load the account, creating it on first contact, and advance its period if a
 *  month has elapsed. Returns the live view the request should reason about.
 *
 *  `existedBefore` comes from the caller's own existence check, which it needs
 *  anyway to decide whether to charge the per-IP creation budget. Two
 *  simultaneous first requests can both report `created` — the INSERT is
 *  ON CONFLICT DO NOTHING and the seed is idempotent, so the only cost is
 *  double-charging one slot of that budget. */
async function quotaEnsureAccount(db, deviceId, nowMs, meta, defaultLimit, existedBefore) {
    if (!existedBefore) {
        await db.prepare(
            `INSERT INTO quota_accounts
                (device_id, created_at, last_seen_at, period_start, period_limit,
                 bcid, platform, app_version)
             VALUES (?1, ?2, ?2, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(device_id) DO NOTHING`
        ).bind(deviceId, nowMs, defaultLimit,
               meta.bcid || null, meta.platform || null, meta.appVersion || null).run();
    }

    const row = await db.prepare(
        `SELECT device_id, created_at, period_start, period_limit, limit_override,
                bcid, seeded_from_local
           FROM quota_accounts WHERE device_id = ?1`
    ).bind(deviceId).first();

    const created = !existedBefore;

    const { periodStart, rolled } = rollPeriodForward(Number(row.period_start), nowMs);

    const configured = row.limit_override === null || row.limit_override === undefined
        ? defaultLimit
        : clampLimit(row.limit_override);

    // On rollover the snapshot catches up to whatever is configured now, which
    // is where a lowered limit finally takes effect.
    let periodLimit = clampLimit(row.period_limit);
    if (rolled) periodLimit = configured;

    if (rolled) {
        await db.prepare(
            `UPDATE quota_accounts
                SET period_start = ?2, period_limit = ?3, last_seen_at = ?4
              WHERE device_id = ?1`
        ).bind(deviceId, periodStart, periodLimit, nowMs).run();
    } else {
        await db.prepare(
            `UPDATE quota_accounts
                SET last_seen_at = ?2,
                    platform     = COALESCE(?3, platform),
                    app_version  = COALESCE(?4, app_version)
              WHERE device_id = ?1`
        ).bind(deviceId, nowMs, meta.platform || null, meta.appVersion || null).run();
    }

    return {
        deviceId,
        createdAt: Number(row.created_at),
        periodStart,
        periodLimit,
        effectiveLimit: resolveEffectiveLimit(periodLimit, configured),
        canonicalBcid: row.bcid || null,
        seededFromLocal: !!Number(row.seeded_from_local),
        created,
        rolled,
    };
}

/** Record a secondary identity → account mapping. This is what lets a wiped
 *  install recover the bcid it was minted with, so a reinstall stops looking
 *  like a brand-new user in the funnels. */
async function quotaLinkIdentity(db, kind, value, deviceId, nowMs) {
    if (!value) return;
    await db.prepare(
        `INSERT INTO quota_identity_links (kind, value, device_id, linked_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(kind, value) DO UPDATE SET device_id = ?3, linked_at = ?4`
    ).bind(kind, value, deviceId, nowMs).run();
}

/** The numbers every /quota response carries. The client renders these
 *  verbatim and derives nothing, which is why the limit no longer needs to
 *  exist as a compile-time constant in the app. */
function quotaSnapshot(account, used, extra = {}) {
    const remaining = Math.max(0, account.effectiveLimit - used);
    return {
        ok: true,
        used,
        limit: account.effectiveLimit,
        remaining,
        period_start: account.periodStart,
        period_end: addOneCalendarMonthUtc(account.periodStart),
        server_time: Date.now(),
        bcid: account.canonicalBcid,
        ...extra,
    };
}

function quotaJson(body, status, cors) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
    });
}

// ─── Entitlement signing ──────────────────────────────────────────────────────
//
// The worker is the sole authority for both tiers. Every quota/licence answer
// carries a compact JWS (alg EdDSA) the client verifies against a public key
// baked into the binary. This is what makes the fake-server and hand-written
// file attacks fail: the client trusts the signature, not the transport or the
// local file, and the private key never leaves Cloudflare.

/** base64url without padding, from raw bytes. Built with a loop rather than
 *  String.fromCharCode(...bytes) because the owned-song list can push the token
 *  past the argument-count limit of the spread form. */
function bytesToB64u(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function strToB64u(str) {
    return bytesToB64u(new TextEncoder().encode(str));
}

// Imported once per isolate. A missing/invalid secret rejects the promise; we
// null it out so a later request can retry rather than caching the failure for
// the lifetime of the isolate.
let _signingKeyPromise = null;

function getSigningKey(env) {
    if (!_signingKeyPromise) {
        _signingKeyPromise = (async () => {
            const b64 = env.ENTITLEMENT_SIGNING_KEY;
            if (!b64) throw new Error('signing_key_unavailable');
            const pkcs8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
        })().catch(e => { _signingKeyPromise = null; throw e; });
    }
    return _signingKeyPromise;
}

/** Sign a payload object into a compact JWS string. */
async function signEntitlement(env, payload) {
    const key = await getSigningKey(env);
    const header = { alg: 'EdDSA', typ: 'JWT', kid: payload.kid || ENTITLEMENT_KEY_ID };
    const signingInput = strToB64u(JSON.stringify(header)) + '.' + strToB64u(JSON.stringify(payload));
    const sig = new Uint8Array(await crypto.subtle.sign(
        { name: 'Ed25519' }, key, new TextEncoder().encode(signingInput)));
    return signingInput + '.' + bytesToB64u(sig);
}

/** Common claims shared by every token. `machineId`/`nonce` are echoed straight
 *  back so the client can bind the token to what it computed and just sent. */
function entitlementBase(deviceId, machineId, tier, nonce, nowMs) {
    return {
        v: 1,
        kid: ENTITLEMENT_KEY_ID,
        device_id: deviceId,
        machine_id: machineId || '',
        tier,
        iat: nowMs,
        exp: nowMs + ENTITLEMENT_TTL_MS,
        nonce: nonce || '',
    };
}

/** Attach a `signed` JWS to an existing plaintext response body. Best-effort:
 *  if signing fails (e.g. the secret is missing) the plaintext body still goes
 *  out, so already-shipped clients are unaffected. New clients treat a missing
 *  signature as "couldn't reach the server" and fall back to their offline
 *  cache — fail-closed for anything not already owned. */
async function attachSigned(body, env, payload) {
    try {
        body.signed = await signEntitlement(env, payload);
    } catch (e) {
        console.log(JSON.stringify({ evt: 'entitlement_sign_failed', error: String(e && e.message || e) }));
    }
    return body;
}

/**
 * Quota route handler.
 *
 *   POST /quota/state  — sync: current usage, period, and owned-song cache.
 *                        Carries the one-time migration seed.
 *   POST /quota/claim  — ask for a slot for one song. The only call that can
 *                        consume quota, and the only gate on new work.
 *   POST /quota/grant  — support/admin: set an override, re-anchor a period,
 *                        or hand over songs. Requires QUOTA_ADMIN_TOKEN.
 */
async function handleQuota(request, env, url, ctx) {
    const origin = request.headers.get('origin') || '';
    const cors = pairingsCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
        return quotaJson({ ok: false, error: 'method_not_allowed' }, 405, cors);
    }

    const db = env.QUOTA_DB;
    if (!db) {
        console.error('QUOTA_DB binding missing — did you bind the D1 database in wrangler.toml?');
        return quotaJson({ ok: false, error: 'db_unavailable' }, 503, cors);
    }

    let body;
    try {
        body = await readJsonBounded(request, QUOTA_MAX_BODY_BYTES);
    } catch (e) {
        console.log(JSON.stringify({
            evt: 'quota_bad_body',
            path: url.pathname,
            error: e.message,
            content_length: request.headers.get('content-length') || null,
        }));
        return quotaJson({ ok: false, error: e.message }, e.statusCode || 400, cors);
    }

    if (url.pathname === '/quota/grant') {
        return handleQuotaGrant(body, env, db, cors);
    }

    const deviceId = clampString(body.device_id, 64);
    if (!deviceId || !QUOTA_ID_RE.test(deviceId)) {
        return quotaJson({ ok: false, error: 'invalid_device_id' }, 400, cors);
    }

    const bcid = (() => {
        const v = clampString(body.bcid, 80);
        return v && BCID_RE.test(v) ? v : null;
    })();

    const meta = {
        bcid,
        platform:   clampString(body.platform, 32),
        appVersion: clampString(body.app_version, 32),
    };

    // Echoed into the signed token so the client can bind it to what it sent.
    // Both optional on the wire: a pre-signing client omits them and simply
    // ignores the `signed` field it gets back. machine_id is only meaningful
    // for the paid tier; the free tier is keyed on device_id.
    const machineId = (() => {
        const v = clampString(body.machine_id, 32);
        return v && MACHINE_ID_RE.test(v) ? v : '';
    })();
    const nonce = (() => {
        const v = clampString(body.nonce, 64);
        return v && NONCE_RE.test(v) ? v : '';
    })();

    // Validate each route's own payload before touching the database. Doing
    // this after quotaEnsureAccount would let a malformed claim leave an
    // account row behind as a side effect, which both pollutes the ledger and
    // spends the caller's per-IP creation budget on a request that did nothing.
    let songHash = null;
    if (url.pathname === '/quota/claim') {
        songHash = clampString(body.song_hash, 64);
        if (!songHash || !QUOTA_ID_RE.test(songHash)) {
            return quotaJson({ ok: false, error: 'invalid_song_hash' }, 400, cors);
        }
    }

    const nowMs = Date.now();
    const defaultLimit = await readDefaultLimit(db);

    // Creating a row is the only expensive-to-abuse operation here, so the
    // budget check happens before it and nowhere else.
    let budget = { allowed: true, count: 0, key: null };
    const existing = await db.prepare(
        `SELECT 1 AS hit FROM quota_accounts WHERE device_id = ?1`
    ).bind(deviceId).first();

    if (!existing) {
        budget = await quotaCheckAccountCreationBudget(env, request);
        if (!budget.allowed) {
            console.log(JSON.stringify({
                evt: 'quota_account_budget_exceeded',
                count: budget.count,
                path: url.pathname,
            }));
            return quotaJson({ ok: false, error: 'rate_limited' }, 429, cors);
        }
    }

    const account = await quotaEnsureAccount(db, deviceId, nowMs, meta, defaultLimit, !!existing);

    if (account.created) {
        await quotaBumpAccountCreationBudget(env, budget.key, budget.count);
    }

    if (bcid) {
        await quotaLinkIdentity(db, 'bcid', bcid, deviceId, nowMs);

        // First bcid seen for an account becomes the canonical one: it's the
        // identity the download page minted, so it's the one carrying the ad
        // click. Later ones are recorded as links but never promoted.
        if (!account.canonicalBcid) {
            await db.prepare(
                `UPDATE quota_accounts SET bcid = ?2 WHERE device_id = ?1 AND bcid IS NULL`
            ).bind(deviceId, bcid).run();
            account.canonicalBcid = bcid;
        }
    }

    if (url.pathname === '/quota/claim') {
        return handleQuotaClaim(songHash, env, db, cors, account, nowMs, machineId, nonce);
    }

    if (url.pathname === '/quota/state') {
        const clientIp = request.headers.get('cf-connecting-ip') || '';
        return handleQuotaState(body, env, db, cors, account, nowMs, ctx, machineId, nonce, clientIp);
    }

    return quotaJson({ ok: false, error: 'not_found' }, 404, cors);
}

async function handleQuotaClaim(songHash, env, db, cors, account, nowMs, machineId, nonce) {
    // Build the signed twin of a snapshot: the same numbers plus the claim
    // decision, in a token the client verifies instead of trusting the body.
    const signClaim = async (snapshot, allowed, reason) => {
        const payload = entitlementBase(account.deviceId, machineId, 'free', nonce, nowMs);
        payload.quota = {
            used: snapshot.used,
            limit: snapshot.limit,
            remaining: snapshot.remaining,
            period_start: snapshot.period_start,
            period_end: snapshot.period_end,
        };
        payload.decision = { song_hash: songHash, allowed, reason };
        payload.bcid = account.canonicalBcid || '';
        return attachSigned(snapshot, env, payload);
    };

    // A test-arm device must register a free key before it can edit anything,
    // songs it already owns included, matching the lock the app shows.
    if (await deviceNeedsRegistration(env, db, account.deviceId, nowMs)) {
        const used = await quotaCountUsed(db, account.deviceId, account.periodStart);
        const snapshot = quotaSnapshot(account, used, {
            allowed: false,
            reason: 'registration_required',
        });
        console.log(JSON.stringify({ evt: 'quota_claim', granted: false, reason: 'registration_required' }));
        return quotaJson(await signClaim(snapshot, false, 'registration_required'), 200, cors);
    }

    // Owning a song is permanent and free to re-open, which preserves the
    // grandfathering the local implementation had: re-analysing something you
    // already have never costs a second slot.
    if (await quotaIsOwned(db, account.deviceId, songHash)) {
        const used = await quotaCountUsed(db, account.deviceId, account.periodStart);
        const snapshot = quotaSnapshot(account, used, {
            allowed: true,
            reason: 'already_owned',
        });
        return quotaJson(await signClaim(snapshot, true, 'already_owned'), 200, cors);
    }

    // Count and insert in one statement so two claims arriving together can't
    // both pass a separate check. D1 gives no multi-statement transaction here,
    // and a conditional INSERT...SELECT is the cheapest way to stay correct.
    await db.prepare(
        `INSERT INTO quota_songs (device_id, song_hash, granted_at, period_start, source)
         SELECT ?1, ?2, ?3, ?4, 'claim'
          WHERE (SELECT COUNT(*) FROM quota_songs
                  WHERE device_id = ?1 AND period_start = ?4) < ?5
         ON CONFLICT(device_id, song_hash) DO NOTHING`
    ).bind(account.deviceId, songHash, nowMs, account.periodStart, account.effectiveLimit).run();

    // Re-read rather than trusting `meta.changes`, whose shape has moved
    // between D1 versions. Two indexed lookups is a fine price for a decision
    // this load-bearing.
    const granted = await quotaIsOwned(db, account.deviceId, songHash);
    const used    = await quotaCountUsed(db, account.deviceId, account.periodStart);

    console.log(JSON.stringify({
        evt: 'quota_claim',
        granted,
        used,
        limit: account.effectiveLimit,
        period_start: account.periodStart,
        rolled: account.rolled,
    }));

    const reason = granted ? 'granted' : 'quota_exhausted';
    const snapshot = quotaSnapshot(account, used, { allowed: granted, reason });
    return quotaJson(await signClaim(snapshot, granted, reason), 200, cors);
}

async function handleQuotaState(body, env, db, cors, account, nowMs, ctx, machineId, nonce, clientIp) {
    const seed = body.seed;
    let seeded = 0;

    // Migration seed. Only ever applied to an account row this request just
    // created, which is the whole security property: a returning device cannot
    // re-seed itself back to zero usage.
    //
    // A device that already wiped its local state before upgrading will seed as
    // "0 used" and get a fresh period, and there is no way to tell that apart
    // from a genuinely new install. That's a deliberate one-time amnesty — the
    // alternative is deleting the owned-song history of every honest user — and
    // it closes permanently once the row exists.
    if (account.created && seed && Array.isArray(seed.hashes)) {
        const hashes = seed.hashes
            .map(h => clampString(h, 64))
            .filter(h => h && QUOTA_ID_RE.test(h))
            .slice(0, QUOTA_MAX_SEED_HASHES);

        if (hashes.length) {
            // period_start 0 marks "owned before the ledger existed". The usage
            // count only matches the account's real period anchor, so seeded
            // songs stay openable without consuming anything.
            const stmt = db.prepare(
                `INSERT INTO quota_songs (device_id, song_hash, granted_at, period_start, source)
                 VALUES (?1, ?2, ?3, 0, 'seed')
                 ON CONFLICT(device_id, song_hash) DO NOTHING`
            );

            await db.batch(hashes.map(h => stmt.bind(account.deviceId, h, nowMs)));
            seeded = hashes.length;

            await db.prepare(
                `UPDATE quota_accounts SET seeded_from_local = 1 WHERE device_id = ?1`
            ).bind(account.deviceId).run();
        }
    }

    // The abuse signal. A client reporting first launch against a device row we
    // already had means the local state went away but the machine didn't —
    // exactly the shape of the case that motivated all of this. Reported from
    // the server because a client that just wiped itself is not a trustworthy
    // narrator.
    const clientClaimsFirstLaunch = body.first_launch === true;
    if (clientClaimsFirstLaunch && !account.created && ctx) {
        // Attribute to the account's original bcid when we have one — that's the
        // identity the install was minted with, and the reason it's stored on the
        // account at all. Without one the only handle is the device id, which
        // makes an unlinked person; `identified_by` keeps those filterable rather
        // than silently mixed in with real users.
        const distinctId = account.canonicalBcid || `hw_${account.deviceId.slice(0, 16)}`;

        ctx.waitUntil(sendToPostHog('quota_device_wiped', distinctId, {
            identified_by:     account.canonicalBcid ? 'bcid' : 'device_id',
            device_age_days:   Math.max(0, Math.round((nowMs - account.createdAt) / 86400000)),
            songs_used:        await quotaCountUsed(db, account.deviceId, account.periodStart),
            quota_limit:       account.effectiveLimit,
            platform:          clampString(body.platform, 32) || null,
            app_version:       clampString(body.app_version, 32) || null,
            seeded_from_local: account.seededFromLocal,
        }, clientIp));
    }

    const used  = await quotaCountUsed(db, account.deviceId, account.periodStart);
    const owned = await quotaFetchOwned(db, account.deviceId);
    const ownedTruncated = owned.length >= QUOTA_OWNED_PAGE_SIZE;

    const snapshot = quotaSnapshot(account, used, {
        owned,
        owned_truncated: ownedTruncated,
        seeded,
        account_created: account.created,
        // UI hint only; the claim above is what actually enforces it.
        registration_required: await deviceNeedsRegistration(env, db, account.deviceId, nowMs),
    });

    // The owned list must be inside the signed payload, not just the body —
    // otherwise the client's offline cache stays forgeable and someone grants
    // themselves unlimited offline songs by editing quota.dat.
    const payload = entitlementBase(account.deviceId, machineId, 'free', nonce, nowMs);
    payload.quota = {
        used: snapshot.used,
        limit: snapshot.limit,
        remaining: snapshot.remaining,
        period_start: snapshot.period_start,
        period_end: snapshot.period_end,
    };
    payload.owned = owned;
    payload.owned_truncated = ownedTruncated;
    payload.bcid = account.canonicalBcid || '';

    return quotaJson(await attachSigned(snapshot, env, payload), 200, cors);
}

/** Support endpoint. Kept in the worker rather than done by hand in the D1
 *  console so every grant is one auditable call with a reason attached.
 *
 *  Set the token with: wrangler secret put QUOTA_ADMIN_TOKEN */
async function handleQuotaGrant(body, env, db, cors) {
    if (!env.QUOTA_ADMIN_TOKEN) {
        return quotaJson({ ok: false, error: 'admin_disabled' }, 503, cors);
    }

    const token = clampString(body.admin_token, 256);
    if (token !== env.QUOTA_ADMIN_TOKEN) {
        return quotaJson({ ok: false, error: 'forbidden' }, 403, cors);
    }

    const deviceId = clampString(body.device_id, 64);
    if (!deviceId || !QUOTA_ID_RE.test(deviceId)) {
        return quotaJson({ ok: false, error: 'invalid_device_id' }, 400, cors);
    }

    const exists = await db.prepare(
        `SELECT 1 AS hit FROM quota_accounts WHERE device_id = ?1`
    ).bind(deviceId).first();

    if (!exists) {
        return quotaJson({ ok: false, error: 'unknown_device' }, 404, cors);
    }

    const nowMs = Date.now();
    const notes = clampString(body.notes, 512);
    const applied = [];

    if (body.limit_override !== undefined) {
        const override = body.limit_override === null ? null : clampLimit(body.limit_override);
        await db.prepare(
            `UPDATE quota_accounts
                SET limit_override = ?2, notes = COALESCE(?3, notes)
              WHERE device_id = ?1`
        ).bind(deviceId, override, notes).run();
        applied.push(`limit_override=${override}`);
    }

    // Re-anchoring the period to now is the "give them a clean month" lever.
    // Past songs stay owned; only the usage window moves.
    if (body.reset_period === true) {
        const defaultLimit = await readDefaultLimit(db);
        await db.prepare(
            `UPDATE quota_accounts
                SET period_start = ?2, period_limit = ?3, notes = COALESCE(?4, notes)
              WHERE device_id = ?1`
        ).bind(deviceId, nowMs, defaultLimit, notes).run();
        applied.push('reset_period');
    }

    if (Array.isArray(body.grant_hashes) && body.grant_hashes.length) {
        const hashes = body.grant_hashes
            .map(h => clampString(h, 64))
            .filter(h => h && QUOTA_ID_RE.test(h))
            .slice(0, QUOTA_MAX_SEED_HASHES);

        if (hashes.length) {
            const stmt = db.prepare(
                `INSERT INTO quota_songs (device_id, song_hash, granted_at, period_start, source)
                 VALUES (?1, ?2, ?3, 0, 'grant')
                 ON CONFLICT(device_id, song_hash) DO NOTHING`
            );
            await db.batch(hashes.map(h => stmt.bind(deviceId, h, nowMs)));
            applied.push(`grant_hashes=${hashes.length}`);
        }
    }

    console.log(JSON.stringify({ evt: 'quota_grant', applied, notes: notes || null }));

    return quotaJson({ ok: true, applied }, 200, cors);
}

// ─── Paid licence (worker-mediated Lemon Squeezy) ─────────────────────────────
//
// The client no longer talks to api.lemonsqueezy.com and no longer trusts a
// self-signed local file. It POSTs here; the worker calls the Lemon Squeezy
// License API server-side, caches the verdict in D1, and returns an
// Ed25519-signed pro token. A fake server can't forge the token (no private
// key) and can't strip it to downgrade a paid user into anything worse than
// "looks offline" — which fails closed to the last good cached token, not to
// free.

const LS_LICENSE_API = 'https://api.lemonsqueezy.com/v1/licenses';
const LICENSE_MAX_BODY_BYTES = 4 * 1024;

/** Lemon Squeezy license keys are UUID-shaped, but be permissive: any
 *  hyphenated alphanumeric of a sane length. Bad input is rejected before any
 *  upstream call so we don't spend the store's rate limit on junk. */
const LICENSE_KEY_RE = /^[A-Za-z0-9-]{8,128}$/;
const INSTANCE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** "BeatCue - Free". Compiled in as a floor under FREE_PRODUCT_IDS /
 *  FREE_VARIANT_IDS: the failure mode of a missing var must be "free key stays
 *  free", never "free key signs pro". */
const DEFAULT_FREE_PRODUCT_IDS = ['1385673'];
const DEFAULT_FREE_VARIANT_IDS = ['2164536'];

function idSet(raw, defaults) {
    const set = new Set(defaults);
    String(raw || '').split(',').map(s => s.trim()).filter(Boolean).forEach(s => set.add(s));
    return set;
}

/** Tier a Lemon Squeezy key entitles, from the product/variant it was sold
 *  under. Anything not configured as free is a paid product. */
function licenseTierFor(env, lic) {
    const freeProducts = idSet(env.FREE_PRODUCT_IDS, DEFAULT_FREE_PRODUCT_IDS);
    const freeVariants = idSet(env.FREE_VARIANT_IDS, DEFAULT_FREE_VARIANT_IDS);
    if (lic.productId && freeProducts.has(lic.productId)) return 'free';
    if (lic.variantId && freeVariants.has(lic.variantId)) return 'free';
    return 'pro';
}

/** POST to a Lemon Squeezy License API action as form-urlencoded (what that API
 *  expects). Returns the parsed JSON plus the HTTP status; throws only on a
 *  transport failure, which the caller turns into "serve the cache". */
async function lsLicenseCall(action, params) {
    const res = await fetch(`${LS_LICENSE_API}/${action}`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* leave null */ }
    return { httpStatus: res.status, json };
}

/** Normalise the varied Lemon Squeezy shapes (activate vs validate, valid vs
 *  error) into one struct the rest of the handler reasons about. */
function parseLsLicense(json) {
    const lk   = (json && json.license_key) || {};
    const inst = (json && json.instance) || {};
    const meta = (json && json.meta) || {};

    const expiresAt = lk.expires_at ? Date.parse(lk.expires_at) : 0;

    return {
        valid:      !!json && (json.valid === true || json.activated === true),
        status:     lk.status || null,   // active | inactive | expired | disabled
        endsAt:     Number.isFinite(expiresAt) ? expiresAt : 0,
        instanceId: inst.id != null ? String(inst.id) : null,
        email:      meta.customer_email || null,
        name:       meta.customer_name || null,
        orderId:    meta.order_id != null ? String(meta.order_id) : null,
        productId:  meta.product_id != null ? String(meta.product_id) : null,
        variantId:  meta.variant_id != null ? String(meta.variant_id) : null,
        error:      (json && json.error) || null,
    };
}

async function licenseUpsert(db, deviceId, machineId, licenseKey, lic, nowMs, tier) {
    await db.prepare(
        `INSERT INTO license_activations
            (device_id, machine_id, license_key, instance_id, status, ends_at,
             email, name, order_id, created_at, last_validated_at,
             tier, product_id, variant_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12, ?13)
         ON CONFLICT(device_id) DO UPDATE SET
            machine_id  = ?2,
            license_key = ?3,
            instance_id = COALESCE(?4, instance_id),
            status      = ?5,
            ends_at     = ?6,
            email       = COALESCE(?7, email),
            name        = COALESCE(?8, name),
            order_id    = COALESCE(?9, order_id),
            last_validated_at = ?10,
            tier        = ?11,
            product_id  = COALESCE(?12, product_id),
            variant_id  = COALESCE(?13, variant_id)`
    ).bind(deviceId, machineId || null, licenseKey, lic.instanceId,
           lic.status, lic.endsAt || 0, lic.email, lic.name, lic.orderId, nowMs,
           tier, lic.productId || null, lic.variantId || null).run();
}

/** Sign a licence entitlement ('pro' or 'free') from a resolved verdict. */
async function signLicenseToken(env, deviceId, machineId, nonce, nowMs, lic, tier) {
    const payload = entitlementBase(deviceId, machineId, tier, nonce, nowMs);
    payload.license = {
        status:      lic.status || 'active',
        ends_at:     lic.endsAt || 0,
        email:       lic.email || '',
        order_id:    lic.orderId || '',
        instance_id: lic.instanceId || '',
    };
    return signEntitlement(env, payload);
}

/** Bookkeeping once a device holds a working free key: the arm row records
 *  when, the registration that delivered it closes, and the key is linked to
 *  the quota account (hashed; the raw key lives only in license_activations). */
async function recordFreeKeyActivated(db, deviceId, licenseKey, nowMs) {
    await db.prepare(
        `UPDATE install_resolutions
            SET key_activated_at = COALESCE(key_activated_at, ?2)
          WHERE device_id = ?1`
    ).bind(deviceId, nowMs).run();

    await db.prepare(
        `UPDATE registrations SET completed_at = ?3
          WHERE device_id = ?1 AND pending_license_key = ?2 AND completed_at IS NULL`
    ).bind(deviceId, licenseKey, nowMs).run();

    await quotaLinkIdentity(db, 'license', await sha256LowerHex(licenseKey), deviceId, nowMs);
}

/** Shape of a "not licensed" answer: no signed token, so the client stays in
 *  Demo. Denial isn't a forgeable attack (fail-closed), so it needn't be
 *  signed. */
function licenseDenied(reason, status, cors, extra = {}) {
    return quotaJson({ ok: true, valid: false, reason, status: status || null, ...extra }, 200, cors);
}

/**
 * Licence route handler.
 *
 *   POST /license/activate    — bind a licence key to this device (creates a
 *                               Lemon Squeezy activation instance).
 *   POST /license/validate    — re-check an existing activation (launch + the
 *                               periodic recheck). Also the migration entry
 *                               point: an old install sends its key (+ old
 *                               instance_id) and gets the new token form.
 *   POST /license/deactivate  — release this device's activation slot.
 */
async function handleLicense(request, env, url, ctx) {
    const origin = request.headers.get('origin') || '';
    const cors = pairingsCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
        return quotaJson({ ok: false, error: 'method_not_allowed' }, 405, cors);
    }

    const db = env.QUOTA_DB;
    if (!db) {
        console.error('QUOTA_DB binding missing — licence routes need the D1 database.');
        return quotaJson({ ok: false, error: 'db_unavailable' }, 503, cors);
    }

    let body;
    try {
        body = await readJsonBounded(request, LICENSE_MAX_BODY_BYTES);
    } catch (e) {
        return quotaJson({ ok: false, error: e.message }, e.statusCode || 400, cors);
    }

    const deviceId = clampString(body.device_id, 64);
    if (!deviceId || !QUOTA_ID_RE.test(deviceId)) {
        return quotaJson({ ok: false, error: 'invalid_device_id' }, 400, cors);
    }

    const machineId = (() => {
        const v = clampString(body.machine_id, 32);
        return v && MACHINE_ID_RE.test(v) ? v : '';
    })();
    const nonce = (() => {
        const v = clampString(body.nonce, 64);
        return v && NONCE_RE.test(v) ? v : '';
    })();

    const nowMs  = Date.now();
    const action = url.pathname.slice('/license/'.length);

    const row = await db.prepare(
        `SELECT device_id, machine_id, license_key, instance_id, status, ends_at,
                email, name, order_id, last_validated_at, tier
           FROM license_activations WHERE device_id = ?1`
    ).bind(deviceId).first();

    try {
        if (action === 'deactivate') {
            return await handleLicenseDeactivate(env, db, cors, body, row, deviceId);
        }
        if (action === 'activate') {
            return await handleLicenseActivate(env, db, cors, body, deviceId, machineId, nonce, nowMs);
        }
        if (action === 'validate') {
            return await handleLicenseValidate(env, db, cors, body, row, deviceId, machineId, nonce, nowMs);
        }
        return quotaJson({ ok: false, error: 'not_found' }, 404, cors);
    } catch (e) {
        // A transport failure to Lemon Squeezy lands here. For validate we try
        // to serve the cache before giving up (see handleLicenseValidate); a
        // throw reaching this point means even that wasn't possible.
        console.log(JSON.stringify({ evt: 'license_upstream_error', action, error: String(e && e.message || e) }));
        return quotaJson({ ok: false, error: 'upstream_unavailable' }, 502, cors);
    }
}

async function handleLicenseActivate(env, db, cors, body, deviceId, machineId, nonce, nowMs) {
    const licenseKey = clampString(body.license_key, 128);
    if (!licenseKey || !LICENSE_KEY_RE.test(licenseKey)) {
        return quotaJson({ ok: false, error: 'invalid_license_key' }, 400, cors);
    }

    // instance_name is what shows in the Lemon Squeezy dashboard. The machine
    // id is the natural label; fall back to the device id when absent.
    const instanceName = machineId || deviceId.slice(0, 32);
    const { httpStatus, json } = await lsLicenseCall('activate', {
        license_key:   licenseKey,
        instance_name: instanceName,
    });
    const lic = parseLsLicense(json);

    if (!lic.valid || !lic.instanceId) {
        console.log(JSON.stringify({ evt: 'license_activate_denied', http: httpStatus, status: lic.status, error: lic.error }));
        return licenseDenied(lic.error || 'activation_failed', lic.status, cors);
    }

    const tier = licenseTierFor(env, lic);
    await licenseUpsert(db, deviceId, machineId, licenseKey, lic, nowMs, tier);
    if (tier === 'free') await recordFreeKeyActivated(db, deviceId, licenseKey, nowMs);

    const signed = await signLicenseToken(env, deviceId, machineId, nonce, nowMs, lic, tier);
    console.log(JSON.stringify({ evt: 'license_activate_ok', status: lic.status, tier, has_instance: !!lic.instanceId }));
    return quotaJson({
        ok: true, valid: true, status: lic.status, ends_at: lic.endsAt, tier,
        email: lic.email, name: lic.name, order_id: lic.orderId,
        instance_id: lic.instanceId, signed,
    }, 200, cors);
}

async function handleLicenseValidate(env, db, cors, body, row, deviceId, machineId, nonce, nowMs) {
    const licenseKey = row ? row.license_key : clampString(body.license_key, 128);
    if (!licenseKey || !LICENSE_KEY_RE.test(licenseKey)) {
        return quotaJson({ ok: false, error: 'invalid_license_key' }, 400, cors);
    }

    // Prefer a known instance: from our row, else one the migrating client
    // carried over from its old license.dat. With an instance the validate is
    // activation-scoped; without one we must activate to create it (migration
    // from a very old file that never stored an instance id).
    const bodyInstance = (() => {
        const v = clampString(body.instance_id, 64);
        return v && INSTANCE_ID_RE.test(v) ? v : null;
    })();
    let instanceId = (row && row.instance_id) || bodyInstance;

    let resp;
    try {
        if (instanceId) {
            resp = await lsLicenseCall('validate', { license_key: licenseKey, instance_id: instanceId });
        } else {
            resp = await lsLicenseCall('activate', { license_key: licenseKey, instance_name: machineId || deviceId.slice(0, 32) });
        }
    } catch (e) {
        // Lemon Squeezy unreachable. Serve the cached verdict if it's still a
        // live licence — this is the whole reason the D1 cache exists, and it
        // keeps paying users working through an upstream outage, bounded by the
        // token's 7-day exp.
        if (row && row.status === 'active' && (!row.ends_at || Number(row.ends_at) > nowMs)) {
            const cached = {
                status: row.status, endsAt: Number(row.ends_at) || 0, instanceId: row.instance_id,
                email: row.email, name: row.name, orderId: row.order_id,
            };
            const tier = row.tier || 'pro';
            const signed = await signLicenseToken(env, deviceId, machineId, nonce, nowMs, cached, tier);
            console.log(JSON.stringify({ evt: 'license_validate_cached', reason: 'upstream_unreachable', tier }));
            return quotaJson({ ok: true, valid: true, status: cached.status, ends_at: cached.endsAt,
                               tier, cached: true, signed }, 200, cors);
        }
        throw e;
    }

    const lic = parseLsLicense(resp.json);
    if (lic.instanceId) instanceId = lic.instanceId;

    if (!lic.valid) {
        // Authoritative negative: record it so re-validation doesn't keep
        // hammering Lemon Squeezy, and downgrade the client to Demo.
        if (row) {
            await db.prepare(
                `UPDATE license_activations SET status = ?2, ends_at = ?3, last_validated_at = ?4 WHERE device_id = ?1`
            ).bind(deviceId, lic.status || 'inactive', lic.endsAt || 0, nowMs).run();
        }
        console.log(JSON.stringify({ evt: 'license_validate_denied', http: resp.httpStatus, status: lic.status, error: lic.error }));
        return licenseDenied(lic.error || 'invalid_license', lic.status, cors);
    }

    lic.instanceId = instanceId;
    const tier = licenseTierFor(env, lic);
    await licenseUpsert(db, deviceId, machineId, licenseKey, lic, nowMs, tier);
    if (tier === 'free') await recordFreeKeyActivated(db, deviceId, licenseKey, nowMs);

    const signed = await signLicenseToken(env, deviceId, machineId, nonce, nowMs, lic, tier);
    console.log(JSON.stringify({ evt: 'license_validate_ok', status: lic.status, tier }));
    return quotaJson({
        ok: true, valid: true, status: lic.status, ends_at: lic.endsAt, tier,
        email: lic.email, name: lic.name, order_id: lic.orderId,
        instance_id: lic.instanceId, signed,
    }, 200, cors);
}

async function handleLicenseDeactivate(env, db, cors, body, row, deviceId) {
    const licenseKey = row ? row.license_key : clampString(body.license_key, 128);
    const instanceId = (row && row.instance_id) || (() => {
        const v = clampString(body.instance_id, 64);
        return v && INSTANCE_ID_RE.test(v) ? v : null;
    })();

    if (!licenseKey || !instanceId) {
        // Nothing to release upstream; clear any local row so the device drops
        // to Demo on next launch.
        if (row) await db.prepare(`DELETE FROM license_activations WHERE device_id = ?1`).bind(deviceId).run();
        return quotaJson({ ok: true, deactivated: false, reason: 'nothing_to_deactivate' }, 200, cors);
    }

    let deactivated = false;
    try {
        const { json } = await lsLicenseCall('deactivate', { license_key: licenseKey, instance_id: instanceId });
        deactivated = !!(json && json.deactivated);
    } catch (e) {
        // Even if the upstream call fails, drop the local row: the user's intent
        // was to stop using this device. The activation slot may linger on
        // Lemon Squeezy until it's reaped, which support can clear.
        console.log(JSON.stringify({ evt: 'license_deactivate_upstream_error', error: String(e && e.message || e) }));
    }

    await db.prepare(`DELETE FROM license_activations WHERE device_id = ?1`).bind(deviceId).run();
    console.log(JSON.stringify({ evt: 'license_deactivate', deactivated }));
    return quotaJson({ ok: true, deactivated }, 200, cors);
}

// ─── Free-key gate: install resolution + in-app registration ─────────────────
//
// Every install asks the worker once per launch whether it must register. The
// answer depends on a sticky per-device arm:
//
//   existing — account predates EXPERIMENT_START. Keyless free tier as today,
//              never gated; excluded from the experiment's analysis.
//   control  — new device, hash outside TEST_PERCENT. Keyless free tier as
//              today: nothing to activate, nothing to register.
//   test     — new device, hash inside TEST_PERCENT. Must register a free key
//              from inside the app before editing.
//
// The key a test device registers comes back through the webhook, keyed by a
// one-time reg token the app itself minted and sent to checkout, so nothing
// depends on matching the browser to the machine.

const INSTALL_MAX_BODY_BYTES = 4 * 1024;
const REG_RE = /^rg_[A-Za-z0-9_-]{16,40}$/;

/** A reg token stays reusable (repeated "Activate free plan" clicks within a
 *  session share one) for this long before a fresh one is minted. */
const REG_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Parse EXPERIMENT_START as ms epoch or an ISO date. 0 means "not started". */
function experimentStartMs(env) {
    const raw = String(env.EXPERIMENT_START || '').trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return Number(raw);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

function testPercent(env) {
    const n = Number(env.TEST_PERCENT);
    if (!Number.isFinite(n)) return 0;
    return Math.min(100, Math.max(0, Math.floor(n)));
}

function gateEnabled(env) {
    return String(env.GATE_ENABLED || 'true').toLowerCase() !== 'false';
}

/** Deterministic 0-99 bucket for a device, so the arm is reproducible from the
 *  device id and salt alone (and a lost row re-derives the same arm). */
async function experimentBucket(env, deviceId) {
    const hex = await sha256LowerHex((env.EXPERIMENT_SALT || 'free-key-gate-v1') + ':' + deviceId);
    return parseInt(hex.slice(0, 8), 16) % 100;
}

async function assignArm(env, db, deviceId) {
    const startMs = experimentStartMs(env);
    if (!startMs) return 'existing';

    const account = await db.prepare(
        `SELECT created_at FROM quota_accounts WHERE device_id = ?1`
    ).bind(deviceId).first();
    if (account && Number(account.created_at) < startMs) return 'existing';

    return (await experimentBucket(env, deviceId)) < testPercent(env) ? 'test' : 'control';
}

/** True for a test-arm device with the gate on and no live licence. Old app
 *  builds never call /install/resolve, have no arm row, and are never gated. */
async function deviceNeedsRegistration(env, db, deviceId, nowMs) {
    if (!gateEnabled(env)) return false;

    const res = await db.prepare(
        `SELECT arm FROM install_resolutions WHERE device_id = ?1`
    ).bind(deviceId).first();
    if (!res || res.arm !== 'test') return false;

    const lic = await db.prepare(
        `SELECT status, ends_at FROM license_activations WHERE device_id = ?1`
    ).bind(deviceId).first();
    const licenseLive = !!lic && lic.status === 'active'
        && (!Number(lic.ends_at) || Number(lic.ends_at) > nowMs);
    return !licenseLive;
}

function randomToken(prefix, bytes = 18) {
    const raw = new Uint8Array(bytes);
    crypto.getRandomValues(raw);
    return prefix + bytesToB64u(raw);
}

async function handleInstall(request, env, url) {
    const origin = request.headers.get('origin') || '';
    const cors = pairingsCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
        return quotaJson({ ok: false, error: 'method_not_allowed' }, 405, cors);
    }

    const db = env.QUOTA_DB;
    if (!db) {
        console.error('QUOTA_DB binding missing — install routes need the D1 database.');
        return quotaJson({ ok: false, error: 'db_unavailable' }, 503, cors);
    }

    let body;
    try {
        body = await readJsonBounded(request, INSTALL_MAX_BODY_BYTES);
    } catch (e) {
        return quotaJson({ ok: false, error: e.message }, e.statusCode || 400, cors);
    }

    const deviceId = clampString(body.device_id, 64);
    if (!deviceId || !QUOTA_ID_RE.test(deviceId)) {
        return quotaJson({ ok: false, error: 'invalid_device_id' }, 400, cors);
    }

    const nowMs = Date.now();

    if (url.pathname === '/install/resolve') {
        return handleInstallResolve(env, db, cors, body, deviceId, nowMs);
    }
    if (url.pathname === '/install/registration') {
        return handleInstallRegistration(env, db, cors, deviceId, nowMs);
    }
    return quotaJson({ ok: false, error: 'not_found' }, 404, cors);
}

/**
 * POST /install/resolve { device_id, bcid?, platform?, app_version? }
 *   → { ok, action: 'activate' | 'gate' | 'none', arm, license_key?, tier? }
 *
 *   activate — the free key this device registered has arrived: activate it
 *              through /license/activate.
 *   gate     — test arm without a key: block editing until the user registers.
 *   none     — nothing to do: the device already holds a live key, or it is
 *              control / existing and stays on the keyless free tier.
 */
async function handleInstallResolve(env, db, cors, body, deviceId, nowMs) {
    const bcid = (() => {
        const v = clampString(body.bcid, 80);
        return v && BCID_RE.test(v) ? v : null;
    })();
    const platform   = clampString(body.platform, 32);
    const appVersion = clampString(body.app_version, 32);

    let res = await db.prepare(
        `SELECT arm FROM install_resolutions WHERE device_id = ?1`
    ).bind(deviceId).first();

    let assignedNow = false;
    if (!res) {
        const arm = await assignArm(env, db, deviceId);
        await db.prepare(
            `INSERT INTO install_resolutions
                (device_id, arm, bcid, platform, app_version, assigned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(device_id) DO NOTHING`
        ).bind(deviceId, arm, bcid, platform, appVersion, nowMs).run();
        res = await db.prepare(
            `SELECT arm FROM install_resolutions WHERE device_id = ?1`
        ).bind(deviceId).first();
        assignedNow = true;
    } else {
        await db.prepare(
            `UPDATE install_resolutions
                SET bcid = COALESCE(bcid, ?2),
                    platform = COALESCE(?3, platform),
                    app_version = COALESCE(?4, app_version)
              WHERE device_id = ?1`
        ).bind(deviceId, bcid, platform, appVersion).run();
    }

    const arm = res.arm;
    const reply = (action, extra = {}) => {
        console.log(JSON.stringify({ evt: 'install_resolve', arm, action, assigned_now: assignedNow }));
        return quotaJson({ ok: true, action, arm, assigned_now: assignedNow,
                           gate_enabled: gateEnabled(env), ...extra }, 200, cors);
    };

    const lic = await db.prepare(
        `SELECT tier, status, ends_at FROM license_activations WHERE device_id = ?1`
    ).bind(deviceId).first();
    const licenseLive = !!lic && lic.status === 'active'
        && (!Number(lic.ends_at) || Number(lic.ends_at) > nowMs);
    if (licenseLive) {
        return reply('none', { tier: lic.tier || 'pro' });
    }

    if (arm === 'test' && gateEnabled(env)) {
        const pending = await db.prepare(
            `SELECT pending_license_key FROM registrations
              WHERE device_id = ?1 AND pending_license_key IS NOT NULL AND completed_at IS NULL
              ORDER BY key_received_at DESC LIMIT 1`
        ).bind(deviceId).first();
        if (pending) {
            return reply('activate', { tier: 'free', license_key: pending.pending_license_key });
        }
        return reply('gate');
    }

    // control, existing, or test with the gate switched off: keyless free tier.
    return reply('none');
}

/**
 * POST /install/registration { device_id } → { ok, reg }
 *
 * Minted when the user clicks "Activate free plan". The app appends it to the
 * /get URL; /plans forwards it as checkout[custom][reg].
 */
async function handleInstallRegistration(env, db, cors, deviceId, nowMs) {
    const res = await db.prepare(
        `SELECT arm FROM install_resolutions WHERE device_id = ?1`
    ).bind(deviceId).first();
    if (!res) {
        return quotaJson({ ok: false, error: 'unresolved_device' }, 409, cors);
    }

    const reusable = await db.prepare(
        `SELECT reg FROM registrations
          WHERE device_id = ?1 AND completed_at IS NULL AND pending_license_key IS NULL
            AND created_at > ?2
          ORDER BY created_at DESC LIMIT 1`
    ).bind(deviceId, nowMs - REG_REUSE_WINDOW_MS).first();
    if (reusable) {
        return quotaJson({ ok: true, reg: reusable.reg, reused: true }, 200, cors);
    }

    const reg = randomToken('rg_');
    await db.prepare(
        `INSERT INTO registrations (reg, device_id, created_at) VALUES (?1, ?2, ?3)`
    ).bind(reg, deviceId, nowMs).run();

    console.log(JSON.stringify({ evt: 'install_registration', arm: res.arm }));
    return quotaJson({ ok: true, reg, reused: false }, 200, cors);
}

/**
 * Cloudflare Worker entry point
 */
export default {
    async fetch(request, env, ctx) {
        try {
            return await route(request, env, ctx);
        } catch (e) {
            // Without this, any thrown error becomes an opaque Cloudflare 1101
            // page: no log line, no error name, and a 500 that looks identical
            // to the endpoint being down. A stray `externalIdsHashed` typo in
            // the /capi success path hid behind exactly that for weeks —
            // events were reaching Meta, then the worker died while logging
            // them, so every client saw a total failure.
            console.log(JSON.stringify({
                evt: 'worker_unhandled_error',
                path: new URL(request.url).pathname,
                error: String((e && e.stack) || (e && e.message) || e),
            }));
            return new Response(JSON.stringify({ ok: false, error: 'internal_error' }), {
                status: 500,
                headers: { 'content-type': 'application/json; charset=utf-8' },
            });
        }
    }
};

async function route(request, env, ctx) {
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

    if (url.pathname === '/quota/state'
        || url.pathname === '/quota/claim'
        || url.pathname === '/quota/grant') {
        return handleQuota(request, env, url, ctx);
    }

    if (url.pathname === '/license/activate'
        || url.pathname === '/license/validate'
        || url.pathname === '/license/deactivate') {
        return handleLicense(request, env, url, ctx);
    }

    if (url.pathname === '/install/resolve' || url.pathname === '/install/registration') {
        return handleInstall(request, env, url);
    }

    if (url.pathname === '/capi') {
        return handleCapi(request, env, url);
    }

    if (url.pathname === '/gads') {
        return handleGads(request, env, url);
    }

    return new Response('Not found', { status: 404 });
}

// Exposed for the offline test harnesses (quota_selftest.mjs,
// entitlement_vectors.mjs) so the token format has one source of truth: the
// vectors the client is tested against are built by the same code that signs in
// production. Not part of the worker's HTTP surface.
export const __entitlement = {
    signEntitlement,
    entitlementBase,
    strToB64u,
    bytesToB64u,
    ENTITLEMENT_KEY_ID,
    ENTITLEMENT_TTL_MS,
};

