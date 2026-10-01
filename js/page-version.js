// Single source of truth for landing-page versioning (PostHog page_version, etc.).
// Bump the default once for shared pages; path-specific versions override below.
(function () {
    var path = (typeof location !== 'undefined' && location.pathname) || '';
    if (/^\/v4(\/|$)/.test(path)) {
        window.CUE_PAGE_VERSION = '4.0.1';
        return;
    }
    window.CUE_PAGE_VERSION = '2.0.6';
})();
