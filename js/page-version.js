// Landing-page identity for analytics.
//
// page_version is taken from the last landing page this browser opened and
// saved locally. Download, plans, and the other sublinks reuse that saved
// version, so leaving /v6 for /download stays on 6.0.0, and opening /v5
// afterwards moves the following sublinks to 5.1.0. A ?pv= on a sublink is
// only used when this browser has not opened a landing yet (an emailed link
// on a new device).
//
// page is the surface: landing, download, plans, and so on. The version
// stays in page_version.
//
// cta is the button that sent the visitor onward (hero, pricing, …). The
// click saves it and the next page reads it back.
(function () {
    var VERSION_KEY = 'cue_page_version';
    var CTA_KEY = 'cue_cta';

    function storageGet(store, key) {
        try { return store.getItem(key) || ''; } catch (e) { return ''; }
    }
    function storageSet(store, key, value) {
        try { store.setItem(key, value); } catch (e) {}
    }

    function normalizePath(p) {
        p = p || '/';
        p = p.replace(/\/index\.html$/i, '/').replace(/\.html$/i, '');
        if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
        return p || '/';
    }

    // null means this URL is a sublink and must reuse the landing version.
    // /v2 is the no-creator page (the former 2.0.8 side of the creator test).
    function versionForLanding(p) {
        if (p === '/v6') return '6.0.0';
        if (p === '/v5') return '5.1.0';
        if (p === '/v4') return '4.0.1';
        if (p === '/v2') return '2.0.8';
        if (p === '/v3') return '3.0.0';
        if (p === '/') return '1.3.0';
        return null;
    }

    function pageName(p) {
        if (versionForLanding(p) !== null) return 'landing';
        var seg = p.replace(/^\//, '').split('/')[0];
        return seg || 'landing';
    }

    function validVersion(value) {
        return /^[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(value || '');
    }
    function validCta(value) {
        return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(value || '');
    }

    var path = normalizePath((typeof location !== 'undefined' && location.pathname) || '/');
    var landingVersion = versionForLanding(path);
    var params;
    try {
        params = new URLSearchParams(location.search);
    } catch (e) {
        params = { get: function () { return ''; } };
    }

    var version;
    if (landingVersion) {
        version = landingVersion;
        storageSet(sessionStorage, VERSION_KEY, version);
        storageSet(localStorage, VERSION_KEY, version);
    } else {
        // localStorage is rewritten on every landing, including other tabs,
        // so it is the last landing. A version stamped on the link cannot
        // replace it.
        var stored = storageGet(localStorage, VERSION_KEY)
            || storageGet(sessionStorage, VERSION_KEY);
        if (validVersion(stored)) {
            version = stored;
        } else {
            var fromLink = params.get('pv') || '';
            if (validVersion(fromLink)) {
                version = fromLink;
                storageSet(sessionStorage, VERSION_KEY, version);
                storageSet(localStorage, VERSION_KEY, version);
            } else {
                version = '2.0.6';
            }
        }
    }

    var fromCta = params.get('cta') || '';
    if (validCta(fromCta)) {
        storageSet(sessionStorage, CTA_KEY, fromCta);
        storageSet(localStorage, CTA_KEY, fromCta);
    }

    function currentCta() {
        var sessionCta = storageGet(sessionStorage, CTA_KEY);
        if (validCta(sessionCta)) return sessionCta;
        var storedCta = storageGet(localStorage, CTA_KEY);
        return validCta(storedCta) ? storedCta : '';
    }

    var isLanding = landingVersion !== null;

    window.CUE_PAGE_VERSION = version;
    window.CUE_PAGE = pageName(path);

    window.CuePage = {
        rememberCta: function (name) {
            if (!validCta(name)) return;
            storageSet(sessionStorage, CTA_KEY, name);
            storageSet(localStorage, CTA_KEY, name);
        },
        cta: currentCta,
        // Super properties for posthog.register. The landing page itself
        // does not inherit a CTA from an earlier visit; the click sets it.
        superProps: function () {
            var props = {
                page_version: window.CUE_PAGE_VERSION,
                page: window.CUE_PAGE
            };
            if (!isLanding) {
                var cta = currentCta();
                if (cta) props.cta = cta;
            }
            return props;
        },
        stamp: function (url) {
            if (!url || !url.searchParams) return url;
            url.searchParams.set('pv', window.CUE_PAGE_VERSION);
            var cta = currentCta();
            if (cta) url.searchParams.set('cta', cta);
            return url;
        }
    };
})();
