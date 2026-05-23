/**
 * Microsoft Store campaign links (Partner Center cid tracking).
 * Derives the cid from Meta ad UTMs (utm_campaign) captured on the page.
 */
(function (global) {
    var MS_STORE_BASE = 'https://apps.microsoft.com/detail/9nrc99fw338g';

    function sanitizeCampaignId(raw) {
        if (!raw || typeof raw !== 'string') return null;
        var s = raw.trim().toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '');
        if (!s) return null;
        return s.slice(0, 100);
    }

    /**
     * Meta campaign id for Store ?cid= — primarily utm_campaign from ad links.
     * @param {function(): object} getUtmProps page-specific UTM reader
     */
    function getMetaCampaignCid(getUtmProps) {
        try {
            var params = new URLSearchParams(global.location.search);
            var explicit = params.get('metacampaign') || params.get('meta_campaign');
            if (explicit) return sanitizeCampaignId(explicit);

            var utms = typeof getUtmProps === 'function' ? getUtmProps() : {};
            if (utms.utm_campaign) return sanitizeCampaignId(utms.utm_campaign);
            return null;
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
        sanitizeCampaignId: sanitizeCampaignId,
        getMetaCampaignCid: getMetaCampaignCid,
        buildMicrosoftStoreUrl: buildMicrosoftStoreUrl
    };
})(typeof window !== 'undefined' ? window : globalThis);
