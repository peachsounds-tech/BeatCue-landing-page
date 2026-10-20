/**
 * funnel_value from the web.
 *
 * Value-optimized campaigns bid on one conversion, `funnel_value`, which every
 * valued step of the funnel sends with that step's share of the $20 activation:
 * the desktop app sends its steps (see ConversionCatalog in the BeatCue repo),
 * and this sends the ones that happen on the site. Loaded by download.html
 * only, the page every download flow is meant to pass through.
 *
 * A step is worth $20 × the share of visitors who reached a paid activation
 * after it (PostHog, 2026-06-01 → 2026-10-20; Israel excluded, the team's own):
 *
 *   download_started   5 / 1097  0.46%   $0.09
 *     (joined to the app by bcid; the mobile hand-off link carries it, so a
 *      visitor who sent the link to themselves counts when they download on
 *      the desktop, not when they tapped "send".)
 *
 * Once per person and step: the event id is derived from the bcid, so a second
 * click, a second tab, or the same person arriving on the desktop through the
 * hand-off link dedupes into the first conversion on both platforms. The
 * Pixel half carries the same id, so Meta keeps one of the two.
 */
(function () {
    var WORKER = 'https://peachsounds-webhook.sareldu.workers.dev';

    var STEP_VALUES = {
        download_started: 0.09
    };

    function cookie(name) {
        var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
    }

    function post(path, body) {
        try {
            fetch(WORKER + path, {
                method: 'POST',
                mode: 'cors',
                credentials: 'omit',
                keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).catch(function () {});
        } catch (e) { /* never block the click */ }
    }

    function send(step) {
        var value = STEP_VALUES[step];
        var bcid = window.__cue_bcid;
        if (!value || !bcid) return;

        var onceKey = 'cue_funnel_value_once_' + step;
        try {
            if (localStorage.getItem(onceKey) === '1') return;
            localStorage.setItem(onceKey, '1');
        } catch (e) {}

        var eventId = 'fv_' + bcid + '_' + step;
        var url = window.location.href;

        if (typeof fbq === 'function') {
            fbq('trackCustom', 'funnel_value',
                { value: value, currency: 'USD', funnel_step: step },
                { eventID: eventId });
        }

        post('/capi', {
            event_name: 'funnel_value',
            event_id: eventId,
            event_source_url: url,
            action_source: 'website',
            internal_name: step,
            user_data: {
                fbp: cookie('_fbp') || window.__cue_fbp || null,
                fbc: cookie('_fbc') || window.__cue_fbc || null,
                fbclid: window.__cue_fbclid || null,
                external_id: bcid
            },
            custom_data: { value: value, currency: 'USD', funnel_step: step }
        });

        var g = window.CueGoogleAds ? window.CueGoogleAds.clickIds() : {};
        post('/gads', {
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
    }

    window.CueFunnelValue = { send: send };
})();
