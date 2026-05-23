/**
 * Microsoft Store campaign links (Partner Center cid tracking).
 *
 * The Microsoft Store strips all query params except `cid`, which surfaces in
 * Microsoft Partner Center → Acquisitions as the "Campaign ID" column. We pack
 * three UTM fields into that single column so we can break installs down by
 * source, campaign, and ad creative directly in Microsoft's dashboard:
 *
 *     cid = <utm_source>__<utm_campaign>__<utm_content>
 *
 * Each component is independently sanitized (lowercased, non-alphanumeric runs
 * collapsed to a single underscore, leading/trailing underscores stripped) so
 * the literal "__" sequence is reserved as the component separator. Missing
 * components are skipped — a hit with only utm_campaign produces just
 * "<campaign>", a hit with utm_source + utm_campaign produces
 * "<source>__<campaign>".
 *
 * The total cid is clamped to 100 chars. When the budget is exceeded we
 * truncate from the right (utm_content first), because earlier components are
 * coarser groupings and matter more for clean rollups in Partner Center.
 *
 * An explicit override (?metacampaign=… or ?meta_campaign=… on the page URL)
 * bypasses the UTM composition and is treated as a single opaque value. Useful
 * for manual / non-Meta links.
 */
(function (global) {
    var MS_STORE_BASE = 'https://apps.microsoft.com/detail/9nrc99fw338g';
    var MAX_CID_LENGTH = 100;
    var CID_SEPARATOR = '__';

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

    /**
     * Join already-sanitized components with the canonical separator while
     * staying within the cid length budget. Truncates from the tail so the
     * coarser groupings (source, campaign) survive.
     */
    function joinComponents(components) {
        var parts = [];
        for (var i = 0; i < components.length; i++) {
            var p = sanitizeComponent(components[i]);
            if (p) parts.push(p);
        }
        if (parts.length === 0) return null;

        var joined = parts.join(CID_SEPARATOR);
        if (joined.length <= MAX_CID_LENGTH) return joined;

        // Over budget: shrink (then drop) the last component until we fit.
        while (parts.length > 0) {
            var head = parts.slice(0, parts.length - 1).join(CID_SEPARATOR);
            var prefixLen = head.length + (head.length ? CID_SEPARATOR.length : 0);
            var room = MAX_CID_LENGTH - prefixLen;
            if (room >= 4) {
                var trimmed = parts[parts.length - 1].slice(0, room).replace(/[_-]+$/, '');
                if (trimmed) {
                    parts[parts.length - 1] = trimmed;
                    return parts.join(CID_SEPARATOR);
                }
            }
            // Not enough room to keep the last component meaningfully — drop it.
            parts.pop();
            if (parts.length === 0) return null;
            if (parts.join(CID_SEPARATOR).length <= MAX_CID_LENGTH) {
                return parts.join(CID_SEPARATOR);
            }
        }
        return null;
    }

    /**
     * Build the Partner Center cid from the page's UTM context.
     * @param {function(): object} getUtmProps page-specific UTM reader
     */
    function getMetaCampaignCid(getUtmProps) {
        try {
            var params = new URLSearchParams(global.location.search);
            var explicit = params.get('metacampaign') || params.get('meta_campaign');
            if (explicit) return sanitizeCampaignId(explicit);

            var utms = typeof getUtmProps === 'function' ? getUtmProps() : {};
            return joinComponents([
                utms.utm_source,
                utms.utm_campaign,
                utms.utm_content
            ]);
        } catch (e) {
            return null;
        }
    }

    function buildMicrosoftStoreUrl(getUtmProps) {
        var url = new URL(MS_STORE_BASE);
        var cid = getMetaCampaignCid(getUtmProps);
        if (cid) url.searchParams.set('cid', cid);
        return url.toString();
    }

    global.CueMicrosoftStore = {
        MS_STORE_BASE: MS_STORE_BASE,
        MAX_CID_LENGTH: MAX_CID_LENGTH,
        CID_SEPARATOR: CID_SEPARATOR,
        sanitizeCampaignId: sanitizeCampaignId,
        sanitizeComponent: sanitizeComponent,
        joinComponents: joinComponents,
        getMetaCampaignCid: getMetaCampaignCid,
        buildMicrosoftStoreUrl: buildMicrosoftStoreUrl
    };
})(typeof window !== 'undefined' ? window : globalThis);
