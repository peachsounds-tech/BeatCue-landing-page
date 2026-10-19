/**
 * Canonical account handoff (aid).
 *
 * The identity worker mints one account id per person (`acct_<32 hex>`). The
 * app, the hand-off email and the checkout links carry it here as `?aid=`.
 * This page keeps its anonymous `bc_` bcid as the PostHog bootstrap id and,
 * once an account is known:
 *
 *   - remembers it in localStorage (so later visits from this browser join
 *     the same person even without the param),
 *   - tells the worker this bcid belongs to that account (POST
 *     /identity/resolve, evidence `url_handoff`), once per bcid/account pair,
 *   - calls posthog.identify(account), which merges the anonymous bcid
 *     person into it,
 *   - exposes it for checkout links (`checkout[custom][account_id]`).
 *
 * A visitor who has never been near the app has no account, and nothing here
 * mints one: a bcid alone isn't strong enough evidence to create an account.
 */
(function (global) {
    var WORKER = 'https://peachsounds-webhook.sareldu.workers.dev';
    var ACCOUNT_RE = /^acct_[0-9a-f]{32}$/;
    var STORAGE_KEY = 'cue_account_id';
    var LINKED_KEY = 'cue_account_linked';   // "<acct>|<bcid>" last reported

    function safeGet(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function safeSet(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
    }

    var fromUrl = null;
    try { fromUrl = new URLSearchParams(global.location.search).get('aid'); } catch (e) {}

    var accountId = ACCOUNT_RE.test(fromUrl || '') ? fromUrl
                  : (ACCOUNT_RE.test(safeGet(STORAGE_KEY) || '') ? safeGet(STORAGE_KEY) : null);
    if (accountId) safeSet(STORAGE_KEY, accountId);

    function adopt(acct, posthog) {
        if (!ACCOUNT_RE.test(acct || '')) return;
        accountId = acct;
        safeSet(STORAGE_KEY, acct);
        try {
            if (posthog && typeof posthog.identify === 'function') posthog.identify(acct);
        } catch (e) { /* analytics must never break the page */ }
    }

    function linkBcid(bcid, posthog) {
        if (!accountId || !bcid) return;
        var marker = accountId + '|' + bcid;
        if (safeGet(LINKED_KEY) === marker) return;
        try {
            fetch(WORKER + '/identity/resolve', {
                method: 'POST',
                mode: 'cors',
                credentials: 'omit',
                keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nodes: [{ kind: 'bcid', value: bcid }],
                    account_id: accountId,
                    evidence: 'url_handoff',
                    client: 'web'
                })
            }).then(function (res) {
                return res.ok ? res.json() : null;
            }).then(function (data) {
                if (!data) return;
                safeSet(LINKED_KEY, marker);
                // The worker answers with the surviving account; it differs
                // when this one has since been merged into an older one.
                if (data.account_id && data.account_id !== accountId) adopt(data.account_id, posthog);
            }).catch(function () {});
        } catch (e) { /* no fetch / blocked */ }
    }

    // Call right after posthog.init(). Safe to call more than once.
    function attach(posthog, bcid) {
        if (!accountId) return;
        adopt(accountId, posthog);
        linkBcid(bcid, posthog);
    }

    // Lemon Squeezy checkout link → the same link carrying the account.
    function decorateCheckout(url) {
        if (!accountId || !url) return url;
        try {
            var u = new URL(url);
            u.searchParams.set('checkout[custom][account_id]', accountId);
            return u.toString();
        } catch (e) { return url; }
    }

    global.CueIdentity = {
        accountId: function () { return accountId; },
        attach: attach,
        decorateCheckout: decorateCheckout
    };
})(window);
