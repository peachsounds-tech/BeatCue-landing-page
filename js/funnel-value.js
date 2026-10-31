/**
 * funnel_value from the web.
 *
 * Value-optimized campaigns bid on one conversion, `funnel_value`, which every
 * valued step of the funnel sends with that step's share of the $20 activation:
 * the desktop app sends its steps (see ConversionCatalog in the BeatCue repo),
 * and this sends the ones that happen on the site: the download, from
 * download.html, and the mobile hand-off, from the pages that offer it.
 *
 * A step is worth $20 × the share of visitors who reached a paid activation
 * after it (PostHog, 2026-06-01 → 2026-10-20; Israel excluded, the team's own):
 *
 *   send_to_computer   1 / 38 downloaded      $0.01
 *     (the mobile hand-off. Worth 2.6% of a download — $0.002 — so floored to
 *      the smallest value either platform reports. Kept below the download on
 *      purpose: a third of senders open the link on Linux or a Chromebook,
 *      where the app can't run.)
 *   download_started   5 / 1097  0.46%   $0.09
 *     (joined to the app by bcid; the hand-off link carries it, so a visitor
 *      who sent the link to themselves earns this too when they download on
 *      the desktop.)
 *
 * Once per person and step: the event id is derived from the bcid, so a second
 * click, a second tab, or the same person arriving on the desktop through the
 * hand-off link dedupes into the first conversion on both platforms. The
 * Pixel half carries the same id, so Meta keeps one of the two.
 *
 * No email is sent from here: the worker finds it by bcid when the visitor
 * gave one in the hand-off form, and attaches it if their ad consent allows.
 *
 * Each send is also captured in PostHog as `funnel_value_sent`, with the click
 * ids and cookies the ad platforms received (the touch's UTMs come along as
 * super properties, see attribution.js), so a conversion the platforms didn't
 * credit can be checked against what was sent.
 */
(function () {
    var WORKER = 'https://peachsounds-webhook.sareldu.workers.dev';

    var STEP_VALUES = {
        send_to_computer: 0.01,
        download_started: 0.09
    };

    function cookie(name) {
        var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
    }

    function post(path, body) {
        try {
            return fetch(WORKER + path, {
                method: 'POST',
                mode: 'cors',
                credentials: 'omit',
                keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).catch(function () {});
        } catch (e) { /* never block the click */ }
        return Promise.resolve();
    }

    /** Returns a promise that resolves once both uploads settle — /download
     *  waits on it before leaving for the Microsoft Store. Never rejects. */
    function send(step) {
        var value = STEP_VALUES[step];
        var bcid = window.__cue_bcid;
        if (!value || !bcid) return Promise.resolve();

        var onceKey = 'cue_funnel_value_once_' + step;
        try {
            if (localStorage.getItem(onceKey) === '1') return Promise.resolve();
            localStorage.setItem(onceKey, '1');
        } catch (e) {}

        var eventId = 'fv_' + bcid + '_' + step;
        var url = window.location.href;
        var fbp = cookie('_fbp') || window.__cue_fbp || null;
        var fbc = cookie('_fbc') || window.__cue_fbc || null;
        var fbclid = window.__cue_fbclid || null;
        var g = window.CueGoogleAds ? window.CueGoogleAds.clickIds() : {};

        if (window.posthog && typeof window.posthog.capture === 'function') {
            var funnelProps = {
                funnel_step: step,
                value: value,
                currency: 'USD',
                event_id: eventId,
                bcid: bcid,
                fbclid: fbclid,
                fbp: fbp,
                fbc: fbc,
                gclid: g.gclid || null,
                gbraid: g.gbraid || null,
                wbraid: g.wbraid || null
            };
            if (window.CUE_PAGE) funnelProps.page = window.CUE_PAGE;
            if (window.CUE_PAGE_VERSION) funnelProps.page_version = window.CUE_PAGE_VERSION;
            if (window.CuePage && CuePage.cta()) funnelProps.cta = CuePage.cta();
            // One event per person per step, so batching buys nothing and
            // costs the event when the page navigates straight after (the
            // Store redirect on /download).
            window.posthog.capture('funnel_value_sent', funnelProps, { send_instantly: true });
        }

        if (typeof fbq === 'function') {
            fbq('trackCustom', 'funnel_value',
                { value: value, currency: 'USD', funnel_step: step },
                { eventID: eventId });
        }

        var capi = post('/capi', {
            event_name: 'funnel_value',
            event_id: eventId,
            event_source_url: url,
            action_source: 'website',
            internal_name: step,
            ad_consent: window.CueGoogleAds ? window.CueGoogleAds.consent() : null,
            user_data: {
                fbp: fbp,
                fbc: fbc,
                fbclid: fbclid,
                external_id: bcid
            },
            custom_data: { value: value, currency: 'USD', funnel_step: step }
        });

        var gads = post('/gads', {
            event_name: 'funnel_value',
            transaction_id: eventId,
            event_source_url: url,
            internal_name: step,
            distinct_id: bcid,
            ad_consent: window.CueGoogleAds ? window.CueGoogleAds.consent() : null,
            value: value,
            currency: 'USD',
            user_data: {
                gclid: g.gclid || null,
                gbraid: g.gbraid || null,
                wbraid: g.wbraid || null
            }
        });

        return Promise.all([capi, gads]);
    }

    /** What a step is worth, for the step's own conversion action: Google
     *  gets both this and funnel_value, and they must agree. */
    function valueFor(step) {
        return STEP_VALUES[step] || 0;
    }

    window.CueFunnelValue = { send: send, valueFor: valueFor };
})();
