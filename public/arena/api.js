/* ======================================================================
   Ledger Quest Arena — client API (stage 3).

   SECURITY MODEL: the client NEVER computes the deposit bonus. It only
   reports what happened in a level (which level, how many shots, how many
   coins) together with Telegram's signed initData. The server
   (arena-api.js) verifies the HMAC signature, checks that the result
   is plausible, works out the stars and the bonus itself, and returns the
   numbers the UI shows. Anything this file receives from the server is
   displayed as-is; nothing here is trusted by the server.

   Exposes window.LQApi:
     LQApi.hasTelegram()           -> true when signed initData is available
     LQApi.startLevel(levelId)     -> Promise<{ runId }>
     LQApi.completeLevel(payload)  -> Promise<{ stars, bestStars, bonusAddedPct,
                                               bonusTotalPct, maxBonusPct, ... }>
     LQApi.getProfile()            -> Promise<{ bonusTotalPct, maxBonusPct, levels }>
   Every method rejects with an LQApiError whose `kind` is one of:
     "no-telegram"   opened outside Telegram, nothing was sent
     "offline"       the request never reached the server
     "timeout"       no answer within cfg.timeoutMs
     "unauthorized"  401: signature invalid or initData expired
     "rejected"      400/403/404/409/422: the server refused the result (see .code)
     "rate-limited"  429
     "server"        5xx or an unreadable answer

   Configuration (optional), set BEFORE this script loads:
     window.LQ_API_CONFIG = { baseUrl: "https://your-server.example", timeoutMs: 8000 }
   ====================================================================== */
(function (global) {
  "use strict";

  // Must match ARENA_CONFIG_VERSION in arena-api.js. Bump both whenever
  // level tiers / shot counts / coin counts change, so an old client can't
  // report results against a level table the server no longer uses.
  var CONFIG_VERSION = "arena-v2";

  var cfg = {
    // TODO(deploy): leave "" when the game is served by the same server as
    // the API (recommended — no CORS needed). Otherwise set the API origin.
    baseUrl: "",
    timeoutMs: 8000,
  };
  try {
    var user = global.LQ_API_CONFIG || {};
    if (typeof user.baseUrl === "string") cfg.baseUrl = user.baseUrl.replace(/\/+$/, "");
    if (typeof user.timeoutMs === "number" && user.timeoutMs > 0) cfg.timeoutMs = user.timeoutMs;
  } catch (e) {}

  function LQApiError(kind, message, extra) {
    var err = new Error(message || kind);
    err.name = "LQApiError";
    err.kind = kind;
    if (extra) for (var k in extra) err[k] = extra[k];
    return err;
  }

  // Telegram puts the signed initData in two places: Telegram.WebApp.initData
  // (when telegram-web-app.js is loaded) and the launch URL's hash
  // (#tgWebAppData=...). The hash is read ONCE at load, before the game can
  // change location.hash.
  // TODO(deploy): also include https://telegram.org/js/telegram-web-app.js
  // in the Mini App page for theme/back-button/haptics; this file works
  // without it thanks to the hash fallback.
  var launchInitData = "";
  try {
    var h = (global.location && global.location.hash || "").replace(/^#/, "");
    var fromHash = new URLSearchParams(h).get("tgWebAppData");
    if (fromHash) launchInitData = fromHash;
  } catch (e) {}

  function initData() {
    try {
      var w = global.Telegram && global.Telegram.WebApp;
      if (w && typeof w.initData === "string" && w.initData) return w.initData;
    } catch (e) {}
    // Embedded in the Ledger Quest Mini App's "Арена" tab (same-origin
    // iframe): the signed initData lives in the parent window.
    try {
      var pw = global.parent && global.parent !== global && global.parent.Telegram && global.parent.Telegram.WebApp;
      if (pw && typeof pw.initData === "string" && pw.initData) return pw.initData;
    } catch (e) {}
    return launchInitData;
  }

  function request(method, path, body) {
    var data = initData();
    if (!data) return Promise.reject(LQApiError("no-telegram", "Open the game inside Telegram"));

    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; if (ctrl) ctrl.abort(); }, cfg.timeoutMs);

    var opts = {
      method: method,
      headers: { "X-Telegram-Init-Data": data },
      signal: ctrl ? ctrl.signal : undefined,
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    return fetch(cfg.baseUrl + path, opts).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (text) {
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) {}
        if (res.ok && json) return json;
        var code = json && json.error ? String(json.error) : "http_" + res.status;
        var msg = json && json.message ? String(json.message) : "";
        if (res.status === 401) throw LQApiError("unauthorized", msg, { status: 401, code: code });
        if (res.status === 429) throw LQApiError("rate-limited", msg, { status: 429, code: code });
        if (res.status >= 400 && res.status < 500) throw LQApiError("rejected", msg, { status: res.status, code: code });
        throw LQApiError("server", msg, { status: res.status, code: code });
      });
    }, function (err) {
      clearTimeout(timer);
      if (timedOut) throw LQApiError("timeout", "No answer from the server");
      throw LQApiError("offline", err && err.message);
    });
  }

  function intOrNull(v) { return Number.isInteger(v) ? v : null; }

  global.LQApi = {
    configVersion: CONFIG_VERSION,

    hasTelegram: function () { return !!initData(); },

    // DISPLAY ONLY (name/avatar letter). Unverified on the client; the
    // server never uses anything but the signature-checked copy.
    unsafeUser: function () {
      try { return JSON.parse(new URLSearchParams(initData()).get("user") || "null"); } catch (e) { return null; }
    },

    // Opens a server-side run for this attempt. The server remembers when it
    // started; level-complete must reference it (single use, minimum time).
    startLevel: function (levelId) {
      return request("POST", "/api/game/level-start", {
        levelId: intOrNull(levelId),
        configVersion: CONFIG_VERSION,
      });
    },

    // Reports a WON level. Only raw facts are sent — never stars or bonus.
    // Safe to retry with the same runId: the server answers a repeated
    // runId with the stored result instead of crediting twice.
    completeLevel: function (p) {
      return request("POST", "/api/game/level-complete", {
        runId: typeof p.runId === "string" ? p.runId : null,
        levelId: intOrNull(p.levelId),
        shotsUsed: intOrNull(p.shotsUsed),
        coinsCollected: intOrNull(p.coinsCollected),
        score: intOrNull(p.score),
        configVersion: CONFIG_VERSION,
      });
    },

    getProfile: function () {
      return request("GET", "/api/game/profile");
    },
  };
})(window);
