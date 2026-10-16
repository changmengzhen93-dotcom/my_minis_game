/*
  platform.js — the ONLY file that touches the TikTok Minis platform SDK.

  Exposes window.Platform: small promise-based helpers that use the global
  `TTMinis` object when the page runs inside the TikTok host, and fall back
  gracefully (localStorage / no-ops / console.info) in a plain browser preview,
  where the page is not framed by the host and the SDK has nothing to talk to.

  Runtime rules (this page lives in a sandboxed iframe under the TikTok
  "Mainframe"):
  - Every SDK call is guarded by sdkHas(): the page must be framed by the
    host AND TTMinis.<method> must be a function, plus canIUse() where
    sensible. The SDK script loads in a plain browser too, so the presence of
    the global alone proves nothing.
  - Only the allowlisted SDK surface below may be referenced. Methods hang
    directly off `TTMinis` (TTMinis.getStorage) — there is no `game`
    sub-object, and the mini-game `tt` / WeChat `wx` globals do not exist here.
    The platform exposes NO network, NO sync storage, NO toast/loading UI, NO
    keyboard or media natives, NO generic event subscriptions — use DOM
    equivalents in app code.
  - Async SDK methods take one options object with success/fail/complete
    callbacks (pass {} when there are no params); this file wraps them in
    Promises.

  Allowlisted `TTMinis` surface (do not reference anything else):
    capability : canIUse
    system     : getSystemInfoSync, getSystemInfo, getWindowInfo
    device     : getMenuButtonBoundingClientRect
    lifecycle  : onShow, offShow, onHide, offHide
    launch     : getLaunchOptionsSync, getEnterOptionsSync
    updates    : getUpdateManager
    sharing    : shareAppMessage, shareToStory, onCopyUrl, offCopyUrl
    nav bar    : setNavigationBarColor
    storage    : setStorage, getStorage, removeStorage, clearStorage
    retention  : startEntranceMission, getEntranceMissionReward, addShortcut,
                 getShortcutMissionReward, getFyfMissionReward
*/
(function () {
  'use strict';

  var LOG = '[Platform]';

  /* ---------- guards ---------- */

  // True when the SDK global exists and exposes `name` as a function.
  // The SDK script also loads in a plain browser, where it has no host to talk
  // to. The host always runs the tool inside its Mainframe iframe, so only use
  // the SDK when we are framed; at top level (local preview) use the fallbacks.
  function inHost() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }
  function sdkHas(name) {
    return inHost() && typeof TTMinis !== 'undefined' && TTMinis !== null && typeof TTMinis[name] === 'function';
  }

  // canIUse(schema) when available; otherwise assume "yes" so the method guard
  // above is the deciding factor.
  function canIUse(schema) {
    if (!sdkHas('canIUse')) return sdkHas(schema.split('.')[0]);
    try {
      return !!TTMinis.canIUse(schema);
    } catch (e) {
      return false;
    }
  }

  // Wrap a callback-style SDK method ({ success, fail, complete }) in a Promise.
  function callSdk(name, options) {
    return new Promise(function (resolve, reject) {
      var opts = Object.assign({}, options || {});
      opts.success = function (res) { resolve(res); };
      opts.fail = function (err) { reject(err || new Error(name + ' failed')); };
      try {
        TTMinis[name](opts);
      } catch (e) {
        reject(e);
      }
    });
  }

  var isHosted = inHost() && typeof TTMinis !== 'undefined' && TTMinis !== null;

  /* ---------- storage (async only on the platform) ---------- */

  // Desktop fallback: localStorage with JSON encoding. Wrapped in try/catch
  // because storage may be blocked (private mode, sandbox flags).
  var localFallback = {
    get: function (key) {
      try {
        var raw = window.localStorage.getItem(key);
        return raw === null ? undefined : JSON.parse(raw);
      } catch (e) {
        return undefined;
      }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.info(LOG, 'localStorage unavailable; value not persisted', key);
      }
    },
    remove: function (key) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {
        /* nothing to do */
      }
    },
    clear: function () {
      try {
        window.localStorage.clear();
      } catch (e) {
        /* nothing to do */
      }
    },
  };

  var storage = {
    // Resolves with the stored value, or undefined when absent / on error.
    get: function (key) {
      if (sdkHas('getStorage') && canIUse('getStorage')) {
        return callSdk('getStorage', { key: key })
          .then(function (res) {
            var data = res ? res.data : null;
            // The platform reports a missing key as data === null.
            if (data === null || data === undefined) return undefined;
            if (typeof data === 'string') {
              // Values are stored JSON-encoded; tolerate plain strings.
              try { return JSON.parse(data); } catch (e) { return data; }
            }
            return data;
          })
          .catch(function () { return undefined; });
      }
      return Promise.resolve(localFallback.get(key));
    },
    // Resolves when written; never rejects (persistence is best-effort).
    set: function (key, value) {
      if (sdkHas('setStorage') && canIUse('setStorage')) {
        return callSdk('setStorage', { key: key, data: JSON.stringify(value) })
          .then(function () { return true; })
          .catch(function (err) {
            console.info(LOG, 'setStorage failed', key, err);
            return false;
          });
      }
      localFallback.set(key, value);
      return Promise.resolve(true);
    },
    remove: function (key) {
      if (sdkHas('removeStorage') && canIUse('removeStorage')) {
        return callSdk('removeStorage', { key: key })
          .then(function () { return true; })
          .catch(function () { return false; });
      }
      localFallback.remove(key);
      return Promise.resolve(true);
    },
    // Removes every key of this tool.
    clear: function () {
      if (sdkHas('clearStorage') && canIUse('clearStorage')) {
        return callSdk('clearStorage', {})
          .then(function () { return true; })
          .catch(function () { return false; });
      }
      localFallback.clear();
      return Promise.resolve(true);
    },
  };

  /* ---------- sharing ---------- */

  // Opens the host share sheet. Must be called from a user gesture (a tap on
  // your Share button). `query` is a plain OBJECT ({ from: 'tool' }, never a
  // string); the receiving side reads it back from launchQuery(). No-op
  // (resolves false) outside the host.
  function share(query) {
    if (sdkHas('shareAppMessage') && canIUse('shareAppMessage')) {
      var opts = { query: query && typeof query === 'object' ? query : {} };
      return callSdk('shareAppMessage', opts)
        .then(function () { return true; })
        .catch(function (err) {
          console.info(LOG, 'shareAppMessage failed', err);
          return false;
        });
    }
    console.info(LOG, 'share(): not in TikTok host, no-op');
    return Promise.resolve(false);
  }

  // Shares to TikTok Story with the platform-configured content. User gesture
  // only. No-op (resolves false) outside the host.
  function shareToStory() {
    if (sdkHas('shareToStory') && canIUse('shareToStory')) {
      return callSdk('shareToStory', {})
        .then(function () { return true; })
        .catch(function (err) {
          console.info(LOG, 'shareToStory failed', err);
          return false;
        });
    }
    console.info(LOG, 'shareToStory(): not in TikTok host, no-op');
    return Promise.resolve(false);
  }

  /* ---------- retention: add to home screen ---------- */

  // iOS and Android have different minimum versions — always gate on canIUse.
  function canAddShortcut() {
    return sdkHas('addShortcut') && canIUse('addShortcut');
  }

  function addShortcut() {
    if (!canAddShortcut()) {
      console.info(LOG, 'addShortcut(): not supported here, no-op');
      return Promise.resolve(false);
    }
    return callSdk('addShortcut', {})
      .then(function () { return true; })
      .catch(function (err) {
        console.info(LOG, 'addShortcut failed', err);
        return false;
      });
  }

  /* ---------- lifecycle ---------- */

  // Calls showFn(query) when the tool comes to the foreground and hideFn()
  // when it goes to the background. Uses the host's onShow/onHide when
  // present (onShow hands over { query }), otherwise the document's
  // visibilitychange. Register once at startup. Returns an unsubscribe
  // function.
  function onVisibility(showFn, hideFn) {
    var show = typeof showFn === 'function' ? showFn : function () {};
    var hide = typeof hideFn === 'function' ? hideFn : function () {};

    if (sdkHas('onShow') && sdkHas('onHide')) {
      // Keep the exact listener references: offShow/offHide only remove the
      // same function they were given (there is no "remove all").
      var showListener = function (res) { show((res && res.query) || {}); };
      var hideListener = function () { hide(); };
      TTMinis.onShow(showListener);
      TTMinis.onHide(hideListener);
      return function () {
        if (sdkHas('offShow')) TTMinis.offShow(showListener);
        if (sdkHas('offHide')) TTMinis.offHide(hideListener);
      };
    }

    var handler = function () {
      if (document.visibilityState === 'hidden') hide();
      else show({});
    };
    document.addEventListener('visibilitychange', handler);
    return function () {
      document.removeEventListener('visibilitychange', handler);
    };
  }

  /* ---------- layout: safe area + capsule corner ---------- */

  // Returns { safeTop, capsuleClear } in CSS px.
  //   safeTop      status-bar / notch inset from the SDK (0 outside a host;
  //                CSS env(safe-area-inset-top) covers the rest).
  //   capsuleClear how much of the top-right to leave empty for the host's
  //                capsule menu: window width - rect.left + 8. 0 when unknown,
  //                and the CSS default (--capsule-clear) applies.
  // The capsule rect is in dp, which is 1:1 CSS px here — no pixelRatio math.
  // It is used ONLY for the corner's width, never to push the header down:
  // the header sits at the safe-area top, beside the capsule.
  // Trust the rect only when the host reports a status bar: outside a real
  // client the SDK returns a placeholder ({ right:1240, bottom:257, ... }, no
  // phone is that wide) next to statusBarHeight 0.
  function layout() {
    var safeTop = 0;
    var statusBar = 0;
    var windowWidth = 0;
    var capsuleClear = 0;

    if (sdkHas('getWindowInfo')) {
      try {
        var win = TTMinis.getWindowInfo();
        var sa = win && win.safeArea; // some devices return no safeArea
        if (win && typeof win.statusBarHeight === 'number') statusBar = win.statusBarHeight;
        if (win && typeof win.windowWidth === 'number') windowWidth = win.windowWidth;
        if (sa && typeof sa.top === 'number') safeTop = sa.top;
        else safeTop = statusBar;
      } catch (e) {
        /* leave 0 */
      }
    } else if (sdkHas('getSystemInfoSync')) {
      try {
        var sys = TTMinis.getSystemInfoSync();
        if (sys && typeof sys.statusBarHeight === 'number') { statusBar = sys.statusBarHeight; safeTop = statusBar; }
        if (sys && typeof sys.windowWidth === 'number') windowWidth = sys.windowWidth;
      } catch (e) {
        /* leave 0 */
      }
    }

    if (statusBar > 0 && windowWidth > 0 && sdkHas('getMenuButtonBoundingClientRect')) {
      try {
        var rect = TTMinis.getMenuButtonBoundingClientRect();
        if (rect && typeof rect.left === 'number' && rect.left > 0 && rect.left < windowWidth) {
          capsuleClear = Math.ceil(windowWidth - rect.left + 8);
        }
      } catch (e) {
        /* leave 0 */
      }
    }

    return { safeTop: safeTop, capsuleClear: capsuleClear };
  }

  /* ---------- navigation bar ---------- */

  // Matches the host's navigation bar to the tool's theme. `front` is
  // '#ffffff' or '#000000' (title / status-bar text); `background` is
  // '#RRGGBB'. No-op (resolves false) outside the host.
  function setNavigationBarColor(front, background) {
    if (sdkHas('setNavigationBarColor') && canIUse('setNavigationBarColor')) {
      return callSdk('setNavigationBarColor', { frontColor: front, backgroundColor: background })
        .then(function () { return true; })
        .catch(function (err) {
          console.info(LOG, 'setNavigationBarColor failed', err);
          return false;
        });
    }
    return Promise.resolve(false);
  }

  /* ---------- launch info (optional) ---------- */

  // { scene, query } from the host, or {} outside it.
  function launchOptions() {
    if (sdkHas('getLaunchOptionsSync')) {
      try { return TTMinis.getLaunchOptionsSync() || {}; } catch (e) { /* fall through */ }
    }
    return {};
  }

  // The `query` object of this launch (e.g. what a share attached), or {}.
  function launchQuery() {
    var q = launchOptions().query;
    return q && typeof q === 'object' ? q : {};
  }

  window.Platform = {
    isHosted: isHosted,
    canIUse: canIUse,
    storage: storage,
    share: share,
    shareToStory: shareToStory,
    canAddShortcut: canAddShortcut,
    addShortcut: addShortcut,
    onVisibility: onVisibility,
    layout: layout,
    setNavigationBarColor: setNavigationBarColor,
    launchOptions: launchOptions,
    launchQuery: launchQuery,
  };

  if (!isHosted) {
    console.info(LOG, 'not inside the TikTok host — running with browser fallbacks (localStorage, no-op share).');
  }
})();
