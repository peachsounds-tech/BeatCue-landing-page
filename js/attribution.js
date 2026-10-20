/**
 * The visitor's latest ad touch, on every PostHog event.
 *
 * Call `CueAttribution.attach(posthog, { personProfiles })` right after
 * `posthog.init` (and again after a consent upgrade). It registers the touch as
 * super properties, so every event the page captures carries it without each
 * call site having to remember:
 *
 *   last_touch_fbclid, last_touch_gclid, last_touch_gbraid, last_touch_wbraid,
 *   last_touch_utm_source … last_touch_utm_term, last_touch_at
 *
 * A touch is the ad parameters a page was opened with. The latest one wins —
 * a new ad click replaces the old, an organic visit keeps it — which is how
 * Meta and Google credit conversions. It is kept for 90 days, Google's click
 * window; across visits only with consent (sessionStorage until then).
 *
 * With a person profile (`personProfiles: true`, i.e. after consent) the same
 * values are also set on the person, plus `first_touch_*` set once, so cohorts
 * and breakdowns can use them. Without one nothing is set: setting a person
 * property would create the profile the visitor hasn't agreed to.
 *
 * Event properties, not person properties, are what reports should rely on:
 * a visitor without consent has no profile, and the desktop app's events
 * belong to a different person. The bcid (the PostHog distinct id here) is
 * what joins the site to the app.
 */
(function () {
    var KEYS = ['fbclid', 'gclid', 'gbraid', 'wbraid',
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var STORAGE_KEY = 'cue_last_ad_touch';
    var MAX_AGE_MS = 90 * 24 * 3600 * 1000;

    function fromUrl() {
        var sources = [window.location.search];
        if (window.__cue_initial_url) {
            try { sources.push(new URL(window.__cue_initial_url).search); } catch (e) {}
        }
        var ids = {};
        KEYS.forEach(function (key) {
            for (var i = 0; i < sources.length && !ids[key]; i++) {
                try {
                    var v = new URLSearchParams(sources[i]).get(key);
                    if (v) ids[key] = v.slice(0, 512);
                } catch (e) {}
            }
        });
        return ids;
    }

    function read(storage) {
        try {
            var t = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
            if (t && t.ids && typeof t.at === 'number' && Date.now() - t.at < MAX_AGE_MS) return t;
        } catch (e) {}
        return null;
    }

    function write(touch, persistent) {
        var json = JSON.stringify(touch);
        try { sessionStorage.setItem(STORAGE_KEY, json); } catch (e) {}
        if (persistent) {
            try { localStorage.setItem(STORAGE_KEY, json); } catch (e) {}
        }
    }

    /** The latest touch, or null when the visitor never arrived from one. */
    function current(persistent) {
        var ids = fromUrl();
        if (Object.keys(ids).length) {
            var fresh = { ids: ids, at: Date.now() };
            write(fresh, persistent);
            return fresh;
        }
        var stored = (persistent && read(localStorage)) || read(sessionStorage);
        if (stored && persistent) write(stored, true);
        return stored;
    }

    /** With `withNulls`, absent keys are null, so $set_once claims every first_touch_* key in one go. */
    function prefixed(touch, prefix, withNulls) {
        var props = {};
        KEYS.forEach(function (key) {
            if (touch.ids[key]) props[prefix + key] = touch.ids[key];
            else if (withNulls) props[prefix + key] = null;
        });
        props[prefix + 'at'] = new Date(touch.at).toISOString();
        return props;
    }

    function attach(posthog, opts) {
        try {
            if (!posthog || typeof posthog.register !== 'function') return;
            var personProfiles = !!(opts && opts.personProfiles);
            var touch = current(personProfiles);
            if (!touch) return;

            var last = prefixed(touch, 'last_touch_');
            if (typeof posthog.unregister === 'function') {
                KEYS.forEach(function (key) {
                    if (!touch.ids[key]) posthog.unregister('last_touch_' + key);
                });
            }
            posthog.register(last);

            if (personProfiles && typeof posthog.setPersonProperties === 'function') {
                posthog.setPersonProperties(prefixed(touch, 'last_touch_', true),
                                            prefixed(touch, 'first_touch_', true));
            }
        } catch (e) { /* analytics must never break the page */ }
    }

    window.CueAttribution = { attach: attach, current: current };
})();
