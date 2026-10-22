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
    var WORKER = 'https://peachsounds-webhook.sareldu.workers.dev';
    var STORAGE_KEY = 'cue_analytics_consent';   // shared with the cookie banner
    var CONSENT_DURATION_DAYS = 180;

    var REQUIRES_CONSENT = [
        'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
        'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
        'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH'
    ];

    // Where the cookie banner is shown and ad storage starts denied: Google's
    // regions plus places whose own law expects opt-in. Mirrors
    // BANNER_COUNTRIES / BANNER_REGIONS in webhook-worker/worker.js.
    var BANNER_REGIONS = REQUIRES_CONSENT.concat([
        'RS', 'ME', 'MK', 'AL', 'BA', 'XK', 'MD', 'UA', 'TR',
        'AD', 'MC', 'SM', 'VA', 'CA-QC'
    ]);

    // Global Privacy Control is a legally binding opt-out of ad sharing in
    // California and several other US states, so it overrides any stored
    // or clicked grant, everywhere.
    var gpc = navigator.globalPrivacyControl === true;

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }

    function signals(granted) {
        var v = granted ? 'granted' : 'denied';
        return { ad_storage: v, ad_user_data: v, ad_personalization: v };
    }

    /** 'granted' | 'denied' | null when the visitor hasn't answered the
     *  advertising question (or the answer expired). */
    function consent() {
        if (gpc) return 'denied';
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
        gtag('consent', 'update', signals(!!granted && !gpc));
    }

    // Region-scoped default wins over the global one inside those regions.
    var regional = signals(false);
    regional.region = BANNER_REGIONS;
    regional.wait_for_update = 500;
    gtag('consent', 'default', regional);
    gtag('consent', 'default', signals(!gpc));

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

    /** Browser → worker → Google Ads uploadClickConversions. `event_name`
     *  picks the conversion action on the worker; `value` and `currency` are
     *  the caller's, since every funnel step is worth something different
     *  (js/funnel-value.js holds the web ones). A conversion the Ads account
     *  has no action for soft-skips on the worker.
     *
     *  Returns a promise that resolves once the upload settles, so a caller
     *  that is about to navigate (the Store redirect on /download) can wait
     *  for it instead of guessing at a delay. It never rejects. */
    function conversion(opts) {
        try {
            return fetch(WORKER + '/gads', {
                method: 'POST',
                mode: 'cors',
                credentials: 'omit',
                keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event_name: opts.event_name,
                    transaction_id: opts.transaction_id,
                    event_source_url: window.location.href,
                    internal_name: opts.internal_name || null,
                    // The worker looks the visitor's hashed email up by this id
                    // for enhanced conversions. Fall back to the bcid: on
                    // /download the conversion fires before posthog's array
                    // stub has a distinct id to give, and the two are the same
                    // value anyway (the bcid bootstraps the distinct id).
                    distinct_id: ((window.posthog && posthog.get_distinct_id) ? posthog.get_distinct_id() : null)
                                 || window.__cue_bcid || null,
                    ad_consent: consent(),
                    value: opts.value,
                    currency: opts.currency || 'USD',
                    user_data: clickIds()
                })
            }).catch(function () {});
        } catch (e) { /* never block the click */ }
        return Promise.resolve();
    }

    /** Calls back with true when the visitor needs the cookie banner (one of
     *  BANNER_REGIONS, or anywhere we can't place them) and false otherwise.
     *  Asks the worker, which reads the country off the request; any failure
     *  or a slow answer means true, so the banner errs towards showing. */
    var GEO_URL = WORKER + '/geo';
    var GEO_CACHE_KEY = 'cue_consent_required';
    var GEO_TIMEOUT_MS = 1500;

    function consentRequired(callback) {
        var done = false;
        function finish(required) {
            if (done) return;
            done = true;
            callback(required);
        }

        try {
            var cached = sessionStorage.getItem(GEO_CACHE_KEY);
            if (cached === 'true' || cached === 'false') return finish(cached === 'true');
        } catch (e) {}

        setTimeout(function () { finish(true); }, GEO_TIMEOUT_MS);
        try {
            fetch(GEO_URL, { credentials: 'omit' })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    var required = !(j && j.consent_required === false);
                    try { sessionStorage.setItem(GEO_CACHE_KEY, String(required)); } catch (e) {}
                    finish(required);
                })
                .catch(function () { finish(true); });
        } catch (e) {
            finish(true);
        }
    }

    window.CueGoogleAds = {
        consent: consent,
        applyConsent: applyConsent,
        clickIds: clickIds,
        conversion: conversion,
        consentRequired: consentRequired
    };
})();
