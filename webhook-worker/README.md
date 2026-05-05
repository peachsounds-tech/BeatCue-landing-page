# BeatCue Webhook Worker

A single Cloudflare Worker with two responsibilities:

1. **Lemon Squeezy → PostHog**: receive purchase webhooks and forward funnel events to PostHog.
2. **Web ↔ desktop pairing**: bridge the `bcid` + Meta attribution captured on the download page over to the freshly installed desktop app — without tripping Chrome's Local Network Access permission prompt.

## Routes

| Method | Path | Used by | Purpose |
|---|---|---|---|
| `GET`  | `/health` | smoke tests | returns `OK` |
| `POST` | `/webhook/lemonsqueezy` | Lemon Squeezy | order/subscription/license webhooks |
| `POST` | `/pairings` | download page | store pending pairing payload (CORS-gated) |
| `POST` | `/pairings/claim` | desktop app | fetch and consume pending pairing |
| `OPTIONS` | `/pairings*` | browsers | CORS preflight |

## Lemon Squeezy events tracked

| Lemon Squeezy Event | PostHog Event | Description |
|---------------------|---------------|-------------|
| `order_created` | `checkout_completed` | User completed checkout |
| `license_key_created` | `license_key_created` | License key was generated |
| `subscription_created` | `subscription_created` | Subscription started |

## Pairing flow

```
1. User loads /download in browser
   → page mints bcid, captures _fbp / _fbc / fbclid

2. User clicks "Download" button
   → page POSTs /pairings { bcid, fbp, fbc, fbclid, utms }
   → worker stores it in KV under sha256(coarse_ip + os)[:24], TTL 15 min

3. User runs the installer

4. Desktop app first launch (no prior pairing recorded)
   → app POSTs /pairings/claim { os: "mac" | "win" }
   → worker rebuilds the same key from app's connecting IP + OS
   → on hit: returns the JSON payload + deletes the KV entry
   → app calls applyPairing() — aliases bcid into PostHog, persists Meta IDs

Failure modes:
- Different network between download and launch (VPN dropped) → 404, app stays anonymous
- Two BeatCue installs from same NAT in same 15-min window → second one wins,
  first user stays anonymous (acceptable — rare)
```

## Setup Instructions

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Login to Cloudflare

```bash
wrangler login
```

### 3. Create the pairing KV namespace

```bash
cd landing-page/webhook-worker

# Production namespace
wrangler kv namespace create PAIRINGS
# → outputs:  id = "abc123…"

# Preview namespace (used by `wrangler dev`)
wrangler kv namespace create PAIRINGS --preview
# → outputs:  preview_id = "def456…"
```

Paste both IDs into the `[[kv_namespaces]]` block in `wrangler.toml`. Skip this step if you only need the Lemon Squeezy webhook — the `/pairings` routes will return 503 until the binding exists.

### 4. Deploy the Worker

```bash
wrangler deploy
```

You'll get a URL like: `https://peachsounds-webhook.YOUR_SUBDOMAIN.workers.dev`

Bind a custom domain in the Cloudflare dashboard (e.g. `https://api.gocue.app`) and update `PAIRINGS_BASE` in `landing-page/download.html` and `Source/Identity/PairingClient.h` to point at it.

### 5. Set Webhook Secret (Optional but Recommended)

Get your webhook secret from Lemon Squeezy dashboard, then:

```bash
wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET
# Paste your secret when prompted
```

### 6. Configure Lemon Squeezy Webhook

1. Go to [Lemon Squeezy Dashboard](https://app.lemonsqueezy.com/settings/webhooks)
2. Click "Add Webhook"
3. Set the URL to: `https://peachsounds-webhook.YOUR_SUBDOMAIN.workers.dev/webhook/lemonsqueezy`
4. Select events:
   - ✅ `order_created`
   - ✅ `license_key_created`
   - ✅ `subscription_created` (if using subscriptions)
5. Copy the signing secret and set it via `wrangler secret put` (step 5)

### 7. Test

Health check:

```bash
curl https://peachsounds-webhook.YOUR_SUBDOMAIN.workers.dev/health
# → OK
```

Smoke-test the pairing routes end to end:

```bash
WORKER=https://peachsounds-webhook.YOUR_SUBDOMAIN.workers.dev

# 1. Page POSTs an attribution payload
curl -i -X POST "$WORKER/pairings" \
    -H 'content-type: application/json' \
    -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2)' \
    -d '{"bcid":"bc_smoke12345678","fbp":"fb.1.0.x","fbc":"fb.1.0.y","fbclid":"IwTEST"}'
# → 200 {"ok":true}

# 2. App claims it (must come from same IP, same OS family)
curl -i -X POST "$WORKER/pairings/claim" \
    -H 'content-type: application/json' \
    -A 'BeatCue/1.0' \
    -d '{"os":"mac"}'
# → 200 {"bcid":"bc_smoke12345678", …}

# 3. Re-claim should now miss (single-shot)
curl -i -X POST "$WORKER/pairings/claim" \
    -H 'content-type: application/json' \
    -d '{"os":"mac"}'
# → 404 {"ok":false,"error":"no_pending_pairing"}
```

## Funnel Flow

```
Landing Page                 Lemon Squeezy              Cloudflare Worker         PostHog
────────────────────────────────────────────────────────────────────────────────────────────
1. landing_page_viewed ─────────────────────────────────────────────────────────► Event
   (uuid: abc-123)

2. application_submitted ───────────────────────────────────────────────────────► Event
   (uuid → alias → hash-email)

3. Redirect to checkout ───► Checkout page
   (passes hashed_email,     (custom data stored)
    uuid in URL)

4. User completes checkout ─► order_created webhook ──► checkout_completed ────► Event
                              (includes custom data)    (distinct_id: hash-email)

5. License key generated ───► license_key_created ────► license_key_created ───► Event
                              webhook                   (distinct_id: hash-email)
```

## Debugging

View worker logs:

```bash
wrangler tail
```

Check PostHog for events with `$lib: cloudflare-worker` property.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `LEMONSQUEEZY_WEBHOOK_SECRET` | Webhook signing secret | Recommended |

## Local Development

```bash
wrangler dev
```

Then use ngrok or similar to expose locally for webhook testing.

