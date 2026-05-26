/**
 * Microsoft Store campaign links (Partner Center cid tracking + per-user
 * bcid handoff).
 *
 * The Microsoft Store strips every URL query param except `cid`, but it then
 * (a) surfaces that value in Microsoft Partner Center → Acquisitions as the
 * "Campaign ID" column, and (b) preserves it per Microsoft-account so the
 * installed app can read it back via the WinRT
 * `CurrentApp::GetAppPurchaseCampaignIdAsync()` API. We exploit both at once
 * by encoding TWO things in the cid:
 *
 *     cid = c_<campaign_short>__u_<bcid>
 *
 * — `c_…` is a short, stable campaign label so Partner Center rollups don't
 *   shatter into one-row-per-user. Derived from utm_campaign (or utm_source,
 *   or an explicit ?metacampaign= override).
 * — `u_…` is the page-minted bcid. The desktop app parses this on first
 *   launch and uses it directly to claim the (fbp/fbc/fbclid/utms) attribution
 *   payload from the worker, bypassing the IP-coarsened loopback entirely.
 *   That's the whole point: the cid channel is network-agnostic, survives
 *   deferred installs, and doesn't NAT-collide. The loopback claim remains
 *   only as a fallback when cid comes back empty (sporadic Win11 cases,
 *   non-Store sideloads, missing MS-account association).
 *
 * Either component may be missing — the assembled cid silently omits it. The
 * whole string is clamped to 100 chars; the bcid is treated as fixed-length
 * (`bc_` + UUID = 39 chars), so we cap `c_…` first to fit. A bcid that exceeds
 * the BCID_RE shape is dropped rather than truncated, because a truncated
 * bcid is worse than no bcid — it would fail the worker's validator and
 * fingerprint nothing.
 */
(function (global) {
    var MS_STORE_BASE = 'https://apps.microsoft.com/detail/9nrc99fw338g';
    var MAX_CID_LENGTH = 100;
    var CID_SEPARATOR = '__';

    // Must mirror BCID_RE on the worker + desktop side. Single source of
    // truth lives there; this is a defensive copy so the page never ships
    // a malformed bcid into the Microsoft Store URL.
    var BCID_RE = /^bc_[A-Za-z0-9-]{8,64}$/;

    // Cap the campaign component on its own so a runaway utm_campaign can't
    // monopolize the 100-char budget and push the bcid out. With the bcid
    // worst-case at ~67 chars (`bc_` + 64), plus 2× `c_`/`u_` prefixes and
    // the `__` separator, we want campaign ≤ ~25 chars to keep headroom.
    // In practice 40 is plenty for things like "fb_xmas25".
    var MAX_CAMPAIGN_LENGTH = 40;

    /**
     * Normalize one UTM-ish value into a single Partner-Center-safe token.
     * Collapses runs of underscores so the literal "__" separator is only
     * ever introduced when we join components ourselves.
     */
    function sanitizeComponent(raw) {
        if (!raw || typeof raw !== 'string') return null;
        var s = raw.trim().toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^[_-]+|[_-]+$/g, '');
        return s || null;
    }

    /**
     * Back-compat alias: older call sites used this for a single value. It
     * applies the per-component sanitizer plus the global 100-char clamp.
     */
    function sanitizeCampaignId(raw) {
        var s = sanitizeComponent(raw);
        return s ? s.slice(0, MAX_CID_LENGTH) : null;
    }

    /** Validate + lowercase the bcid. Returns null on anything malformed so
     *  the caller can quietly drop the `u_` segment instead of poisoning the
     *  cid with garbage the desktop side will reject. */
    function sanitizeBcid(raw) {
        if (typeof raw !== 'string') return null;
        var trimmed = raw.trim();
        if (!trimmed || !BCID_RE.test(trimmed)) return null;
        // Lowercase keeps round-trip exact with the worker (Cloudflare
        // crypto helpers and the desktop validator are case-sensitive only
        // for the `bc_` prefix; the suffix is canonical-lowercase UUIDs).
        return trimmed.toLowerCase();
    }

    /** Pick the most meaningful campaign label out of the available UTMs.
     *  Prefer utm_campaign (the most marketing-actionable column in Partner
     *  Center), fall back to utm_source so a bare `?utm_source=newsletter`
     *  link still produces a rollup bucket. */
    function deriveCampaignShort(utms) {
        if (!utms || typeof utms !== 'object') return null;
        var candidate = utms.utm_campaign || utms.utm_source;
        var s = sanitizeComponent(candidate);
        if (!s) return null;
        return s.slice(0, MAX_CAMPAIGN_LENGTH);
    }

    /**
     * Build the Partner Center cid from the page's UTM context + (optional)
     * bcid. Returns null when there's nothing meaningful to attribute.
     *
     * @param {function(): object} getUtmProps page-specific UTM reader
     * @param {string=} bcid current page-minted bcid (window.__cue_bcid)
     */
    function getMetaCampaignCid(getUtmProps, bcid) {
        try {
            var params = new URLSearchParams(global.location.search);

            // Explicit override (?metacampaign=…) bypasses utm composition
            // entirely and is treated as the campaign label verbatim. Useful
            // for manual / non-Meta links where the marketer wants a single
            // pre-agreed bucket name.
            var explicit = params.get('metacampaign') || params.get('meta_campaign');

            var utms = typeof getUtmProps === 'function' ? getUtmProps() : {};
            var campaignShort = explicit
                ? (sanitizeComponent(explicit) || '').slice(0, MAX_CAMPAIGN_LENGTH) || null
                : deriveCampaignShort(utms);

            var safeBcid = sanitizeBcid(bcid);

            if (!campaignShort && !safeBcid) return null;

            var parts = [];
            if (campaignShort) parts.push('c_' + campaignShort);
            if (safeBcid)      parts.push('u_' + safeBcid);

            var joined = parts.join(CID_SEPARATOR);
            if (joined.length <= MAX_CID_LENGTH) return joined;

            // Over budget — only the campaign is variable-length, so shrink
            // it from the tail. Never touch the bcid: a truncated bcid
            // fingerprints nothing on the worker side.
            if (campaignShort && safeBcid) {
                var fixedTail = CID_SEPARATOR + 'u_' + safeBcid;
                var room = MAX_CID_LENGTH - fixedTail.length - 'c_'.length;
                if (room >= 4) {
                    var trimmed = campaignShort.slice(0, room).replace(/[_-]+$/, '');
                    if (trimmed) return 'c_' + trimmed + fixedTail;
                }
                return 'u_' + safeBcid;
            }
            return joined.slice(0, MAX_CID_LENGTH);
        } catch (e) {
            return null;
        }
    }

    /**
     * Build the full Microsoft Store URL with the composed cid. Passing
     * `bcid` is encouraged for any /download flow — it's what makes the
     * desktop-side claim deterministic. Omit it only for non-acquisition
     * links (press / docs / FAQ).
     *
     * @param {function(): object} getUtmProps page-specific UTM reader
     * @param {string=} bcid current page-minted bcid
     */
    function buildMicrosoftStoreUrl(getUtmProps, bcid) {
        var url = new URL(MS_STORE_BASE);
        var cid = getMetaCampaignCid(getUtmProps, bcid);
        if (cid) url.searchParams.set('cid', cid);
        return url.toString();
    }

    /**
     * Inverse of getMetaCampaignCid. Exposed mainly so tests / the desktop
     * WinRT shim's mock can validate the round-trip without re-deriving the
     * parser by hand. Returns { campaign, bcid } with either field set to
     * null when missing. Malformed bcids are surfaced as `null` (not the
     * raw string) so the caller never gets a value it has to re-validate.
     */
    function parseCid(cid) {
        var out = { campaign: null, bcid: null };
        if (!cid || typeof cid !== 'string') return out;
        var parts = cid.split(CID_SEPARATOR);
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (p.indexOf('c_') === 0) {
                out.campaign = p.slice(2) || null;
            } else if (p.indexOf('u_') === 0) {
                out.bcid = sanitizeBcid(p.slice(2));
            }
        }
        return out;
    }

    global.CueMicrosoftStore = {
        MS_STORE_BASE: MS_STORE_BASE,
        MAX_CID_LENGTH: MAX_CID_LENGTH,
        MAX_CAMPAIGN_LENGTH: MAX_CAMPAIGN_LENGTH,
        CID_SEPARATOR: CID_SEPARATOR,
        BCID_RE: BCID_RE,
        sanitizeCampaignId: sanitizeCampaignId,
        sanitizeComponent: sanitizeComponent,
        sanitizeBcid: sanitizeBcid,
        deriveCampaignShort: deriveCampaignShort,
        getMetaCampaignCid: getMetaCampaignCid,
        buildMicrosoftStoreUrl: buildMicrosoftStoreUrl,
        parseCid: parseCid
    };
})(typeof window !== 'undefined' ? window : globalThis);
