// Google Ads consent and click ids, shared by every page that loads gtag.
//
// Must be included synchronously before the page's gtag('config') call:
// Consent Mode only applies to hits queued after its 'default' command.
//
// Google only counts a conversion from the EEA, the UK or Switzerland when the
// visitor granted advertising consent, and that applies to conversions we
// upload server-side as much as to the tag. So the same choice is exposed to
// page code (`CueGoogleAds.consent()`), which forwards it to /gads and
// /pairings and on into the desktop app.
(function () {
    var STORAGE_KEY = 'cue_analytics_consent';   // shared with the cookie banner
    var CONSENT_DURATION_DAYS = 180;

    var REQUIRES_CONSENT = [
        'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
        'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
        'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH'
    ];

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }

    function signals(granted) {
        var v = granted ? 'granted' : 'denied';
        return { ad_storage: v, ad_user_data: v, ad_personalization: v };
    }

    /** 'granted' | 'denied' | null when the visitor hasn't answered the
     *  advertising question (or the answer expired). */
    function consent() {
        try {
            var c = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (!c || typeof c.ads !== 'boolean' || !c.timestamp) return null;
            if ((Date.now() - c.timestamp) / 86400000 > CONSENT_DURATION_DAYS) return null;
            return c.ads ? 'granted' : 'denied';
        } catch (e) {
            return null;
        }
    }

    function applyConsent(granted) {
        gtag('consent', 'update', signals(!!granted));
    }

    // Region-scoped default wins over the global one inside those regions.
    var regional = signals(false);
    regional.region = REQUIRES_CONSENT;
    regional.wait_for_update = 500;
    gtag('consent', 'default', regional);
    gtag('consent', 'default', signals(true));

    var stored = consent();
    if (stored) applyConsent(stored === 'granted');

    /** gclid / gbraid / wbraid from the URL (current or first-landed), falling
     *  back to the cookies gtag writes once ad_storage is granted. */
    function clickIds() {
        var out = {};
        var sources = [window.location.search];
        if (window.__cue_initial_url) {
            try { sources.push(new URL(window.__cue_initial_url).search); } catch (e) {}
        }
        function fromCookie(name) {
            try {
                var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
                if (!m) return null;
                var parts = decodeURIComponent(m[1]).split('.');
                return parts.length >= 3 ? parts.slice(2).join('.') : null;
            } catch (e) { return null; }
        }
        var cookieFallback = {
            gclid:  fromCookie('_gcl_aw'),
            gbraid: fromCookie('_gcl_gb'),
            wbraid: fromCookie('_gcl_gb')
        };
        ['gclid', 'gbraid', 'wbraid'].forEach(function (key) {
            var val = null;
            for (var i = 0; i < sources.length && !val; i++) {
                try { val = new URLSearchParams(sources[i]).get(key); } catch (e) {}
            }
            if (!val) val = cookieFallback[key];
            if (val) out[key] = val;
        });
        return out;
    }

    window.CueGoogleAds = {
        consent: consent,
        applyConsent: applyConsent,
        clickIds: clickIds
    };
})();
