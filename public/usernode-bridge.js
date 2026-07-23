/**
 * usernode-bridge.js
 *
 * Included by dapps to access Usernode-provided APIs when running inside the
 * mobile app WebView. When running in a normal browser, it provides stubbed
 * implementations so local development still works.
 *
 * Three operating modes:
 *   1. Native mode — inside the Flutter WebView (Usernode.postMessage).
 *   2. Mock mode   — server runs --local-dev, /__mock/enabled returns 200.
 *   3. QR mode     — desktop browser, no native bridge, no mock.
 *                    sendTransaction shows a QR code for the user to scan
 *                    with the mobile app, then polls for on-chain inclusion.
 *
 * Mock-mode detection: when the server runs with --local-dev, it exposes
 * /__mock/enabled. If that endpoint responds 200, ALL transaction calls go
 * through mock endpoints — even inside the Flutter WebView. This lets
 * developers test dapps on-device without hitting the real chain.
 */

(function () {
  window.usernode = window.usernode || {};

  // ── Native + iframe-relay detection ───────────────────────────────────
  //
  // "dapp mode" (top frame inside the Flutter WebView) exposes a JS channel
  // object named `Usernode` with a `postMessage` function.
  //
  // When a dapp is embedded inside another page (e.g. the social-vibecoding
  // platform loads dapps in cross-origin iframes), Flutter's WebView only
  // injects `window.Usernode` into the top frame — child frames see
  // `window.Usernode === undefined`. To keep dapps working transparently
  // inside iframes, we relay native calls through the parent window via
  // `postMessage`. The parent's copy of this bridge installs a listener
  // (further down) that forwards relayed requests to `Usernode.postMessage`
  // and routes responses back to the originating iframe.
  //
  // Detection:
  //   * If we have direct access to `window.Usernode` → use it (top frame).
  //   * Else if we're inside an iframe → ask the parent via a `discover`
  //     postMessage whether it has a native channel. The parent only ACKs
  //     when it actually does, at which point we flip into relay mode.
  //     Without an ACK we stay in regular non-native mode, so a dapp
  //     embedded in a plain desktop browser still falls through to the
  //     existing QR-code flow.
  var _hasNativeChannel =
    !!window.Usernode && typeof window.Usernode.postMessage === "function";
  var _inIframe = false;
  try { _inIframe = window !== window.parent; } catch (_) { _inIframe = false; }

  // Frame-tagged log prefix: see usernode-echo-dapp's bridge for the
  // full rationale. Lets us tell parent-frame and iframe-frame logs
  // apart in the merged Flutter console output.
  var _BRIDGE_TAG = "[bridge " + (_inIframe ? "iframe" : "top") + " " +
    (typeof location !== "undefined" ? location.host : "?") + "]";
  console.log(_BRIDGE_TAG, "loaded; inIframe=" + _inIframe +
    " hasNativeChannel=" + _hasNativeChannel +
    " hasUsernode=" + (typeof window.Usernode));

  // Android WebView injects `window.Usernode` into ALL frames, including
  // cross-origin iframes. Outgoing `Usernode.postMessage` from an iframe
  // works, but Flutter resolves promises via `runJavaScript`, which only
  // evaluates in the top frame — so iframe-issued promises never resolve.
  // Force iframes through the parent relay so request AND response both
  // route through the top frame (which IS the parent).
  if (_inIframe && _hasNativeChannel) {
    console.log(_BRIDGE_TAG,
      "ignoring iframe-injected Usernode (Flutter resolves only in top frame);" +
      " routing through parent relay");
    _hasNativeChannel = false;
  }

  // Optimistic: only true once the parent has positively confirmed it has a
  // native channel for us to relay through.
  var _useIframeRelay = false;
  window.usernode.isNative = _hasNativeChannel;

  // ── Configuration for QR/desktop mode ─────────────────────────────────
  // Apps call window.usernode.configure({ address: "ut1..." }) to set the
  // user's public key for getNodeAddress() in non-native environments.
  var _configuredAddress = null;

  window.usernode.configure = function configure(opts) {
    if (opts && typeof opts.address === "string" && opts.address.trim()) {
      _configuredAddress = opts.address.trim();
    }
  };

  // ── Auto-configure from iframe URL token ──────────────────────────────
  //
  // When a dapp is embedded inside a host that appends `?token=<JWT>` to
  // the iframe URL (e.g. Usernode Social Vibecoding's per-app iframes —
  // see social-vibecoding/server.js `/api/iframe-token`), the JWT carries
  // the signed-in user's linked `usernode_pubkey` as a claim. Decode it
  // here and seed `_configuredAddress` so `getNodeAddress()` returns the
  // linked address instead of the random `mockpk_*` fallback.
  //
  // No signature verification — the bridge doesn't have the host's
  // signing key, and we only use the claim to populate a display-level
  // identity (the "from" address for reads). Real wallet ops still go
  // through the native channel, iframe relay, or QR fallback, all of
  // which sign with material the bridge never sees. Treating an
  // unverified pubkey as authoritative for reads is safe; treating it
  // as authoritative for sends would not be — and we don't.
  (function autoConfigureFromIframeToken() {
    try {
      if (typeof location === "undefined" || !location.search) return;
      var params = new URLSearchParams(location.search);
      var token = params.get("token");
      if (!token) return;
      var parts = token.split(".");
      if (parts.length < 2) return;
      var payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (payload.length % 4) payload += "=";
      var decoded = JSON.parse(atob(payload));
      var pk = decoded && decoded.usernode_pubkey;
      if (typeof pk === "string" && pk.trim()) {
        _configuredAddress = pk.trim();
        console.log(_BRIDGE_TAG,
          "auto-configured address from iframe JWT (linked pubkey)");
      }
    } catch (_) { /* silently ignore parse errors — fall through to mock */ }
  })();

  // Shared promise bridge for native calls (Flutter resolves via
  // `window.__usernodeResolve(id, value, error)`).
  window.__usernodeBridge = window.__usernodeBridge || { pending: {} };
  window.__usernodeResolve = function (id, value, error) {
    var entry = window.__usernodeBridge.pending[id];
    if (!entry) return;
    delete window.__usernodeBridge.pending[id];
    if (error) entry.reject(new Error(error));
    else entry.resolve(value);
  };

  // 15 s is well above the Flutter confirm-screen turnaround (single
  // digits of ms in the relay leg + however long the user takes to
  // approve), so a timeout firing means the parent never picked up the
  // request — surface it as an actual error instead of an infinite hang.
  var _RELAY_TIMEOUT_MS = 15000;

  function callNative(method, args) {
    var id = String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    return new Promise(function (resolve, reject) {
      window.__usernodeBridge.pending[id] = { resolve: resolve, reject: reject };
      var payload = { method: method, id: id, args: args || {} };
      console.log(_BRIDGE_TAG, "callNative", method, "id", id,
        "useIframeRelay=" + _useIframeRelay,
        "hasNativeChannel=" + _hasNativeChannel);
      if (_useIframeRelay) {
        var timer = setTimeout(function () {
          var entry = window.__usernodeBridge.pending[id];
          if (!entry) return;
          delete window.__usernodeBridge.pending[id];
          console.warn("[usernode-bridge] relay timeout for", method, "id", id);
          reject(new Error(
            "Usernode relay timed out (parent page never responded). " +
            "Reload the host page so it picks up the latest bridge."
          ));
        }, _RELAY_TIMEOUT_MS);
        // Wrap resolve/reject so the timeout is cleared on completion.
        var origEntry = window.__usernodeBridge.pending[id];
        window.__usernodeBridge.pending[id] = {
          resolve: function (v) { clearTimeout(timer); origEntry.resolve(v); },
          reject: function (e) { clearTimeout(timer); origEntry.reject(e); },
        };
        try {
          console.log(_BRIDGE_TAG, "relay → parent:", method, "id", id);
          window.parent.postMessage(
            { __usernode_relay: "request", id: id, method: method, args: args || {} },
            "*"
          );
        } catch (err) {
          clearTimeout(timer);
          delete window.__usernodeBridge.pending[id];
          reject(err);
        }
        return;
      }
      if (_hasNativeChannel) {
        try {
          console.log(_BRIDGE_TAG, "→ Usernode.postMessage", method, "id", id);
          window.Usernode.postMessage(JSON.stringify(payload));
        } catch (err) {
          console.warn(_BRIDGE_TAG, "Usernode.postMessage threw:", err && err.message);
          delete window.__usernodeBridge.pending[id];
          reject(err);
        }
        return;
      }
      console.warn(_BRIDGE_TAG, "no transport for", method,
        "(useIframeRelay=false, hasNativeChannel=false) — rejecting");
      delete window.__usernodeBridge.pending[id];
      reject(new Error("Usernode native bridge not available"));
    });
  }

  // ── Iframe-relay client: discover parent + receive responses ──────────
  //
  // When loaded inside a cross-origin iframe, kick off a `discover`
  // handshake with the parent. The parent's bridge replies with
  // `discover-ack` only if it has access to `window.Usernode`. On ack we
  // flip `_useIframeRelay = true` and update `window.usernode.isNative`
  // so subsequent dispatchers (`sendTransaction`, `signMessage`, etc.)
  // route through the relay. With no ack we leave native off and the
  // dapp falls through to its regular QR / mock paths.
  //
  // The same listener also funnels relayed responses
  //   { __usernode_relay: "response", id, value, error }
  // into the existing `__usernodeResolve` plumbing so the rest of the
  // bridge does not need to know about the relay path.
  if (_inIframe && !_hasNativeChannel) {
    window.addEventListener("message", function (e) {
      if (e.source !== window.parent) return;
      var data = e.data;
      if (!data) return;
      if (data.__usernode_relay === "discover-ack") {
        if (!_useIframeRelay) {
          console.log(_BRIDGE_TAG, "iframe relay activated (parent ack received)");
          _useIframeRelay = true;
          window.usernode.isNative = true;
        }
        return;
      }
      if (data.__usernode_relay === "response") {
        console.log(_BRIDGE_TAG, "relay ← parent response id", data.id);
        window.__usernodeResolve(data.id, data.value, data.error);
      }
    });
    try {
      console.log(_BRIDGE_TAG, "sending discover ping to parent");
      window.parent.postMessage({ __usernode_relay: "discover" }, "*");
    } catch (_) { /* parent unreachable, stay non-native */ }
  }

  // ── Iframe-relay server: forward child-iframe requests to native ──────
  //
  // When this bridge runs in the top frame and the native channel is
  // available, respond to `discover` pings with a `discover-ack`, and
  // forward `request` payloads straight through to the Flutter JS
  // channel. This deliberately bypasses the parent page's own dispatch
  // wrappers (mock detection, QR fallback) — the iframe already runs
  // its own copy of this bridge and is responsible for those decisions
  // in its own origin. The parent only relays raw Usernode.postMessage
  // payloads, which keeps cross-origin behaviour predictable.
  if (_hasNativeChannel) {
    console.log(_BRIDGE_TAG, "native channel available, relay listener installed");
    window.addEventListener("message", function (e) {
      var data = e.data;
      if (!data || !e.source) return;
      var origin = e.origin || "*";
      var source = e.source;
      if (data.__usernode_relay === "discover") {
        console.log(_BRIDGE_TAG, "← discover from", origin, "→ acking");
        try {
          source.postMessage({ __usernode_relay: "discover-ack" }, origin);
        } catch (_) { /* iframe gone, ignore */ }
        return;
      }
      if (data.__usernode_relay !== "request") return;
      var origId = data.id;
      // Homescreen-shortcut management is top-frame-only: the app auto-
      // approves these calls based on the top frame's origin, so relaying
      // them for a child iframe would let any embedded sub-app piggyback
      // on the parent's trust. Refuse here instead of forwarding.
      if (typeof data.method === "string" &&
          data.method.indexOf("HomeScreenShortcut") !== -1) {
        console.warn(_BRIDGE_TAG, "refusing to relay", data.method,
          "for child iframe", origin);
        try {
          source.postMessage(
            { __usernode_relay: "response", id: origId, value: null,
              error: "Homescreen shortcuts can only be managed by the top-level page" },
            origin
          );
        } catch (_) { /* iframe gone, ignore */ }
        return;
      }
      var nativeId = "relay-" + String(Date.now()) + "-" +
        Math.random().toString(16).slice(2);
      console.log(_BRIDGE_TAG, "← relay request",
        data.method, "id", origId, "→ native id", nativeId);
      function reply(value, error) {
        try {
          source.postMessage(
            { __usernode_relay: "response", id: origId, value: value, error: error },
            origin
          );
        } catch (_) { /* iframe gone, ignore */ }
      }
      window.__usernodeBridge.pending[nativeId] = {
        resolve: function (v) {
          console.log(_BRIDGE_TAG, "native resolve →", nativeId);
          reply(v, null);
        },
        reject: function (err) {
          console.log(_BRIDGE_TAG, "native reject →", nativeId, err);
          reply(null, (err && err.message) || String(err));
        },
      };
      try {
        window.Usernode.postMessage(JSON.stringify({
          method: data.method,
          id: nativeId,
          args: data.args || {},
        }));
      } catch (err) {
        delete window.__usernodeBridge.pending[nativeId];
        reply(null, (err && err.message) || String(err));
      }
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function normalizeTransactionsResponse(resp) {
    if (Array.isArray(resp)) return resp;
    if (!resp || typeof resp !== "object") return [];
    if (Array.isArray(resp.items)) return resp.items;
    if (Array.isArray(resp.transactions)) return resp.transactions;
    if (resp.data && Array.isArray(resp.data.items)) return resp.data.items;
    return [];
  }

  function attachMatchedTx(sendResult, matchedTx) {
    if (!matchedTx) return sendResult;
    if (sendResult == null) return { queued: true, tx: matchedTx };
    if (typeof sendResult !== "object") return sendResult;
    if (sendResult.tx) return sendResult;
    sendResult.tx = matchedTx;
    return sendResult;
  }

  function extractTxId(sendResult) {
    if (!sendResult) return null;
    var candidates = [];
    if (typeof sendResult === "string") candidates.push(sendResult);
    if (typeof sendResult === "object") {
      candidates.push(
        sendResult.tx_id,
        sendResult.txid,
        sendResult.txId,
        sendResult.hash,
        sendResult.tx_hash,
        sendResult.txHash,
        sendResult.id
      );
      if (sendResult.tx && typeof sendResult.tx === "object") {
        candidates.push(
          sendResult.tx.tx_id,
          sendResult.tx.id,
          sendResult.tx.txid,
          sendResult.tx.txId,
          sendResult.tx.hash,
          sendResult.tx.tx_hash,
          sendResult.tx.txHash
        );
      }
    }
    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  }

  function extractTxTimestampMs(tx) {
    if (!tx || typeof tx !== "object") return null;
    var candidates = [
      tx.timestamp_ms,
      tx.created_at,
      tx.createdAt,
      tx.timestamp,
      tx.time,
      tx.seen_at,
      tx.seenAt,
    ];
    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i];
      if (typeof v === "number" && Number.isFinite(v)) {
        return v < 10000000000 ? v * 1000 : v;
      }
      if (typeof v === "string" && v.trim()) {
        var t = Date.parse(v);
        if (!Number.isNaN(t)) return t;
      }
    }
    return null;
  }

  function pickFirst(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] != null) return obj[keys[i]];
    }
    return null;
  }

  // ── Native ack helper ─────────────────────────────────────────────────
  //
  // When the bridge confirms a tx is on-chain, notify the Flutter host so it
  // can stamp the "dapp observed" latency separately from its own polling.
  var _observedTxIds = {};
  function _notifyNativeTxObserved(txId, matched) {
    if (typeof txId !== "string") return;
    var trimmed = txId.trim();
    if (!trimmed) return;
    if (_observedTxIds[trimmed]) return;
    _observedTxIds[trimmed] = true;

    var channel = window.Usernode;
    if (
      !channel ||
      typeof channel !== "object" ||
      typeof channel.postMessage !== "function"
    ) {
      return;
    }

    var blockHeight = null;
    var blockTimestampMs = null;
    if (matched && typeof matched === "object") {
      var bh = matched.block_height;
      if (typeof bh === "number" && Number.isFinite(bh)) blockHeight = bh;
      var ts = matched.timestamp_ms != null
        ? matched.timestamp_ms
        : matched.block_timestamp_ms;
      if (typeof ts === "number" && Number.isFinite(ts)) {
        blockTimestampMs = ts;
      } else if (typeof ts === "string" && ts.trim()) {
        var parsed = Date.parse(ts);
        if (!Number.isNaN(parsed)) blockTimestampMs = parsed;
      }
    }

    try {
      channel.postMessage(
        JSON.stringify({
          method: "txObserved",
          id: "tx_observed_" + trimmed,
          args: {
            tx_id: trimmed,
            observed_at_ms: Date.now(),
            block_height: blockHeight,
            block_timestamp_ms: blockTimestampMs,
          },
        })
      );
    } catch (e) {
      console.warn("[usernode-bridge] tx_observed emit failed:", e);
    }
  }

  window.usernode.acknowledgeTransaction = function acknowledgeTransaction(
    txId
  ) {
    _notifyNativeTxObserved(txId);
  };

  function txMatches(tx, expected) {
    if (!tx || typeof tx !== "object") return false;
    if (!expected || typeof expected !== "object") return false;

    if (expected.txId) {
      var txIdCandidates = [
        tx.id, tx.txid, tx.txId, tx.tx_id, tx.hash, tx.tx_hash, tx.txHash,
      ]
        .filter(function (v) { return typeof v === "string"; })
        .map(function (v) { return v.trim(); })
        .filter(Boolean);
      if (txIdCandidates.indexOf(expected.txId) >= 0) return true;
    }

    if (typeof expected.minCreatedAtMs === "number") {
      var txTime = extractTxTimestampMs(tx);
      if (typeof txTime === "number") {
        var SKEW_MS = 5000;
        if (txTime < expected.minCreatedAtMs - SKEW_MS) return false;
      }
    }

    if (expected.memo != null) {
      var memo = tx.memo == null ? null : String(tx.memo);
      if (memo !== expected.memo) return false;
    }
    if (expected.destination_pubkey != null) {
      var raw = pickFirst(tx, ["destination_pubkey", "destination", "to"]);
      var dest = raw == null ? null : String(raw);
      if (dest !== expected.destination_pubkey) return false;
    }
    if (expected.from_pubkey != null) {
      var raw2 = pickFirst(tx, ["from_pubkey", "source", "from"]);
      var from = raw2 == null ? null : String(raw2);
      if (from !== expected.from_pubkey) return false;
    }
    return true;
  }

  // ── Inclusion transports ──────────────────────────────────────────────
  //
  // Dapps can set window.usernode.serverCacheUrl to their server-side
  // createAppStateCache mount. The bridge then confirms sends against that
  // sidecar-fed cache instead of each client polling the explorer directly.
  function _serverCacheUrl(opts) {
    if (opts && typeof opts.serverCacheUrl === "string" && opts.serverCacheUrl) {
      return opts.serverCacheUrl;
    }
    var u = window.usernode && window.usernode.serverCacheUrl;
    return typeof u === "string" && u ? u : null;
  }

  function _fetchInclusionPage(query, opts) {
    var base = _serverCacheUrl(opts);
    if (!base) return window.getTransactions(query);
    return fetch(base + "/getTransactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query || {}),
      credentials: "same-origin",
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (text) {
          throw new Error(
            "server-cache getTransactions failed (" + resp.status + "): " + text
          );
        });
      }
      return resp.json();
    });
  }

  function _ensureClientId() {
    if (window.usernode && window.usernode._clientId) {
      return window.usernode._clientId;
    }
    var id = randomHex(8);
    window.usernode = window.usernode || {};
    window.usernode._clientId = id;
    return id;
  }

  function waitForTransactionVisible(expected, opts) {
    var timeoutMs =
      opts && typeof opts.timeoutMs === "number" ? opts.timeoutMs : 180000;

    var sseAvailable =
      _serverCacheUrl(opts) &&
      typeof window.EventSource !== "undefined" &&
      !(opts && opts.forcePolling);

    if (!sseAvailable) {
      return _waitViaPolling(expected, opts);
    }

    return _waitViaSse(expected, timeoutMs, opts).then(
      function (matched) {
        _notifyNativeTxObserved(
          extractTxId(matched) || (expected && expected.txId),
          matched
        );
        return matched;
      },
      function (err) {
        if (err && err._fallbackToPolling) {
          console.log(
            "[usernode-bridge] SSE waitForTx failed (" + err.reason +
            "), falling back to polling"
          );
          return _waitViaPolling(expected, opts);
        }
        return Promise.reject(err);
      }
    );
  }

  function _waitViaSse(expected, timeoutMs, opts) {
    return new Promise(function (resolve, reject) {
      var clientId = _ensureClientId();
      var params = new URLSearchParams();
      if (expected.from_pubkey) params.set("sender", expected.from_pubkey);
      if (expected.destination_pubkey)
        params.set("recipient", expected.destination_pubkey);
      if (expected.memo != null) params.set("memo", expected.memo);
      if (expected.txId) params.set("txId", expected.txId);
      if (typeof expected.minCreatedAtMs === "number")
        params.set("minCreatedAtMs", String(expected.minCreatedAtMs));
      params.set("timeoutMs", String(timeoutMs));
      params.set("clientId", clientId);

      var url = _serverCacheUrl(opts) + "/waitForTx?" + params.toString();
      var startedAt = Date.now();
      var es;
      try {
        es = new EventSource(url, { withCredentials: false });
      } catch (e) {
        var initErr = new Error("EventSource constructor failed: " + e.message);
        initErr._fallbackToPolling = true;
        initErr.reason = "constructor-failed";
        return reject(initErr);
      }

      var receivedMessage = false;
      var settled = false;

      function settle(fn) {
        if (settled) return;
        settled = true;
        try { es.close(); } catch (_) {}
        fn();
      }

      es.addEventListener("matched", function (e) {
        receivedMessage = true;
        var tx = null;
        try { tx = JSON.parse(e.data); } catch (_) {}
        settle(function () {
          console.log(
            "[usernode-bridge] tx matched via SSE in " +
            (Date.now() - startedAt) + "ms"
          );
          resolve(tx);
        });
      });

      es.addEventListener("timeout", function () {
        receivedMessage = true;
        settle(function () {
          var details = [
            expected.txId ? "txId=" + expected.txId : null,
            expected.memo != null ? "memo=" + expected.memo : null,
          ].filter(Boolean).join(", ");
          var err = new Error(
            "Timed out waiting for transaction to appear (" + timeoutMs +
            "ms via server-cache SSE" + (details ? ", " + details : "") + ")"
          );
          reject(err);
        });
      });

      es.onerror = function () {
        if (settled) return;
        if (receivedMessage) return;
        settle(function () {
          var err = new Error("SSE connection error");
          err._fallbackToPolling = true;
          err.reason = "connection-error";
          reject(err);
        });
      };
    });
  }

  function _openPassiveSseTelemetry(expected, opts) {
    if (opts && opts.forcePolling) return;
    if (!_serverCacheUrl(opts)) return;
    if (typeof window.EventSource === "undefined") return;

    var hasNarrowing = !!(
      (expected.txId) ||
      (expected.from_pubkey) ||
      (expected.destination_pubkey) ||
      (expected.memo != null)
    );
    if (!hasNarrowing) return;

    var timeoutMs =
      opts && typeof opts.timeoutMs === "number" ? opts.timeoutMs : 180000;
    var clientId = _ensureClientId();

    var params = new URLSearchParams();
    if (expected.from_pubkey) params.set("sender", expected.from_pubkey);
    if (expected.destination_pubkey)
      params.set("recipient", expected.destination_pubkey);
    if (expected.memo != null) params.set("memo", expected.memo);
    if (expected.txId) params.set("txId", expected.txId);
    if (typeof expected.minCreatedAtMs === "number")
      params.set("minCreatedAtMs", String(expected.minCreatedAtMs));
    params.set("timeoutMs", String(timeoutMs));
    params.set("clientId", clientId);

    var url = _serverCacheUrl(opts) + "/waitForTx?" + params.toString();
    var es;
    try { es = new EventSource(url, { withCredentials: false }); }
    catch (_) { return; }

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      try { es.close(); } catch (_) {}
    }
    es.addEventListener("matched", close);
    es.addEventListener("timeout", close);
    es.onerror = close;
  }

  function _waitViaPolling(expected, opts) {
    var timeoutMs =
      opts && typeof opts.timeoutMs === "number" ? opts.timeoutMs : 180000;
    var pollIntervalMs =
      opts && typeof opts.pollIntervalMs === "number" ? opts.pollIntervalMs : 750;
    var limit = opts && typeof opts.limit === "number" ? opts.limit : 50;
    var filterOptions =
      (opts && opts.filterOptions && typeof opts.filterOptions === "object"
        ? opts.filterOptions
        : null) || {};

    var query = Object.assign({ limit: limit }, filterOptions);
    if (expected.from_pubkey && !query.sender && !query.account) {
      query.sender = expected.from_pubkey;
    }

    var transportLabel = _serverCacheUrl(opts) ? "server-cache" : "getTransactions";
    var startedAt = Date.now();
    var attempt = 0;

    function poll() {
      attempt++;
      return _fetchInclusionPage(query, opts).then(function (resp) {
        var items = normalizeTransactionsResponse(resp);
        var found = null;
        for (var i = 0; i < items.length; i++) {
          if (txMatches(items[i], expected)) { found = items[i]; break; }
        }
        if (found) {
          console.log("[usernode-bridge] tx found after", attempt, "polls,", Date.now() - startedAt, "ms (via " + transportLabel + ")");
          _notifyNativeTxObserved(
            extractTxId(found) || (expected && expected.txId),
            found
          );
          return found;
        }

        if (attempt <= 3 || attempt % 10 === 0) {
          console.log("[usernode-bridge] waitForTx poll #" + attempt + ", " + items.length + " items, no match yet (via " + transportLabel + ")");
        }

        if (Date.now() - startedAt >= timeoutMs) {
          var details = [
            expected.txId ? "txId=" + expected.txId : null,
            expected.memo != null ? "memo=" + expected.memo : null,
          ]
            .filter(Boolean)
            .join(", ");
          console.warn("[usernode-bridge] waitForTx timed out (via " + transportLabel + "). expected:", JSON.stringify(expected));
          if (items.length > 0) {
            console.warn("[usernode-bridge] last poll sample (first item):", JSON.stringify(items[0]));
          }
          throw new Error(
            "Timed out waiting for transaction to appear (" + timeoutMs + "ms, " + attempt + " polls via " + transportLabel + (details ? ", " + details : "") + ")"
          );
        }
        return sleep(pollIntervalMs).then(poll);
      });
    }
    return poll();
  }

  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(a);
    } else {
      for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function getOrCreateMockPubkey() {
    var key = "usernode:mockPubkey";
    var v = window.localStorage.getItem(key);
    if (!v) {
      v = "mockpk_" + randomHex(16);
      window.localStorage.setItem(key, v);
    }
    return v;
  }

  // ── Mock-mode detection ────────────────────────────────────────────────
  var _mockEnabledResult = null;

  function isMockEnabled() {
    if (_mockEnabledResult !== null) return Promise.resolve(_mockEnabledResult);
    return fetch("/__mock/enabled", { method: "GET" }).then(function (resp) {
      _mockEnabledResult = resp.ok;
      if (_mockEnabledResult) {
        console.log("[usernode-bridge] mock API detected — using local-dev endpoints");
      }
      return _mockEnabledResult;
    }).catch(function () {
      _mockEnabledResult = false;
      return false;
    });
  }

  window.usernode.isMockEnabled = isMockEnabled;

  // ── QR mode detection ──────────────────────────────────────────────────
  // Returns true when we're in a regular desktop browser (not native, not mock).
  function isQrMode() {
    if (window.usernode.isNative) return Promise.resolve(false);
    return isMockEnabled().then(function (mock) { return !mock; });
  }

  // =====================================================================
  //  QR Code encoder
  //
  //  Vendored from qrcode-generator v2.0.4 by Kazuhiko Arase (MIT).
  //    https://github.com/kazuhikoarase/qrcode-generator
  //
  //  Replaces a hand-rolled encoder that violated the QR spec at versions
  //  7+ (missing alignment patterns and version-info bits), producing
  //  outputs unscannable by MLKit/Vision-based decoders such as the
  //  flutter mobile_scanner package used by the Usernode mobile app.
  //
  //  The shim at the bottom preserves the prior QR.encode / QR.toCanvas
  //  interface used by showQrModal.
  // =====================================================================
  var QR = (function () {

    //---------------------------------------------------------------------
    //
    // QR Code Generator for JavaScript
    //
    // Copyright (c) 2009 Kazuhiko Arase
    //
    // URL: http://www.d-project.com/
    //
    // Licensed under the MIT license:
    //  http://www.opensource.org/licenses/mit-license.php
    //
    // The word 'QR Code' is registered trademark of
    // DENSO WAVE INCORPORATED
    //  http://www.denso-wave.com/qrcode/faqpatent-e.html
    //
    //---------------------------------------------------------------------

    var qrcode = function() {

      //---------------------------------------------------------------------
      // qrcode
      //---------------------------------------------------------------------

      /**
       * qrcode
       * @param typeNumber 1 to 40
       * @param errorCorrectionLevel 'L','M','Q','H'
       */
      var qrcode = function(typeNumber, errorCorrectionLevel) {

        var PAD0 = 0xEC;
        var PAD1 = 0x11;

        var _typeNumber = typeNumber;
        var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
        var _modules = null;
        var _moduleCount = 0;
        var _dataCache = null;
        var _dataList = [];

        var _this = {};

        var makeImpl = function(test, maskPattern) {

          _moduleCount = _typeNumber * 4 + 17;
          _modules = function(moduleCount) {
            var modules = new Array(moduleCount);
            for (var row = 0; row < moduleCount; row += 1) {
              modules[row] = new Array(moduleCount);
              for (var col = 0; col < moduleCount; col += 1) {
                modules[row][col] = null;
              }
            }
            return modules;
          }(_moduleCount);

          setupPositionProbePattern(0, 0);
          setupPositionProbePattern(_moduleCount - 7, 0);
          setupPositionProbePattern(0, _moduleCount - 7);
          setupPositionAdjustPattern();
          setupTimingPattern();
          setupTypeInfo(test, maskPattern);

          if (_typeNumber >= 7) {
            setupTypeNumber(test);
          }

          if (_dataCache == null) {
            _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
          }

          mapData(_dataCache, maskPattern);
        };

        var setupPositionProbePattern = function(row, col) {

          for (var r = -1; r <= 7; r += 1) {

            if (row + r <= -1 || _moduleCount <= row + r) continue;

            for (var c = -1; c <= 7; c += 1) {

              if (col + c <= -1 || _moduleCount <= col + c) continue;

              if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
                  || (0 <= c && c <= 6 && (r == 0 || r == 6) )
                  || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        };

        var getBestMaskPattern = function() {

          var minLostPoint = 0;
          var pattern = 0;

          for (var i = 0; i < 8; i += 1) {

            makeImpl(true, i);

            var lostPoint = QRUtil.getLostPoint(_this);

            if (i == 0 || minLostPoint > lostPoint) {
              minLostPoint = lostPoint;
              pattern = i;
            }
          }

          return pattern;
        };

        var setupTimingPattern = function() {

          for (var r = 8; r < _moduleCount - 8; r += 1) {
            if (_modules[r][6] != null) {
              continue;
            }
            _modules[r][6] = (r % 2 == 0);
          }

          for (var c = 8; c < _moduleCount - 8; c += 1) {
            if (_modules[6][c] != null) {
              continue;
            }
            _modules[6][c] = (c % 2 == 0);
          }
        };

        var setupPositionAdjustPattern = function() {

          var pos = QRUtil.getPatternPosition(_typeNumber);

          for (var i = 0; i < pos.length; i += 1) {

            for (var j = 0; j < pos.length; j += 1) {

              var row = pos[i];
              var col = pos[j];

              if (_modules[row][col] != null) {
                continue;
              }

              for (var r = -2; r <= 2; r += 1) {

                for (var c = -2; c <= 2; c += 1) {

                  if (r == -2 || r == 2 || c == -2 || c == 2
                      || (r == 0 && c == 0) ) {
                    _modules[row + r][col + c] = true;
                  } else {
                    _modules[row + r][col + c] = false;
                  }
                }
              }
            }
          }
        };

        var setupTypeNumber = function(test) {

          var bits = QRUtil.getBCHTypeNumber(_typeNumber);

          for (var i = 0; i < 18; i += 1) {
            var mod = (!test && ( (bits >> i) & 1) == 1);
            _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
          }

          for (var i = 0; i < 18; i += 1) {
            var mod = (!test && ( (bits >> i) & 1) == 1);
            _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
          }
        };

        var setupTypeInfo = function(test, maskPattern) {

          var data = (_errorCorrectionLevel << 3) | maskPattern;
          var bits = QRUtil.getBCHTypeInfo(data);

          // vertical
          for (var i = 0; i < 15; i += 1) {

            var mod = (!test && ( (bits >> i) & 1) == 1);

            if (i < 6) {
              _modules[i][8] = mod;
            } else if (i < 8) {
              _modules[i + 1][8] = mod;
            } else {
              _modules[_moduleCount - 15 + i][8] = mod;
            }
          }

          // horizontal
          for (var i = 0; i < 15; i += 1) {

            var mod = (!test && ( (bits >> i) & 1) == 1);

            if (i < 8) {
              _modules[8][_moduleCount - i - 1] = mod;
            } else if (i < 9) {
              _modules[8][15 - i - 1 + 1] = mod;
            } else {
              _modules[8][15 - i - 1] = mod;
            }
          }

          // fixed module
          _modules[_moduleCount - 8][8] = (!test);
        };

        var mapData = function(data, maskPattern) {

          var inc = -1;
          var row = _moduleCount - 1;
          var bitIndex = 7;
          var byteIndex = 0;
          var maskFunc = QRUtil.getMaskFunction(maskPattern);

          for (var col = _moduleCount - 1; col > 0; col -= 2) {

            if (col == 6) col -= 1;

            while (true) {

              for (var c = 0; c < 2; c += 1) {

                if (_modules[row][col - c] == null) {

                  var dark = false;

                  if (byteIndex < data.length) {
                    dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
                  }

                  var mask = maskFunc(row, col - c);

                  if (mask) {
                    dark = !dark;
                  }

                  _modules[row][col - c] = dark;
                  bitIndex -= 1;

                  if (bitIndex == -1) {
                    byteIndex += 1;
                    bitIndex = 7;
                  }
                }
              }

              row += inc;

              if (row < 0 || _moduleCount <= row) {
                row -= inc;
                inc = -inc;
                break;
              }
            }
          }
        };

        var createBytes = function(buffer, rsBlocks) {

          var offset = 0;

          var maxDcCount = 0;
          var maxEcCount = 0;

          var dcdata = new Array(rsBlocks.length);
          var ecdata = new Array(rsBlocks.length);

          for (var r = 0; r < rsBlocks.length; r += 1) {

            var dcCount = rsBlocks[r].dataCount;
            var ecCount = rsBlocks[r].totalCount - dcCount;

            maxDcCount = Math.max(maxDcCount, dcCount);
            maxEcCount = Math.max(maxEcCount, ecCount);

            dcdata[r] = new Array(dcCount);

            for (var i = 0; i < dcdata[r].length; i += 1) {
              dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
            }
            offset += dcCount;

            var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
            var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

            var modPoly = rawPoly.mod(rsPoly);
            ecdata[r] = new Array(rsPoly.getLength() - 1);
            for (var i = 0; i < ecdata[r].length; i += 1) {
              var modIndex = i + modPoly.getLength() - ecdata[r].length;
              ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
            }
          }

          var totalCodeCount = 0;
          for (var i = 0; i < rsBlocks.length; i += 1) {
            totalCodeCount += rsBlocks[i].totalCount;
          }

          var data = new Array(totalCodeCount);
          var index = 0;

          for (var i = 0; i < maxDcCount; i += 1) {
            for (var r = 0; r < rsBlocks.length; r += 1) {
              if (i < dcdata[r].length) {
                data[index] = dcdata[r][i];
                index += 1;
              }
            }
          }

          for (var i = 0; i < maxEcCount; i += 1) {
            for (var r = 0; r < rsBlocks.length; r += 1) {
              if (i < ecdata[r].length) {
                data[index] = ecdata[r][i];
                index += 1;
              }
            }
          }

          return data;
        };

        var createData = function(typeNumber, errorCorrectionLevel, dataList) {

          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

          var buffer = qrBitBuffer();

          for (var i = 0; i < dataList.length; i += 1) {
            var data = dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          // calc num max data.
          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i += 1) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() > totalDataCount * 8) {
            throw 'code length overflow. ('
              + buffer.getLengthInBits()
              + '>'
              + totalDataCount * 8
              + ')';
          }

          // end code
          if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
            buffer.put(0, 4);
          }

          // padding
          while (buffer.getLengthInBits() % 8 != 0) {
            buffer.putBit(false);
          }

          // padding
          while (true) {

            if (buffer.getLengthInBits() >= totalDataCount * 8) {
              break;
            }
            buffer.put(PAD0, 8);

            if (buffer.getLengthInBits() >= totalDataCount * 8) {
              break;
            }
            buffer.put(PAD1, 8);
          }

          return createBytes(buffer, rsBlocks);
        };

        _this.addData = function(data, mode) {

          mode = mode || 'Byte';

          var newData = null;

          switch(mode) {
          case 'Numeric' :
            newData = qrNumber(data);
            break;
          case 'Alphanumeric' :
            newData = qrAlphaNum(data);
            break;
          case 'Byte' :
            newData = qr8BitByte(data);
            break;
          case 'Kanji' :
            newData = qrKanji(data);
            break;
          default :
            throw 'mode:' + mode;
          }

          _dataList.push(newData);
          _dataCache = null;
        };

        _this.isDark = function(row, col) {
          if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
            throw row + ',' + col;
          }
          return _modules[row][col];
        };

        _this.getModuleCount = function() {
          return _moduleCount;
        };

        _this.make = function() {
          if (_typeNumber < 1) {
            var typeNumber = 1;

            for (; typeNumber < 40; typeNumber++) {
              var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
              var buffer = qrBitBuffer();

              for (var i = 0; i < _dataList.length; i++) {
                var data = _dataList[i];
                buffer.put(data.getMode(), 4);
                buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
                data.write(buffer);
              }

              var totalDataCount = 0;
              for (var i = 0; i < rsBlocks.length; i++) {
                totalDataCount += rsBlocks[i].dataCount;
              }

              if (buffer.getLengthInBits() <= totalDataCount * 8) {
                break;
              }
            }

            _typeNumber = typeNumber;
          }

          makeImpl(false, getBestMaskPattern() );
        };

        _this.createTableTag = function(cellSize, margin) {

          cellSize = cellSize || 2;
          margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

          var qrHtml = '';

          qrHtml += '<table style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
          qrHtml += '">';
          qrHtml += '<tbody>';

          for (var r = 0; r < _this.getModuleCount(); r += 1) {

            qrHtml += '<tr>';

            for (var c = 0; c < _this.getModuleCount(); c += 1) {
              qrHtml += '<td style="';
              qrHtml += ' border-width: 0px; border-style: none;';
              qrHtml += ' border-collapse: collapse;';
              qrHtml += ' padding: 0px; margin: 0px;';
              qrHtml += ' width: ' + cellSize + 'px;';
              qrHtml += ' height: ' + cellSize + 'px;';
              qrHtml += ' background-color: ';
              qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
              qrHtml += ';';
              qrHtml += '"/>';
            }

            qrHtml += '</tr>';
          }

          qrHtml += '</tbody>';
          qrHtml += '</table>';

          return qrHtml;
        };

        _this.createSvgTag = function(cellSize, margin, alt, title) {

          var opts = {};
          if (typeof arguments[0] == 'object') {
            // Called by options.
            opts = arguments[0];
            // overwrite cellSize and margin.
            cellSize = opts.cellSize;
            margin = opts.margin;
            alt = opts.alt;
            title = opts.title;
          }

          cellSize = cellSize || 2;
          margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

          // Compose alt property surrogate
          alt = (typeof alt === 'string') ? {text: alt} : alt || {};
          alt.text = alt.text || null;
          alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

          // Compose title property surrogate
          title = (typeof title === 'string') ? {text: title} : title || {};
          title.text = title.text || null;
          title.id = (title.text) ? title.id || 'qrcode-title' : null;

          var size = _this.getModuleCount() * cellSize + margin * 2;
          var c, mc, r, mr, qrSvg='', rect;

          rect = 'l' + cellSize + ',0 0,' + cellSize +
            ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

          qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
          qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
          qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
          qrSvg += ' preserveAspectRatio="xMinYMin meet"';
          qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
              escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
          qrSvg += '>';
          qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
              escapeXml(title.text) + '</title>' : '';
          qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
              escapeXml(alt.text) + '</description>' : '';
          qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
          qrSvg += '<path d="';

          for (r = 0; r < _this.getModuleCount(); r += 1) {
            mr = r * cellSize + margin;
            for (c = 0; c < _this.getModuleCount(); c += 1) {
              if (_this.isDark(r, c) ) {
                mc = c*cellSize+margin;
                qrSvg += 'M' + mc + ',' + mr + rect;
              }
            }
          }

          qrSvg += '" stroke="transparent" fill="black"/>';
          qrSvg += '</svg>';

          return qrSvg;
        };

        _this.createDataURL = function(cellSize, margin) {

          cellSize = cellSize || 2;
          margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;

          return createDataURL(size, size, function(x, y) {
            if (min <= x && x < max && min <= y && y < max) {
              var c = Math.floor( (x - min) / cellSize);
              var r = Math.floor( (y - min) / cellSize);
              return _this.isDark(r, c)? 0 : 1;
            } else {
              return 1;
            }
          } );
        };

        _this.createImgTag = function(cellSize, margin, alt) {

          cellSize = cellSize || 2;
          margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

          var size = _this.getModuleCount() * cellSize + margin * 2;

          var img = '';
          img += '<img';
          img += '\u0020src="';
          img += _this.createDataURL(cellSize, margin);
          img += '"';
          img += '\u0020width="';
          img += size;
          img += '"';
          img += '\u0020height="';
          img += size;
          img += '"';
          if (alt) {
            img += '\u0020alt="';
            img += escapeXml(alt);
            img += '"';
          }
          img += '/>';

          return img;
        };

        var escapeXml = function(s) {
          var escaped = '';
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charAt(i);
            switch(c) {
            case '<': escaped += '&lt;'; break;
            case '>': escaped += '&gt;'; break;
            case '&': escaped += '&amp;'; break;
            case '"': escaped += '&quot;'; break;
            default : escaped += c; break;
            }
          }
          return escaped;
        };

        var _createHalfASCII = function(margin) {
          var cellSize = 1;
          margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;

          var y, x, r1, r2, p;

          var blocks = {
            '██': '█',
            '█ ': '▀',
            ' █': '▄',
            '  ': ' '
          };

          var blocksLastLineNoMargin = {
            '██': '▀',
            '█ ': '▀',
            ' █': ' ',
            '  ': ' '
          };

          var ascii = '';
          for (y = 0; y < size; y += 2) {
            r1 = Math.floor((y - min) / cellSize);
            r2 = Math.floor((y + 1 - min) / cellSize);
            for (x = 0; x < size; x += 1) {
              p = '█';

              if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
                p = ' ';
              }

              if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
                p += ' ';
              }
              else {
                p += '█';
              }

              // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
              ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
            }

            ascii += '\n';
          }

          if (size % 2 && margin > 0) {
            return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
          }

          return ascii.substring(0, ascii.length-1);
        };

        _this.createASCII = function(cellSize, margin) {
          cellSize = cellSize || 1;

          if (cellSize < 2) {
            return _createHalfASCII(margin);
          }

          cellSize -= 1;
          margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;

          var y, x, r, p;

          var white = Array(cellSize+1).join('██');
          var black = Array(cellSize+1).join('  ');

          var ascii = '';
          var line = '';
          for (y = 0; y < size; y += 1) {
            r = Math.floor( (y - min) / cellSize);
            line = '';
            for (x = 0; x < size; x += 1) {
              p = 1;

              if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
                p = 0;
              }

              // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
              line += p ? white : black;
            }

            for (r = 0; r < cellSize; r += 1) {
              ascii += line + '\n';
            }
          }

          return ascii.substring(0, ascii.length-1);
        };

        _this.renderTo2dContext = function(context, cellSize) {
          cellSize = cellSize || 2;
          var length = _this.getModuleCount();
          for (var row = 0; row < length; row++) {
            for (var col = 0; col < length; col++) {
              context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
              context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
            }
          }
        }

        return _this;
      };

      //---------------------------------------------------------------------
      // qrcode.stringToBytes
      //---------------------------------------------------------------------

      qrcode.stringToBytesFuncs = {
        'default' : function(s) {
          var bytes = [];
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charCodeAt(i);
            bytes.push(c & 0xff);
          }
          return bytes;
        }
      };

      qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

      //---------------------------------------------------------------------
      // qrcode.createStringToBytes
      //---------------------------------------------------------------------

      /**
       * @param unicodeData base64 string of byte array.
       * [16bit Unicode],[16bit Bytes], ...
       * @param numChars
       */
      qrcode.createStringToBytes = function(unicodeData, numChars) {

        // create conversion map.

        var unicodeMap = function() {

          var bin = base64DecodeInputStream(unicodeData);
          var read = function() {
            var b = bin.read();
            if (b == -1) throw 'eof';
            return b;
          };

          var count = 0;
          var unicodeMap = {};
          while (true) {
            var b0 = bin.read();
            if (b0 == -1) break;
            var b1 = read();
            var b2 = read();
            var b3 = read();
            var k = String.fromCharCode( (b0 << 8) | b1);
            var v = (b2 << 8) | b3;
            unicodeMap[k] = v;
            count += 1;
          }
          if (count != numChars) {
            throw count + ' != ' + numChars;
          }

          return unicodeMap;
        }();

        var unknownChar = '?'.charCodeAt(0);

        return function(s) {
          var bytes = [];
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charCodeAt(i);
            if (c < 128) {
              bytes.push(c);
            } else {
              var b = unicodeMap[s.charAt(i)];
              if (typeof b == 'number') {
                if ( (b & 0xff) == b) {
                  // 1byte
                  bytes.push(b);
                } else {
                  // 2bytes
                  bytes.push(b >>> 8);
                  bytes.push(b & 0xff);
                }
              } else {
                bytes.push(unknownChar);
              }
            }
          }
          return bytes;
        };
      };

      //---------------------------------------------------------------------
      // QRMode
      //---------------------------------------------------------------------

      var QRMode = {
        MODE_NUMBER :    1 << 0,
        MODE_ALPHA_NUM : 1 << 1,
        MODE_8BIT_BYTE : 1 << 2,
        MODE_KANJI :     1 << 3
      };

      //---------------------------------------------------------------------
      // QRErrorCorrectionLevel
      //---------------------------------------------------------------------

      var QRErrorCorrectionLevel = {
        L : 1,
        M : 0,
        Q : 3,
        H : 2
      };

      //---------------------------------------------------------------------
      // QRMaskPattern
      //---------------------------------------------------------------------

      var QRMaskPattern = {
        PATTERN000 : 0,
        PATTERN001 : 1,
        PATTERN010 : 2,
        PATTERN011 : 3,
        PATTERN100 : 4,
        PATTERN101 : 5,
        PATTERN110 : 6,
        PATTERN111 : 7
      };

      //---------------------------------------------------------------------
      // QRUtil
      //---------------------------------------------------------------------

      var QRUtil = function() {

        var PATTERN_POSITION_TABLE = [
          [],
          [6, 18],
          [6, 22],
          [6, 26],
          [6, 30],
          [6, 34],
          [6, 22, 38],
          [6, 24, 42],
          [6, 26, 46],
          [6, 28, 50],
          [6, 30, 54],
          [6, 32, 58],
          [6, 34, 62],
          [6, 26, 46, 66],
          [6, 26, 48, 70],
          [6, 26, 50, 74],
          [6, 30, 54, 78],
          [6, 30, 56, 82],
          [6, 30, 58, 86],
          [6, 34, 62, 90],
          [6, 28, 50, 72, 94],
          [6, 26, 50, 74, 98],
          [6, 30, 54, 78, 102],
          [6, 28, 54, 80, 106],
          [6, 32, 58, 84, 110],
          [6, 30, 58, 86, 114],
          [6, 34, 62, 90, 118],
          [6, 26, 50, 74, 98, 122],
          [6, 30, 54, 78, 102, 126],
          [6, 26, 52, 78, 104, 130],
          [6, 30, 56, 82, 108, 134],
          [6, 34, 60, 86, 112, 138],
          [6, 30, 58, 86, 114, 142],
          [6, 34, 62, 90, 118, 146],
          [6, 30, 54, 78, 102, 126, 150],
          [6, 24, 50, 76, 102, 128, 154],
          [6, 28, 54, 80, 106, 132, 158],
          [6, 32, 58, 84, 110, 136, 162],
          [6, 26, 54, 82, 110, 138, 166],
          [6, 30, 58, 86, 114, 142, 170]
        ];
        var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
        var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
        var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

        var _this = {};

        var getBCHDigit = function(data) {
          var digit = 0;
          while (data != 0) {
            digit += 1;
            data >>>= 1;
          }
          return digit;
        };

        _this.getBCHTypeInfo = function(data) {
          var d = data << 10;
          while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
            d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
          }
          return ( (data << 10) | d) ^ G15_MASK;
        };

        _this.getBCHTypeNumber = function(data) {
          var d = data << 12;
          while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
            d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
          }
          return (data << 12) | d;
        };

        _this.getPatternPosition = function(typeNumber) {
          return PATTERN_POSITION_TABLE[typeNumber - 1];
        };

        _this.getMaskFunction = function(maskPattern) {

          switch (maskPattern) {

          case QRMaskPattern.PATTERN000 :
            return function(i, j) { return (i + j) % 2 == 0; };
          case QRMaskPattern.PATTERN001 :
            return function(i, j) { return i % 2 == 0; };
          case QRMaskPattern.PATTERN010 :
            return function(i, j) { return j % 3 == 0; };
          case QRMaskPattern.PATTERN011 :
            return function(i, j) { return (i + j) % 3 == 0; };
          case QRMaskPattern.PATTERN100 :
            return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
          case QRMaskPattern.PATTERN101 :
            return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
          case QRMaskPattern.PATTERN110 :
            return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
          case QRMaskPattern.PATTERN111 :
            return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

          default :
            throw 'bad maskPattern:' + maskPattern;
          }
        };

        _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
          var a = qrPolynomial([1], 0);
          for (var i = 0; i < errorCorrectLength; i += 1) {
            a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
          }
          return a;
        };

        _this.getLengthInBits = function(mode, type) {

          if (1 <= type && type < 10) {

            // 1 - 9

            switch(mode) {
            case QRMode.MODE_NUMBER    : return 10;
            case QRMode.MODE_ALPHA_NUM : return 9;
            case QRMode.MODE_8BIT_BYTE : return 8;
            case QRMode.MODE_KANJI     : return 8;
            default :
              throw 'mode:' + mode;
            }

          } else if (type < 27) {

            // 10 - 26

            switch(mode) {
            case QRMode.MODE_NUMBER    : return 12;
            case QRMode.MODE_ALPHA_NUM : return 11;
            case QRMode.MODE_8BIT_BYTE : return 16;
            case QRMode.MODE_KANJI     : return 10;
            default :
              throw 'mode:' + mode;
            }

          } else if (type < 41) {

            // 27 - 40

            switch(mode) {
            case QRMode.MODE_NUMBER    : return 14;
            case QRMode.MODE_ALPHA_NUM : return 13;
            case QRMode.MODE_8BIT_BYTE : return 16;
            case QRMode.MODE_KANJI     : return 12;
            default :
              throw 'mode:' + mode;
            }

          } else {
            throw 'type:' + type;
          }
        };

        _this.getLostPoint = function(qrcode) {

          var moduleCount = qrcode.getModuleCount();

          var lostPoint = 0;

          // LEVEL1

          for (var row = 0; row < moduleCount; row += 1) {
            for (var col = 0; col < moduleCount; col += 1) {

              var sameCount = 0;
              var dark = qrcode.isDark(row, col);

              for (var r = -1; r <= 1; r += 1) {

                if (row + r < 0 || moduleCount <= row + r) {
                  continue;
                }

                for (var c = -1; c <= 1; c += 1) {

                  if (col + c < 0 || moduleCount <= col + c) {
                    continue;
                  }

                  if (r == 0 && c == 0) {
                    continue;
                  }

                  if (dark == qrcode.isDark(row + r, col + c) ) {
                    sameCount += 1;
                  }
                }
              }

              if (sameCount > 5) {
                lostPoint += (3 + sameCount - 5);
              }
            }
          };

          // LEVEL2

          for (var row = 0; row < moduleCount - 1; row += 1) {
            for (var col = 0; col < moduleCount - 1; col += 1) {
              var count = 0;
              if (qrcode.isDark(row, col) ) count += 1;
              if (qrcode.isDark(row + 1, col) ) count += 1;
              if (qrcode.isDark(row, col + 1) ) count += 1;
              if (qrcode.isDark(row + 1, col + 1) ) count += 1;
              if (count == 0 || count == 4) {
                lostPoint += 3;
              }
            }
          }

          // LEVEL3

          for (var row = 0; row < moduleCount; row += 1) {
            for (var col = 0; col < moduleCount - 6; col += 1) {
              if (qrcode.isDark(row, col)
                  && !qrcode.isDark(row, col + 1)
                  &&  qrcode.isDark(row, col + 2)
                  &&  qrcode.isDark(row, col + 3)
                  &&  qrcode.isDark(row, col + 4)
                  && !qrcode.isDark(row, col + 5)
                  &&  qrcode.isDark(row, col + 6) ) {
                lostPoint += 40;
              }
            }
          }

          for (var col = 0; col < moduleCount; col += 1) {
            for (var row = 0; row < moduleCount - 6; row += 1) {
              if (qrcode.isDark(row, col)
                  && !qrcode.isDark(row + 1, col)
                  &&  qrcode.isDark(row + 2, col)
                  &&  qrcode.isDark(row + 3, col)
                  &&  qrcode.isDark(row + 4, col)
                  && !qrcode.isDark(row + 5, col)
                  &&  qrcode.isDark(row + 6, col) ) {
                lostPoint += 40;
              }
            }
          }

          // LEVEL4

          var darkCount = 0;

          for (var col = 0; col < moduleCount; col += 1) {
            for (var row = 0; row < moduleCount; row += 1) {
              if (qrcode.isDark(row, col) ) {
                darkCount += 1;
              }
            }
          }

          var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
          lostPoint += ratio * 10;

          return lostPoint;
        };

        return _this;
      }();

      //---------------------------------------------------------------------
      // QRMath
      //---------------------------------------------------------------------

      var QRMath = function() {

        var EXP_TABLE = new Array(256);
        var LOG_TABLE = new Array(256);

        // initialize tables
        for (var i = 0; i < 8; i += 1) {
          EXP_TABLE[i] = 1 << i;
        }
        for (var i = 8; i < 256; i += 1) {
          EXP_TABLE[i] = EXP_TABLE[i - 4]
            ^ EXP_TABLE[i - 5]
            ^ EXP_TABLE[i - 6]
            ^ EXP_TABLE[i - 8];
        }
        for (var i = 0; i < 255; i += 1) {
          LOG_TABLE[EXP_TABLE[i] ] = i;
        }

        var _this = {};

        _this.glog = function(n) {

          if (n < 1) {
            throw 'glog(' + n + ')';
          }

          return LOG_TABLE[n];
        };

        _this.gexp = function(n) {

          while (n < 0) {
            n += 255;
          }

          while (n >= 256) {
            n -= 255;
          }

          return EXP_TABLE[n];
        };

        return _this;
      }();

      //---------------------------------------------------------------------
      // qrPolynomial
      //---------------------------------------------------------------------

      function qrPolynomial(num, shift) {

        if (typeof num.length == 'undefined') {
          throw num.length + '/' + shift;
        }

        var _num = function() {
          var offset = 0;
          while (offset < num.length && num[offset] == 0) {
            offset += 1;
          }
          var _num = new Array(num.length - offset + shift);
          for (var i = 0; i < num.length - offset; i += 1) {
            _num[i] = num[i + offset];
          }
          return _num;
        }();

        var _this = {};

        _this.getAt = function(index) {
          return _num[index];
        };

        _this.getLength = function() {
          return _num.length;
        };

        _this.multiply = function(e) {

          var num = new Array(_this.getLength() + e.getLength() - 1);

          for (var i = 0; i < _this.getLength(); i += 1) {
            for (var j = 0; j < e.getLength(); j += 1) {
              num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
            }
          }

          return qrPolynomial(num, 0);
        };

        _this.mod = function(e) {

          if (_this.getLength() - e.getLength() < 0) {
            return _this;
          }

          var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

          var num = new Array(_this.getLength() );
          for (var i = 0; i < _this.getLength(); i += 1) {
            num[i] = _this.getAt(i);
          }

          for (var i = 0; i < e.getLength(); i += 1) {
            num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
          }

          // recursive call
          return qrPolynomial(num, 0).mod(e);
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // QRRSBlock
      //---------------------------------------------------------------------

      var QRRSBlock = function() {

        var RS_BLOCK_TABLE = [

          // L
          // M
          // Q
          // H

          // 1
          [1, 26, 19],
          [1, 26, 16],
          [1, 26, 13],
          [1, 26, 9],

          // 2
          [1, 44, 34],
          [1, 44, 28],
          [1, 44, 22],
          [1, 44, 16],

          // 3
          [1, 70, 55],
          [1, 70, 44],
          [2, 35, 17],
          [2, 35, 13],

          // 4
          [1, 100, 80],
          [2, 50, 32],
          [2, 50, 24],
          [4, 25, 9],

          // 5
          [1, 134, 108],
          [2, 67, 43],
          [2, 33, 15, 2, 34, 16],
          [2, 33, 11, 2, 34, 12],

          // 6
          [2, 86, 68],
          [4, 43, 27],
          [4, 43, 19],
          [4, 43, 15],

          // 7
          [2, 98, 78],
          [4, 49, 31],
          [2, 32, 14, 4, 33, 15],
          [4, 39, 13, 1, 40, 14],

          // 8
          [2, 121, 97],
          [2, 60, 38, 2, 61, 39],
          [4, 40, 18, 2, 41, 19],
          [4, 40, 14, 2, 41, 15],

          // 9
          [2, 146, 116],
          [3, 58, 36, 2, 59, 37],
          [4, 36, 16, 4, 37, 17],
          [4, 36, 12, 4, 37, 13],

          // 10
          [2, 86, 68, 2, 87, 69],
          [4, 69, 43, 1, 70, 44],
          [6, 43, 19, 2, 44, 20],
          [6, 43, 15, 2, 44, 16],

          // 11
          [4, 101, 81],
          [1, 80, 50, 4, 81, 51],
          [4, 50, 22, 4, 51, 23],
          [3, 36, 12, 8, 37, 13],

          // 12
          [2, 116, 92, 2, 117, 93],
          [6, 58, 36, 2, 59, 37],
          [4, 46, 20, 6, 47, 21],
          [7, 42, 14, 4, 43, 15],

          // 13
          [4, 133, 107],
          [8, 59, 37, 1, 60, 38],
          [8, 44, 20, 4, 45, 21],
          [12, 33, 11, 4, 34, 12],

          // 14
          [3, 145, 115, 1, 146, 116],
          [4, 64, 40, 5, 65, 41],
          [11, 36, 16, 5, 37, 17],
          [11, 36, 12, 5, 37, 13],

          // 15
          [5, 109, 87, 1, 110, 88],
          [5, 65, 41, 5, 66, 42],
          [5, 54, 24, 7, 55, 25],
          [11, 36, 12, 7, 37, 13],

          // 16
          [5, 122, 98, 1, 123, 99],
          [7, 73, 45, 3, 74, 46],
          [15, 43, 19, 2, 44, 20],
          [3, 45, 15, 13, 46, 16],

          // 17
          [1, 135, 107, 5, 136, 108],
          [10, 74, 46, 1, 75, 47],
          [1, 50, 22, 15, 51, 23],
          [2, 42, 14, 17, 43, 15],

          // 18
          [5, 150, 120, 1, 151, 121],
          [9, 69, 43, 4, 70, 44],
          [17, 50, 22, 1, 51, 23],
          [2, 42, 14, 19, 43, 15],

          // 19
          [3, 141, 113, 4, 142, 114],
          [3, 70, 44, 11, 71, 45],
          [17, 47, 21, 4, 48, 22],
          [9, 39, 13, 16, 40, 14],

          // 20
          [3, 135, 107, 5, 136, 108],
          [3, 67, 41, 13, 68, 42],
          [15, 54, 24, 5, 55, 25],
          [15, 43, 15, 10, 44, 16],

          // 21
          [4, 144, 116, 4, 145, 117],
          [17, 68, 42],
          [17, 50, 22, 6, 51, 23],
          [19, 46, 16, 6, 47, 17],

          // 22
          [2, 139, 111, 7, 140, 112],
          [17, 74, 46],
          [7, 54, 24, 16, 55, 25],
          [34, 37, 13],

          // 23
          [4, 151, 121, 5, 152, 122],
          [4, 75, 47, 14, 76, 48],
          [11, 54, 24, 14, 55, 25],
          [16, 45, 15, 14, 46, 16],

          // 24
          [6, 147, 117, 4, 148, 118],
          [6, 73, 45, 14, 74, 46],
          [11, 54, 24, 16, 55, 25],
          [30, 46, 16, 2, 47, 17],

          // 25
          [8, 132, 106, 4, 133, 107],
          [8, 75, 47, 13, 76, 48],
          [7, 54, 24, 22, 55, 25],
          [22, 45, 15, 13, 46, 16],

          // 26
          [10, 142, 114, 2, 143, 115],
          [19, 74, 46, 4, 75, 47],
          [28, 50, 22, 6, 51, 23],
          [33, 46, 16, 4, 47, 17],

          // 27
          [8, 152, 122, 4, 153, 123],
          [22, 73, 45, 3, 74, 46],
          [8, 53, 23, 26, 54, 24],
          [12, 45, 15, 28, 46, 16],

          // 28
          [3, 147, 117, 10, 148, 118],
          [3, 73, 45, 23, 74, 46],
          [4, 54, 24, 31, 55, 25],
          [11, 45, 15, 31, 46, 16],

          // 29
          [7, 146, 116, 7, 147, 117],
          [21, 73, 45, 7, 74, 46],
          [1, 53, 23, 37, 54, 24],
          [19, 45, 15, 26, 46, 16],

          // 30
          [5, 145, 115, 10, 146, 116],
          [19, 75, 47, 10, 76, 48],
          [15, 54, 24, 25, 55, 25],
          [23, 45, 15, 25, 46, 16],

          // 31
          [13, 145, 115, 3, 146, 116],
          [2, 74, 46, 29, 75, 47],
          [42, 54, 24, 1, 55, 25],
          [23, 45, 15, 28, 46, 16],

          // 32
          [17, 145, 115],
          [10, 74, 46, 23, 75, 47],
          [10, 54, 24, 35, 55, 25],
          [19, 45, 15, 35, 46, 16],

          // 33
          [17, 145, 115, 1, 146, 116],
          [14, 74, 46, 21, 75, 47],
          [29, 54, 24, 19, 55, 25],
          [11, 45, 15, 46, 46, 16],

          // 34
          [13, 145, 115, 6, 146, 116],
          [14, 74, 46, 23, 75, 47],
          [44, 54, 24, 7, 55, 25],
          [59, 46, 16, 1, 47, 17],

          // 35
          [12, 151, 121, 7, 152, 122],
          [12, 75, 47, 26, 76, 48],
          [39, 54, 24, 14, 55, 25],
          [22, 45, 15, 41, 46, 16],

          // 36
          [6, 151, 121, 14, 152, 122],
          [6, 75, 47, 34, 76, 48],
          [46, 54, 24, 10, 55, 25],
          [2, 45, 15, 64, 46, 16],

          // 37
          [17, 152, 122, 4, 153, 123],
          [29, 74, 46, 14, 75, 47],
          [49, 54, 24, 10, 55, 25],
          [24, 45, 15, 46, 46, 16],

          // 38
          [4, 152, 122, 18, 153, 123],
          [13, 74, 46, 32, 75, 47],
          [48, 54, 24, 14, 55, 25],
          [42, 45, 15, 32, 46, 16],

          // 39
          [20, 147, 117, 4, 148, 118],
          [40, 75, 47, 7, 76, 48],
          [43, 54, 24, 22, 55, 25],
          [10, 45, 15, 67, 46, 16],

          // 40
          [19, 148, 118, 6, 149, 119],
          [18, 75, 47, 31, 76, 48],
          [34, 54, 24, 34, 55, 25],
          [20, 45, 15, 61, 46, 16]
        ];

        var qrRSBlock = function(totalCount, dataCount) {
          var _this = {};
          _this.totalCount = totalCount;
          _this.dataCount = dataCount;
          return _this;
        };

        var _this = {};

        var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

          switch(errorCorrectionLevel) {
          case QRErrorCorrectionLevel.L :
            return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
          case QRErrorCorrectionLevel.M :
            return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
          case QRErrorCorrectionLevel.Q :
            return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
          case QRErrorCorrectionLevel.H :
            return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
          default :
            return undefined;
          }
        };

        _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

          var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

          if (typeof rsBlock == 'undefined') {
            throw 'bad rs block @ typeNumber:' + typeNumber +
                '/errorCorrectionLevel:' + errorCorrectionLevel;
          }

          var length = rsBlock.length / 3;

          var list = [];

          for (var i = 0; i < length; i += 1) {

            var count = rsBlock[i * 3 + 0];
            var totalCount = rsBlock[i * 3 + 1];
            var dataCount = rsBlock[i * 3 + 2];

            for (var j = 0; j < count; j += 1) {
              list.push(qrRSBlock(totalCount, dataCount) );
            }
          }

          return list;
        };

        return _this;
      }();

      //---------------------------------------------------------------------
      // qrBitBuffer
      //---------------------------------------------------------------------

      var qrBitBuffer = function() {

        var _buffer = [];
        var _length = 0;

        var _this = {};

        _this.getBuffer = function() {
          return _buffer;
        };

        _this.getAt = function(index) {
          var bufIndex = Math.floor(index / 8);
          return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
        };

        _this.put = function(num, length) {
          for (var i = 0; i < length; i += 1) {
            _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
          }
        };

        _this.getLengthInBits = function() {
          return _length;
        };

        _this.putBit = function(bit) {

          var bufIndex = Math.floor(_length / 8);
          if (_buffer.length <= bufIndex) {
            _buffer.push(0);
          }

          if (bit) {
            _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
          }

          _length += 1;
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // qrNumber
      //---------------------------------------------------------------------

      var qrNumber = function(data) {

        var _mode = QRMode.MODE_NUMBER;
        var _data = data;

        var _this = {};

        _this.getMode = function() {
          return _mode;
        };

        _this.getLength = function(buffer) {
          return _data.length;
        };

        _this.write = function(buffer) {

          var data = _data;

          var i = 0;

          while (i + 2 < data.length) {
            buffer.put(strToNum(data.substring(i, i + 3) ), 10);
            i += 3;
          }

          if (i < data.length) {
            if (data.length - i == 1) {
              buffer.put(strToNum(data.substring(i, i + 1) ), 4);
            } else if (data.length - i == 2) {
              buffer.put(strToNum(data.substring(i, i + 2) ), 7);
            }
          }
        };

        var strToNum = function(s) {
          var num = 0;
          for (var i = 0; i < s.length; i += 1) {
            num = num * 10 + chatToNum(s.charAt(i) );
          }
          return num;
        };

        var chatToNum = function(c) {
          if ('0' <= c && c <= '9') {
            return c.charCodeAt(0) - '0'.charCodeAt(0);
          }
          throw 'illegal char :' + c;
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // qrAlphaNum
      //---------------------------------------------------------------------

      var qrAlphaNum = function(data) {

        var _mode = QRMode.MODE_ALPHA_NUM;
        var _data = data;

        var _this = {};

        _this.getMode = function() {
          return _mode;
        };

        _this.getLength = function(buffer) {
          return _data.length;
        };

        _this.write = function(buffer) {

          var s = _data;

          var i = 0;

          while (i + 1 < s.length) {
            buffer.put(
              getCode(s.charAt(i) ) * 45 +
              getCode(s.charAt(i + 1) ), 11);
            i += 2;
          }

          if (i < s.length) {
            buffer.put(getCode(s.charAt(i) ), 6);
          }
        };

        var getCode = function(c) {

          if ('0' <= c && c <= '9') {
            return c.charCodeAt(0) - '0'.charCodeAt(0);
          } else if ('A' <= c && c <= 'Z') {
            return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
          } else {
            switch (c) {
            case ' ' : return 36;
            case '$' : return 37;
            case '%' : return 38;
            case '*' : return 39;
            case '+' : return 40;
            case '-' : return 41;
            case '.' : return 42;
            case '/' : return 43;
            case ':' : return 44;
            default :
              throw 'illegal char :' + c;
            }
          }
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // qr8BitByte
      //---------------------------------------------------------------------

      var qr8BitByte = function(data) {

        var _mode = QRMode.MODE_8BIT_BYTE;
        var _data = data;
        var _bytes = qrcode.stringToBytes(data);

        var _this = {};

        _this.getMode = function() {
          return _mode;
        };

        _this.getLength = function(buffer) {
          return _bytes.length;
        };

        _this.write = function(buffer) {
          for (var i = 0; i < _bytes.length; i += 1) {
            buffer.put(_bytes[i], 8);
          }
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // qrKanji
      //---------------------------------------------------------------------

      var qrKanji = function(data) {

        var _mode = QRMode.MODE_KANJI;
        var _data = data;

        var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
        if (!stringToBytes) {
          throw 'sjis not supported.';
        }
        !function(c, code) {
          // self test for sjis support.
          var test = stringToBytes(c);
          if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
            throw 'sjis not supported.';
          }
        }('\u53cb', 0x9746);

        var _bytes = stringToBytes(data);

        var _this = {};

        _this.getMode = function() {
          return _mode;
        };

        _this.getLength = function(buffer) {
          return ~~(_bytes.length / 2);
        };

        _this.write = function(buffer) {

          var data = _bytes;

          var i = 0;

          while (i + 1 < data.length) {

            var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

            if (0x8140 <= c && c <= 0x9FFC) {
              c -= 0x8140;
            } else if (0xE040 <= c && c <= 0xEBBF) {
              c -= 0xC140;
            } else {
              throw 'illegal char at ' + (i + 1) + '/' + c;
            }

            c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

            buffer.put(c, 13);

            i += 2;
          }

          if (i < data.length) {
            throw 'illegal char at ' + (i + 1);
          }
        };

        return _this;
      };

      //=====================================================================
      // GIF Support etc.
      //

      //---------------------------------------------------------------------
      // byteArrayOutputStream
      //---------------------------------------------------------------------

      var byteArrayOutputStream = function() {

        var _bytes = [];

        var _this = {};

        _this.writeByte = function(b) {
          _bytes.push(b & 0xff);
        };

        _this.writeShort = function(i) {
          _this.writeByte(i);
          _this.writeByte(i >>> 8);
        };

        _this.writeBytes = function(b, off, len) {
          off = off || 0;
          len = len || b.length;
          for (var i = 0; i < len; i += 1) {
            _this.writeByte(b[i + off]);
          }
        };

        _this.writeString = function(s) {
          for (var i = 0; i < s.length; i += 1) {
            _this.writeByte(s.charCodeAt(i) );
          }
        };

        _this.toByteArray = function() {
          return _bytes;
        };

        _this.toString = function() {
          var s = '';
          s += '[';
          for (var i = 0; i < _bytes.length; i += 1) {
            if (i > 0) {
              s += ',';
            }
            s += _bytes[i];
          }
          s += ']';
          return s;
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // base64EncodeOutputStream
      //---------------------------------------------------------------------

      var base64EncodeOutputStream = function() {

        var _buffer = 0;
        var _buflen = 0;
        var _length = 0;
        var _base64 = '';

        var _this = {};

        var writeEncoded = function(b) {
          _base64 += String.fromCharCode(encode(b & 0x3f) );
        };

        var encode = function(n) {
          if (n < 0) {
            // error.
          } else if (n < 26) {
            return 0x41 + n;
          } else if (n < 52) {
            return 0x61 + (n - 26);
          } else if (n < 62) {
            return 0x30 + (n - 52);
          } else if (n == 62) {
            return 0x2b;
          } else if (n == 63) {
            return 0x2f;
          }
          throw 'n:' + n;
        };

        _this.writeByte = function(n) {

          _buffer = (_buffer << 8) | (n & 0xff);
          _buflen += 8;
          _length += 1;

          while (_buflen >= 6) {
            writeEncoded(_buffer >>> (_buflen - 6) );
            _buflen -= 6;
          }
        };

        _this.flush = function() {

          if (_buflen > 0) {
            writeEncoded(_buffer << (6 - _buflen) );
            _buffer = 0;
            _buflen = 0;
          }

          if (_length % 3 != 0) {
            // padding
            var padlen = 3 - _length % 3;
            for (var i = 0; i < padlen; i += 1) {
              _base64 += '=';
            }
          }
        };

        _this.toString = function() {
          return _base64;
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // base64DecodeInputStream
      //---------------------------------------------------------------------

      var base64DecodeInputStream = function(str) {

        var _str = str;
        var _pos = 0;
        var _buffer = 0;
        var _buflen = 0;

        var _this = {};

        _this.read = function() {

          while (_buflen < 8) {

            if (_pos >= _str.length) {
              if (_buflen == 0) {
                return -1;
              }
              throw 'unexpected end of file./' + _buflen;
            }

            var c = _str.charAt(_pos);
            _pos += 1;

            if (c == '=') {
              _buflen = 0;
              return -1;
            } else if (c.match(/^\s$/) ) {
              // ignore if whitespace.
              continue;
            }

            _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
            _buflen += 6;
          }

          var n = (_buffer >>> (_buflen - 8) ) & 0xff;
          _buflen -= 8;
          return n;
        };

        var decode = function(c) {
          if (0x41 <= c && c <= 0x5a) {
            return c - 0x41;
          } else if (0x61 <= c && c <= 0x7a) {
            return c - 0x61 + 26;
          } else if (0x30 <= c && c <= 0x39) {
            return c - 0x30 + 52;
          } else if (c == 0x2b) {
            return 62;
          } else if (c == 0x2f) {
            return 63;
          } else {
            throw 'c:' + c;
          }
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // gifImage (B/W)
      //---------------------------------------------------------------------

      var gifImage = function(width, height) {

        var _width = width;
        var _height = height;
        var _data = new Array(width * height);

        var _this = {};

        _this.setPixel = function(x, y, pixel) {
          _data[y * _width + x] = pixel;
        };

        _this.write = function(out) {

          //---------------------------------
          // GIF Signature

          out.writeString('GIF87a');

          //---------------------------------
          // Screen Descriptor

          out.writeShort(_width);
          out.writeShort(_height);

          out.writeByte(0x80); // 2bit
          out.writeByte(0);
          out.writeByte(0);

          //---------------------------------
          // Global Color Map

          // black
          out.writeByte(0x00);
          out.writeByte(0x00);
          out.writeByte(0x00);

          // white
          out.writeByte(0xff);
          out.writeByte(0xff);
          out.writeByte(0xff);

          //---------------------------------
          // Image Descriptor

          out.writeString(',');
          out.writeShort(0);
          out.writeShort(0);
          out.writeShort(_width);
          out.writeShort(_height);
          out.writeByte(0);

          //---------------------------------
          // Local Color Map

          //---------------------------------
          // Raster Data

          var lzwMinCodeSize = 2;
          var raster = getLZWRaster(lzwMinCodeSize);

          out.writeByte(lzwMinCodeSize);

          var offset = 0;

          while (raster.length - offset > 255) {
            out.writeByte(255);
            out.writeBytes(raster, offset, 255);
            offset += 255;
          }

          out.writeByte(raster.length - offset);
          out.writeBytes(raster, offset, raster.length - offset);
          out.writeByte(0x00);

          //---------------------------------
          // GIF Terminator
          out.writeString(';');
        };

        var bitOutputStream = function(out) {

          var _out = out;
          var _bitLength = 0;
          var _bitBuffer = 0;

          var _this = {};

          _this.write = function(data, length) {

            if ( (data >>> length) != 0) {
              throw 'length over';
            }

            while (_bitLength + length >= 8) {
              _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
              length -= (8 - _bitLength);
              data >>>= (8 - _bitLength);
              _bitBuffer = 0;
              _bitLength = 0;
            }

            _bitBuffer = (data << _bitLength) | _bitBuffer;
            _bitLength = _bitLength + length;
          };

          _this.flush = function() {
            if (_bitLength > 0) {
              _out.writeByte(_bitBuffer);
            }
          };

          return _this;
        };

        var getLZWRaster = function(lzwMinCodeSize) {

          var clearCode = 1 << lzwMinCodeSize;
          var endCode = (1 << lzwMinCodeSize) + 1;
          var bitLength = lzwMinCodeSize + 1;

          // Setup LZWTable
          var table = lzwTable();

          for (var i = 0; i < clearCode; i += 1) {
            table.add(String.fromCharCode(i) );
          }
          table.add(String.fromCharCode(clearCode) );
          table.add(String.fromCharCode(endCode) );

          var byteOut = byteArrayOutputStream();
          var bitOut = bitOutputStream(byteOut);

          // clear code
          bitOut.write(clearCode, bitLength);

          var dataIndex = 0;

          var s = String.fromCharCode(_data[dataIndex]);
          dataIndex += 1;

          while (dataIndex < _data.length) {

            var c = String.fromCharCode(_data[dataIndex]);
            dataIndex += 1;

            if (table.contains(s + c) ) {

              s = s + c;

            } else {

              bitOut.write(table.indexOf(s), bitLength);

              if (table.size() < 0xfff) {

                if (table.size() == (1 << bitLength) ) {
                  bitLength += 1;
                }

                table.add(s + c);
              }

              s = c;
            }
          }

          bitOut.write(table.indexOf(s), bitLength);

          // end code
          bitOut.write(endCode, bitLength);

          bitOut.flush();

          return byteOut.toByteArray();
        };

        var lzwTable = function() {

          var _map = {};
          var _size = 0;

          var _this = {};

          _this.add = function(key) {
            if (_this.contains(key) ) {
              throw 'dup key:' + key;
            }
            _map[key] = _size;
            _size += 1;
          };

          _this.size = function() {
            return _size;
          };

          _this.indexOf = function(key) {
            return _map[key];
          };

          _this.contains = function(key) {
            return typeof _map[key] != 'undefined';
          };

          return _this;
        };

        return _this;
      };

      var createDataURL = function(width, height, getPixel) {
        var gif = gifImage(width, height);
        for (var y = 0; y < height; y += 1) {
          for (var x = 0; x < width; x += 1) {
            gif.setPixel(x, y, getPixel(x, y) );
          }
        }

        var b = byteArrayOutputStream();
        gif.write(b);

        var base64 = base64EncodeOutputStream();
        var bytes = b.toByteArray();
        for (var i = 0; i < bytes.length; i += 1) {
          base64.writeByte(bytes[i]);
        }
        base64.flush();

        return 'data:image/gif;base64,' + base64;
      };

      //---------------------------------------------------------------------
      // returns qrcode function.

      return qrcode;
    }();

    // multibyte support
    !function() {

      qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
        // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
        function toUTF8Array(str) {
          var utf8 = [];
          for (var i=0; i < str.length; i++) {
            var charcode = str.charCodeAt(i);
            if (charcode < 0x80) utf8.push(charcode);
            else if (charcode < 0x800) {
              utf8.push(0xc0 | (charcode >> 6),
                  0x80 | (charcode & 0x3f));
            }
            else if (charcode < 0xd800 || charcode >= 0xe000) {
              utf8.push(0xe0 | (charcode >> 12),
                  0x80 | ((charcode>>6) & 0x3f),
                  0x80 | (charcode & 0x3f));
            }
            // surrogate pair
            else {
              i++;
              // UTF-16 encodes 0x10000-0x10FFFF by
              // subtracting 0x10000 and splitting the
              // 20 bits of 0x0-0xFFFFF into two halves
              charcode = 0x10000 + (((charcode & 0x3ff)<<10)
                | (str.charCodeAt(i) & 0x3ff));
              utf8.push(0xf0 | (charcode >>18),
                  0x80 | ((charcode>>12) & 0x3f),
                  0x80 | ((charcode>>6) & 0x3f),
                  0x80 | (charcode & 0x3f));
            }
          }
          return utf8;
        }
        return toUTF8Array(s);
      };

      // Wire UTF-8 in as the default byte encoder. Without this,
      // qrcode.stringToBytes stays bound to the 'default' encoder a
      // few hundred lines up, which truncates each char to its low
      // byte (`c & 0xff`). For ASCII payloads that round-trips fine
      // (which is why the wallet-link QR worked), but any non-ASCII
      // char silently corrupts: e.g. an em-dash U+2014 becomes byte
      // 0x14 — the resulting bytes are not valid UTF-8, the mobile
      // app's jsonDecode throws, and the user sees "invalid QR code".
      // Every dapp confirmSubtitle in the fleet contains an em-dash,
      // so this hit lastwin / falling-sands / echo / opinion-market
      // 100% of the time.
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

    }();

    return {
      encode: function (text) {
        var qr = qrcode(0, 'L');
        qr.addData(text);
        qr.make();
        var size = qr.getModuleCount();
        var grid = [];
        for (var r = 0; r < size; r++) {
          grid[r] = new Uint8Array(size);
          for (var c = 0; c < size; c++) {
            grid[r][c] = qr.isDark(r, c) ? 1 : 0;
          }
        }
        return { grid: grid, size: size };
      },
      toCanvas: function (qrData, pixelSize) {
        pixelSize = pixelSize || 4;
        var quiet = 4;
        var totalSize = (qrData.size + quiet * 2) * pixelSize;
        var canvas = document.createElement("canvas");
        canvas.width = totalSize;
        canvas.height = totalSize;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, totalSize, totalSize);
        ctx.fillStyle = "#000000";
        for (var r = 0; r < qrData.size; r++) {
          for (var c = 0; c < qrData.size; c++) {
            if (qrData.grid[r][c]) {
              ctx.fillRect((c + quiet) * pixelSize, (r + quiet) * pixelSize, pixelSize, pixelSize);
            }
          }
        }
        return canvas;
      },
    };
  })();

  // =====================================================================
  //  QR Transaction Modal
  // =====================================================================
  var _qrOverlay = null;
  var _qrCancelReject = null;

  function createQrOverlayStyles() {
    if (document.getElementById("__usernode-qr-styles")) return;
    var style = document.createElement("style");
    style.id = "__usernode-qr-styles";
    style.textContent = [
      ".__un-qr-overlay{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);font-family:-apple-system,system-ui,sans-serif}",
      ".__un-qr-card{background:#1a1f2e;color:#e7edf7;border-radius:16px;padding:28px 24px;max-width:340px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4)}",
      "@media(prefers-color-scheme:light){.__un-qr-card{background:#fff;color:#0b1220;box-shadow:0 8px 32px rgba(0,0,0,0.15)}}",
      ".__un-qr-title{font-size:17px;font-weight:600;margin:0 0 4px}",
      ".__un-qr-subtitle{font-size:13px;opacity:0.7;margin:0 0 20px}",
      ".__un-qr-canvas{border-radius:12px;margin:0 auto 16px}",
      ".__un-qr-status{font-size:12px;opacity:0.6;margin:0 0 16px;min-height:16px}",
      ".__un-qr-cancel{background:none;border:1px solid rgba(255,255,255,0.2);color:inherit;border-radius:8px;padding:8px 24px;font-size:14px;cursor:pointer;opacity:0.8}",
      ".__un-qr-cancel:hover{opacity:1}",
      "@media(prefers-color-scheme:light){.__un-qr-cancel{border-color:rgba(0,0,0,0.15)}}",
    ].join("\n");
    document.head.appendChild(style);
  }

  function showQrModal(payload, opts) {
    createQrOverlayStyles();

    var title = (opts && opts.confirmTitle) || "Confirm Transaction";
    var subtitle = (opts && opts.confirmSubtitle) || "Scan this QR code with the Usernode mobile app.";
    var json = JSON.stringify(payload);
    var qrData = QR.encode(json);
    var canvas = QR.toCanvas(qrData, 5);
    canvas.className = "__un-qr-canvas";
    canvas.style.display = "block";

    var overlay = document.createElement("div");
    overlay.className = "__un-qr-overlay";

    var card = document.createElement("div");
    card.className = "__un-qr-card";

    var h = document.createElement("div");
    h.className = "__un-qr-title";
    h.textContent = title;

    var sub = document.createElement("div");
    sub.className = "__un-qr-subtitle";
    sub.textContent = subtitle;

    var status = document.createElement("div");
    status.className = "__un-qr-status";
    status.textContent = "Waiting for transaction...";
    status.id = "__un-qr-status";

    var btn = document.createElement("button");
    btn.className = "__un-qr-cancel";
    btn.textContent = "Cancel";
    btn.onclick = function () {
      hideQrModal();
      if (_qrCancelReject) {
        _qrCancelReject(new Error("User cancelled QR transaction"));
        _qrCancelReject = null;
      }
    };

    card.appendChild(h);
    card.appendChild(sub);
    card.appendChild(canvas);
    card.appendChild(status);
    card.appendChild(btn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    _qrOverlay = overlay;
  }

  function updateQrStatus(text) {
    var el = document.getElementById("__un-qr-status");
    if (el) el.textContent = text;
  }

  function hideQrModal() {
    if (_qrOverlay && _qrOverlay.parentNode) {
      _qrOverlay.parentNode.removeChild(_qrOverlay);
    }
    _qrOverlay = null;
  }

  // ── QR sendTransaction ─────────────────────────────────────────────────
  function qrSendTransaction(destination_pubkey, amount, memo, opts) {
    var timeoutMs = (opts && typeof opts.timeoutMs === "number") ? opts.timeoutMs : 90000;
    var pollIntervalMs = (opts && typeof opts.pollIntervalMs === "number") ? opts.pollIntervalMs : 2000;

    var payload = {
      type: "tx",
      to: destination_pubkey,
      amount: typeof amount === "number" ? amount : parseInt(amount, 10),
      memo: memo || "",
    };
    if (opts && opts.confirmTitle) payload.confirmTitle = opts.confirmTitle;
    if (opts && opts.confirmSubtitle) payload.confirmSubtitle = opts.confirmSubtitle;

    return new Promise(function (resolve, reject) {
      _qrCancelReject = reject;

      showQrModal(payload, opts);

      var startedAt = Date.now();
      var attempt = 0;
      var stopped = false;

      function pollForTx() {
        if (stopped) return;
        attempt++;

        var query = { limit: 50, account: destination_pubkey };

        window.getTransactions(query).then(function (resp) {
          if (stopped) return;
          var items = normalizeTransactionsResponse(resp);

          for (var i = 0; i < items.length; i++) {
            var tx = items[i];
            var txTime = extractTxTimestampMs(tx);
            if (txTime && txTime < startedAt - 10000) continue;

            var txMemo = tx.memo == null ? null : String(tx.memo);
            var txDest = pickFirst(tx, ["destination_pubkey", "destination", "to"]);
            if (txDest && String(txDest) === destination_pubkey && txMemo === (memo || "")) {
              stopped = true;
              hideQrModal();
              _qrCancelReject = null;
              console.log("[usernode-bridge] QR tx confirmed after", attempt, "polls");
              resolve({ queued: true, tx: tx });
              return;
            }
          }

          if (attempt <= 3 || attempt % 10 === 0) {
            updateQrStatus("Waiting for transaction... (" + Math.round((Date.now() - startedAt) / 1000) + "s)");
          }

          if (Date.now() - startedAt >= timeoutMs) {
            stopped = true;
            hideQrModal();
            _qrCancelReject = null;
            resolve({ queued: true, tx: null });
            return;
          }

          setTimeout(pollForTx, pollIntervalMs);
        }).catch(function (err) {
          if (stopped) return;
          console.warn("[usernode-bridge] QR poll error:", err.message);
          if (Date.now() - startedAt >= timeoutMs) {
            stopped = true;
            hideQrModal();
            _qrCancelReject = null;
            resolve({ queued: true, tx: null });
            return;
          }
          setTimeout(pollForTx, pollIntervalMs);
        });
      }

      setTimeout(pollForTx, 1000);
    });
  }

  // =====================================================================
  //  Public API: getNodeAddress
  // =====================================================================
  if (typeof window.getNodeAddress !== "function") {
    if (window.usernode.isNative) {
      window.getNodeAddress = function getNodeAddress() {
        return callNative("getNodeAddress");
      };
    } else {
      window.getNodeAddress = function getNodeAddress() {
        if (_configuredAddress) return Promise.resolve(_configuredAddress);
        return Promise.resolve(
          window.localStorage.getItem("usernode:mockAddress") ||
          getOrCreateMockPubkey()
        );
      };
    }
  }

  // =====================================================================
  //  Public API: sendTransaction
  // =====================================================================
  if (typeof window.sendTransaction !== "function") {
    function mockSendTransaction(destination_pubkey, amount, memo, opts) {
      var startedAt = Date.now();
      return fetch("/__mock/sendTransaction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from_pubkey: null, // filled below
          destination_pubkey: destination_pubkey,
          amount: amount,
          memo: memo,
        }),
      }).then(function () {
        return window.getNodeAddress();
      }).then(function (addr) {
        return fetch("/__mock/sendTransaction", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            from_pubkey: addr,
            destination_pubkey: destination_pubkey,
            amount: amount,
            memo: memo,
          }),
        });
      }).then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (text) {
            if (resp.status === 404) {
              throw new Error("Mock API not enabled. Start server with `node server.js --local-dev`.");
            }
            throw new Error("Mock sendTransaction failed (" + resp.status + "): " + text);
          });
        }
        return resp.json();
      }).then(function (sendResult) {
        var sendFailed = sendResult && (sendResult.error || sendResult.queued === false);
        var shouldWait =
          !sendFailed && (!opts || opts.waitForInclusion == null ? true : !!opts.waitForInclusion);
        if (!shouldWait) {
          if (!sendFailed) {
            window.getNodeAddress().then(function (from) {
              _openPassiveSseTelemetry({
                txId: extractTxId(sendResult),
                minCreatedAtMs: startedAt,
                memo: memo == null ? null : String(memo),
                destination_pubkey: destination_pubkey == null ? null : String(destination_pubkey),
                from_pubkey: from ? String(from).trim() : null,
                amount: amount,
              }, opts);
            }).catch(function () {});
          }
          return sendResult;
        }
        return window.getNodeAddress().then(function (from) {
          var txId = extractTxId(sendResult);
          return waitForTransactionVisible({
            txId: txId,
            minCreatedAtMs: startedAt,
            memo: memo == null ? null : String(memo),
            destination_pubkey: destination_pubkey == null ? null : String(destination_pubkey),
            from_pubkey: from ? String(from).trim() : null,
            amount: amount,
          }, opts).then(function (matchedTx) {
            return attachMatchedTx(sendResult, matchedTx);
          });
        });
      });
    }

    // Rewrite mockSendTransaction to actually work (the above double-fetch was wrong)
    mockSendTransaction = function mockSendTransaction(destination_pubkey, amount, memo, opts) {
      var startedAt = Date.now();
      return window.getNodeAddress().then(function (addr) {
        return fetch("/__mock/sendTransaction", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            from_pubkey: addr,
            destination_pubkey: destination_pubkey,
            amount: amount,
            memo: memo,
          }),
        });
      }).then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (text) {
            if (resp.status === 404) {
              throw new Error("Mock API not enabled. Start server with `node server.js --local-dev`.");
            }
            throw new Error("Mock sendTransaction failed (" + resp.status + "): " + text);
          });
        }
        return resp.json();
      }).then(function (sendResult) {
        var sendFailed = sendResult && (sendResult.error || sendResult.queued === false);
        // Mock backend resolved; surface this to callers so they can reset
        // send-phase timers, matching native/QR semantics.
        if (!sendFailed && opts && typeof opts.onSubmitted === "function") {
          try { opts.onSubmitted(sendResult); } catch (e) {
            console.warn("[usernode-bridge] onSubmitted threw:", e);
          }
        }
        var shouldWait =
          !sendFailed && (!opts || opts.waitForInclusion == null ? true : !!opts.waitForInclusion);
        if (!shouldWait) {
          if (!sendFailed) {
            window.getNodeAddress().then(function (from) {
              _openPassiveSseTelemetry({
                txId: extractTxId(sendResult),
                minCreatedAtMs: startedAt,
                memo: memo == null ? null : String(memo),
                destination_pubkey: destination_pubkey == null ? null : String(destination_pubkey),
                from_pubkey: from ? String(from).trim() : null,
                amount: amount,
              }, opts);
            }).catch(function () {});
          }
          return sendResult;
        }
        return window.getNodeAddress().then(function (from) {
          var txId = extractTxId(sendResult);
          return waitForTransactionVisible({
            txId: txId,
            minCreatedAtMs: startedAt,
            memo: memo == null ? null : String(memo),
            destination_pubkey: destination_pubkey == null ? null : String(destination_pubkey),
            from_pubkey: from ? String(from).trim() : null,
            amount: amount,
          }, opts).then(function (matchedTx) {
            return attachMatchedTx(sendResult, matchedTx);
          });
        });
      });
    };

    function nativeSendTransaction(destination_pubkey, amount, memo, opts) {
      var startedAt = Date.now();
      var from_pubkey;
      return window.getNodeAddress().then(function (v) {
        from_pubkey = v == null ? null : String(v).trim();
        return callNative("sendTransaction", {
          destination_pubkey: destination_pubkey,
          amount: amount,
          memo: memo,
          confirm_title: (opts && opts.confirmTitle) || undefined,
          confirm_subtitle: (opts && opts.confirmSubtitle) || undefined,
        });
      }).then(function (sendResult) {
        var sendError = sendResult && sendResult.error;
        if (sendError) throw new Error(String(sendError));
        // Native channel resolved: the user has accepted the wallet dialog and
        // Flutter has begun broadcasting. Fire onSubmitted so callers can reset
        // send-phase timers (parity with the QR-mode "scanned" moment).
        if (opts && typeof opts.onSubmitted === "function") {
          try { opts.onSubmitted(sendResult); } catch (e) {
            console.warn("[usernode-bridge] onSubmitted threw:", e);
          }
        }
        var sendFailed = sendResult && sendResult.queued === false;
        var shouldWait =
          !sendFailed && (!opts || opts.waitForInclusion == null ? true : !!opts.waitForInclusion);
        if (!shouldWait) {
          if (!sendFailed) {
            _openPassiveSseTelemetry({
              txId: extractTxId(sendResult),
              minCreatedAtMs: startedAt,
              memo: memo == null ? null : String(memo),
              destination_pubkey: destination_pubkey == null ? null : String(destination_pubkey),
              from_pubkey: from_pubkey || null,
              amount: amount,
            }, opts);
          }
          return sendResult;
        }
        var txId = extractTxId(sendResult);
        return waitForTransactionVisible({
          txId: txId,
          minCreatedAtMs: startedAt,
          memo: memo == null ? null : String(memo),
          destination_pubkey: destination_pubkey == null ? null : String(destination_pubkey),
          from_pubkey: from_pubkey || null,
          amount: amount,
        }, opts).then(function (matchedTx) {
          return attachMatchedTx(sendResult, matchedTx);
        });
      });
    }

    window.sendTransaction = function sendTransaction(destination_pubkey, amount, memo, opts) {
      return isMockEnabled().then(function (useMock) {
        var branch = useMock ? "mock" :
          (window.usernode.isNative ? "native" : "qr");
        console.log(_BRIDGE_TAG, "sendTransaction → branch=" + branch,
          "isNative=" + !!window.usernode.isNative,
          "useMock=" + useMock);
        if (useMock) return mockSendTransaction(destination_pubkey, amount, memo, opts);
        if (window.usernode.isNative) return nativeSendTransaction(destination_pubkey, amount, memo, opts);
        return qrSendTransaction(destination_pubkey, amount, memo, opts);
      });
    };
  }

  // =====================================================================
  //  Public API: getTransactions
  // =====================================================================
  if (typeof window.getTransactions !== "function") {
    function mockGetTransactions(filterOptions) {
      return window.getNodeAddress().then(function (addr) {
        var ownerPubkey = (filterOptions && filterOptions.account) ? filterOptions.account : addr;
        return fetch("/__mock/getTransactions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            owner_pubkey: ownerPubkey,
            filterOptions: filterOptions || {},
          }),
        });
      }).then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (text) {
            if (resp.status === 404) {
              throw new Error("Mock API not enabled. Start server with `node server.js --local-dev`.");
            }
            throw new Error("Mock getTransactions failed (" + resp.status + "): " + text);
          });
        }
        return resp.json();
      });
    }

    function nativeGetTransactions(filterOptions) {
      var base = window.usernode.transactionsBaseUrl;
      if (!base) {
        return Promise.reject(new Error(
          "transactionsBaseUrl not configured (set window.usernode.transactionsBaseUrl)"
        ));
      }
      return fetch(base + "/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(filterOptions || {}),
      }).then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (text) {
            throw new Error("getTransactions failed (" + resp.status + "): " + text);
          });
        }
        return resp.json();
      });
    }

    window.getTransactions = function getTransactions(filterOptions) {
      return isMockEnabled().then(function (useMock) {
        if (useMock) return mockGetTransactions(filterOptions);
        if (window.usernode.isNative) return nativeGetTransactions(filterOptions);
        if (window.usernode.transactionsBaseUrl) return nativeGetTransactions(filterOptions);
        return mockGetTransactions(filterOptions);
      });
    };
  }

  // =====================================================================
  //  Public API: signMessage
  // =====================================================================
  if (typeof window.signMessage !== "function") {
    window.signMessage = function signMessage(message) {
      if (window.usernode.isNative) {
        return callNative("signMessage", { message: message });
      }
      return isMockEnabled().then(function (useMock) {
        if (useMock) {
          return window.getNodeAddress().then(function (pubkey) {
            return {
              pubkey: pubkey,
              signature: "mock_signature_" + btoa(message).replace(/=+$/, ""),
            };
          });
        }
        return Promise.reject(new Error(
          "signMessage is not available in QR mode. Use the Usernode mobile app directly."
        ));
      });
    };
  }

  // =====================================================================
  //  Public API: homescreen shortcuts
  //  (usernode.getHomeScreenShortcutSupport / addHomeScreenShortcut)
  // =====================================================================
  //
  // Native-only feature (Flutter WebView JS channel). Support probe
  // resolves one of:
  //   { mechanism: "pinned-shortcut" }                 — Android launcher pin
  //   { mechanism: "widget", widgetInstalled: bool }   — iOS WidgetKit grid
  //   { mechanism: "unsupported" }                     — everywhere else
  //
  // Older app builds silently drop unknown JS-channel methods (the
  // promise would hang forever), so the probe is raced against a short
  // timeout that resolves as unsupported instead of rejecting. Callers
  // can therefore always `await` this and branch on `mechanism`.
  var _SHORTCUT_PROBE_TIMEOUT_MS = 4000;

  window.usernode.getHomeScreenShortcutSupport = function () {
    if (!window.usernode.isNative) {
      return Promise.resolve({ mechanism: "unsupported" });
    }
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        console.log(_BRIDGE_TAG, "getHomeScreenShortcutSupport probe timed" +
          " out (app build predates the feature?) — reporting unsupported");
        resolve({ mechanism: "unsupported" });
      }, _SHORTCUT_PROBE_TIMEOUT_MS);
      callNative("getHomeScreenShortcutSupport", {}).then(
        function (support) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(support && support.mechanism
            ? support
            : { mechanism: "unsupported" });
        },
        function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          console.warn(_BRIDGE_TAG, "getHomeScreenShortcutSupport failed:",
            err && err.message);
          resolve({ mechanism: "unsupported" });
        }
      );
    });
  };

  // addHomeScreenShortcut({ name, url, icon_url }) asks the app to add a
  // homescreen entry that reopens `url` inside the Usernode app. The app
  // shows its own native confirmation UI. Resolves the app's result
  // object ({ added: bool, mechanism, ... }); rejects when the user
  // declines or the environment has no native channel.
  window.usernode.addHomeScreenShortcut = function (opts) {
    opts = opts || {};
    if (!opts.name || !opts.url) {
      return Promise.reject(new Error(
        "addHomeScreenShortcut requires { name, url }"
      ));
    }
    if (!window.usernode.isNative) {
      return Promise.reject(new Error(
        "Homescreen shortcuts are only available inside the Usernode mobile app."
      ));
    }
    return callNative("addHomeScreenShortcut", {
      name: opts.name,
      url: opts.url,
      icon_url: opts.icon_url || null,
      // Background refresh (e.g. re-sending a missing widget icon): the
      // app skips user-facing follow-ups like the add-the-widget
      // walkthrough.
      silent: opts.silent === true,
    });
  };

  // Shortcut-registry management (widget grid on iOS). Same old-build
  // hazard as the support probe: app builds that predate a method silently
  // drop it, so each call races a timeout instead of hanging forever.
  //
  //   getHomeScreenShortcuts()        → { mechanism, items: [{id, name,
  //                                       url, pinnedAtMs}] } or null when
  //                                       the app can't answer (old build /
  //                                       no native channel) — callers
  //                                       should hide management UI on null.
  //   removeHomeScreenShortcut(id)    → { removed: true }; rejects on
  //                                       timeout/error.
  //   reorderHomeScreenShortcuts(ids) → { order: [ids...] }; unknown ids
  //                                       ignored, missing ids appended.
  function callNativeShortcutMgmt(method, args, onTimeout) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        console.warn(_BRIDGE_TAG, method, "timed out (old app build?)");
        onTimeout(resolve, reject);
      }, _SHORTCUT_PROBE_TIMEOUT_MS);
      callNative(method, args).then(
        function (v) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  window.usernode.getHomeScreenShortcuts = function () {
    if (!window.usernode.isNative) return Promise.resolve(null);
    return callNativeShortcutMgmt("getHomeScreenShortcuts", {}, function (resolve) {
      resolve(null);
    });
  };

  window.usernode.removeHomeScreenShortcut = function (id) {
    if (!id) {
      return Promise.reject(new Error("removeHomeScreenShortcut requires an id"));
    }
    if (!window.usernode.isNative) {
      return Promise.reject(new Error(
        "Homescreen shortcuts are only available inside the Usernode mobile app."
      ));
    }
    return callNativeShortcutMgmt(
      "removeHomeScreenShortcut", { id: id },
      function (_resolve, reject) {
        reject(new Error("removeHomeScreenShortcut is not supported by this app build"));
      }
    );
  };

  window.usernode.reorderHomeScreenShortcuts = function (ids) {
    if (!Array.isArray(ids)) {
      return Promise.reject(new Error("reorderHomeScreenShortcuts requires an array of ids"));
    }
    if (!window.usernode.isNative) {
      return Promise.reject(new Error(
        "Homescreen shortcuts are only available inside the Usernode mobile app."
      ));
    }
    return callNativeShortcutMgmt(
      "reorderHomeScreenShortcuts", { ids: ids },
      function (_resolve, reject) {
        reject(new Error("reorderHomeScreenShortcuts is not supported by this app build"));
      }
    );
  };

  // =====================================================================
  //  Public API: native chrome data (bridge v2)
  //  (usernode.getBridgeInfo / getNodeStatus / getWalletState /
  //   getTransactionRecords / openNativeScreen)
  // =====================================================================
  //
  // Data feeds for SV's web chrome (header node pill, wallet sheet,
  // receipts) when running inside the Usernode app — the app-as-SV-chrome
  // migration. Versioned contract: NATIVE-BRIDGE.md in the
  // social-vibecoding repo. Same old-build hazard as the shortcut
  // methods (unknown methods are silently dropped), so every read
  // resolves a safe fallback on timeout instead of hanging or rejecting
  // — callers can always `await` and render "unavailable".

  var _CHROME_PROBE_TIMEOUT_MS = 4000;
  // getWalletState may legitimately take ~10s on a fresh app start (the
  // native wallet provider waits for the node); don't cut it off early.
  var _WALLET_STATE_TIMEOUT_MS = 12000;

  function callNativeChromeRead(method, args, timeoutMs, fallbackValue) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        console.log(_BRIDGE_TAG, method, "timed out (old app build?)");
        resolve(fallbackValue);
      }, timeoutMs);
      callNative(method, args).then(
        function (v) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          console.warn(_BRIDGE_TAG, method, "failed:", err && err.message);
          resolve(fallbackValue);
        }
      );
    });
  }

  // getBridgeInfo() → { version, capabilities: [...] }. Resolves
  // { version: 0, capabilities: [] } outside the app and on old builds,
  // so chrome can always `await` it and gate UI on capabilities
  // (`capabilities.includes('getNodeStatus')` etc), never on version.
  window.usernode.getBridgeInfo = function () {
    var empty = { version: 0, capabilities: [] };
    if (!window.usernode.isNative) return Promise.resolve(empty);
    return callNativeChromeRead(
      "getBridgeInfo", {}, _CHROME_PROBE_TIMEOUT_MS, empty
    ).then(function (info) {
      return info && Array.isArray(info.capabilities) ? info : empty;
    });
  };

  // getNodeStatus() → { status: "synced"|"syncing"|"connecting"|"offline",
  //   localBestHeight, networkBestHeight, connectedPeers, totalPeers }
  // or null. The app also pushes the same snapshot as a
  // `usernode:node-status` CustomEvent on window (once per page load and
  // on pill-state transitions) — prefer the event stream over polling.
  window.usernode.getNodeStatus = function () {
    if (!window.usernode.isNative) return Promise.resolve(null);
    return callNativeChromeRead(
      "getNodeStatus", {}, _CHROME_PROBE_TIMEOUT_MS, null
    );
  };

  // getWalletState() → { address, balance (base units, string),
  //   tokenAmount, tokenSymbol, lastUpdatedMs } or null.
  window.usernode.getWalletState = function () {
    if (!window.usernode.isNative) return Promise.resolve(null);
    return callNativeChromeRead(
      "getWalletState", {}, _WALLET_STATE_TIMEOUT_MS, null
    );
  };

  // getTransactionRecords() → { items: [...] } (newest first, capped at
  // 100) or null. The app-side receipts for transactions sent from this
  // webview — the same data behind the native receipts sheet.
  window.usernode.getTransactionRecords = function () {
    if (!window.usernode.isNative) return Promise.resolve(null);
    return callNativeChromeRead(
      "getTransactionRecords", {}, _CHROME_PROBE_TIMEOUT_MS, null
    );
  };

  // openNativeScreen(screen) → true. Pushes an allowlisted native route
  // ("settings" | "profile"). Unlike the reads above this REJECTS on old
  // builds / non-native — a silent no-op would strand the user's tap.
  // The app additionally refuses callers that aren't the SV top frame.
  window.usernode.openNativeScreen = function (screen) {
    if (!screen) {
      return Promise.reject(new Error("openNativeScreen requires a screen"));
    }
    if (!window.usernode.isNative) {
      return Promise.reject(new Error(
        "openNativeScreen is only available inside the Usernode mobile app."
      ));
    }
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error(
          "openNativeScreen is not supported by this app build"
        ));
      }, _CHROME_PROBE_TIMEOUT_MS);
      callNative("openNativeScreen", { screen: screen }).then(
        function (v) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  };

  // =====================================================================
  //  Public API: native profile & settings (bridge v3)
  //  (usernode.getProfileInfo / getSettingsState / setNodeSleepEnabled /
  //   setDebugMode / setFacematchStrict / resetZkChallenge /
  //   requestPermissions / openBatterySettings / setIosKeepAlive /
  //   logout)
  // =====================================================================
  //
  // Backs SV's #profile screen and the "Usernode app" sections of the
  // Settings modal (profile-and-settings-to-web migration). Contract:
  // NATIVE-BRIDGE.md. Reads resolve null on old builds / outside the app
  // so callers can capability-gate UI; mutations REJECT on old builds —
  // a silent no-op would leave a toggle lying about its state. The app
  // additionally refuses callers that aren't the SV top frame.

  // getSettingsState assembles platform-permission probes plus native
  // provider reads (the terms lookup alone can take ~5s on a cold
  // start), and every setter resolves the same refreshed snapshot — so
  // they all share this budget rather than the short probe timeout.
  var _SETTINGS_STATE_TIMEOUT_MS = 12000;
  // requestPermissions blocks on an OS permission dialog the user may
  // ponder for a while; the ceiling here is purely defensive.
  var _PERMISSION_REQUEST_TIMEOUT_MS = 120000;

  function callNativeChromeAction(method, args, timeoutMs) {
    if (!window.usernode.isNative) {
      return Promise.reject(new Error(
        method + " is only available inside the Usernode mobile app."
      ));
    }
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error(method + " is not supported by this app build"));
      }, timeoutMs);
      callNative(method, args).then(
        function (v) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  // getProfileInfo() → { participantId } or null (old build / outside
  // the app). participantId is null when this install hasn't registered
  // with the leaderboard yet.
  window.usernode.getProfileInfo = function () {
    if (!window.usernode.isNative) return Promise.resolve(null);
    return callNativeChromeRead(
      "getProfileInfo", {}, _CHROME_PROBE_TIMEOUT_MS, null
    );
  };

  // getSettingsState() → { buildInfo: { appVersion, buildNumber,
  //   nodeVersion, commitHash, branch }, nodeSleepEnabled, debugMode,
  //   facematchStrict, termsAccepted, authStatus,
  //   permissions: { platform, exactAlarmGranted, batteryOptDisabled,
  //   deviceManufacturer, iosKeepAliveActive } } or null.
  window.usernode.getSettingsState = function () {
    if (!window.usernode.isNative) return Promise.resolve(null);
    return callNativeChromeRead(
      "getSettingsState", {}, _SETTINGS_STATE_TIMEOUT_MS, null
    );
  };

  // Toggle setters. Each resolves the refreshed settings state (same
  // shape as getSettingsState) so callers re-render from one source of
  // truth instead of assuming the write landed.
  window.usernode.setNodeSleepEnabled = function (enabled) {
    return callNativeChromeAction(
      "setNodeSleepEnabled", { enabled: !!enabled },
      _SETTINGS_STATE_TIMEOUT_MS
    );
  };

  window.usernode.setDebugMode = function (enabled) {
    return callNativeChromeAction(
      "setDebugMode", { enabled: !!enabled }, _SETTINGS_STATE_TIMEOUT_MS
    );
  };

  window.usernode.setFacematchStrict = function (enabled) {
    return callNativeChromeAction(
      "setFacematchStrict", { enabled: !!enabled },
      _SETTINGS_STATE_TIMEOUT_MS
    );
  };

  // setIosKeepAlive(enabled) → refreshed settings state. iOS only; the
  // app ignores it elsewhere (state simply won't change).
  window.usernode.setIosKeepAlive = function (enabled) {
    return callNativeChromeAction(
      "setIosKeepAlive", { enabled: !!enabled }, _SETTINGS_STATE_TIMEOUT_MS
    );
  };

  // resetZkChallenge() → true. Destructive: confirmation is the
  // caller's job (web-side confirm, native commit).
  window.usernode.resetZkChallenge = function () {
    return callNativeChromeAction(
      "resetZkChallenge", {}, _SETTINGS_STATE_TIMEOUT_MS
    );
  };

  // requestPermissions() → refreshed settings state plus { granted }.
  // May pend on an OS permission dialog.
  window.usernode.requestPermissions = function () {
    return callNativeChromeAction(
      "requestPermissions", {}, _PERMISSION_REQUEST_TIMEOUT_MS
    );
  };

  // openBatterySettings() → true. Android: opens the system battery
  // optimization settings for the app.
  window.usernode.openBatterySettings = function () {
    return callNativeChromeAction(
      "openBatterySettings", {}, _CHROME_PROBE_TIMEOUT_MS
    );
  };

  // logout() → true. Confirm web-side; the post-logout auth flow stays
  // native chrome (same category as onboarding).
  window.usernode.logout = function () {
    return callNativeChromeAction("logout", {}, _SETTINGS_STATE_TIMEOUT_MS);
  };

  // =====================================================================
  //  Public API: LLM access (usernode.requestLlmAccess / getLlmAccess /
  //  getLlmUsage)
  // =====================================================================
  //
  // Consent flow for the platform's app-LLM proxy (issue #34). These do
  // NOT ride the native relay above — they target the Usernode Social
  // Vibecoding shell (the parent page owning the app iframe), which
  // listens for the distinct `__usernode_llm` message family and opens
  // a platform-owned consent dialog. An app cannot approve itself.
  //
  //   usernode.getLlmAccess()      → { granted, dailyCapCents?, allowByok? }
  //       read-only: the current user's grant state for this app.
  //   usernode.requestLlmAccess()  → same shape (plus declined: true
  //       when the user picked "Not now"); opens the consent dialog
  //       when no active grant exists.
  //   usernode.getLlmUsage()       → { granted: true, spentCentsToday,
  //       dailyCapCents } or { granted: false } (issue #655) —
  //       read-only usage meter: today's per-app spend vs the cap.
  //       spentCentsToday may be fractional cents and is
  //       approximately real-time. Never opens the consent dialog.
  //
  // All reject on a short ack-timeout when there is no parent shell
  // (standalone page, non-SV host, or an old shell that predates the
  // feature). After the shell acks, requestLlmAccess waits much longer
  // — the user is reading a dialog.
  //
  // Recommended app pattern: the app SERVER calls the proxy
  // (USERNODE_LLM_PROXY_URL) and surfaces its 403 grant_required to the
  // frontend, which calls usernode.requestLlmAccess() and retries.
  (function () {
    var _LLM_ACK_TIMEOUT_MS = 15000;
    var _LLM_DECISION_TIMEOUT_MS = 5 * 60 * 1000;
    var _llmPending = {};

    window.addEventListener("message", function (e) {
      if (e.source !== window.parent) return;
      var data = e.data;
      if (!data || !data.__usernode_llm || !data.id) return;
      var entry = _llmPending[data.id];
      if (!entry) return;
      if (data.__usernode_llm === "ack") {
        // Shell received the request; the user may take a while now.
        if (entry.ackTimer) { clearTimeout(entry.ackTimer); entry.ackTimer = null; }
        return;
      }
      if (data.__usernode_llm === "response") {
        delete _llmPending[data.id];
        if (entry.ackTimer) clearTimeout(entry.ackTimer);
        if (entry.timer) clearTimeout(entry.timer);
        if (data.error) entry.reject(new Error(data.error));
        else entry.resolve(data.value);
      }
    });

    function llmCall(type) {
      return new Promise(function (resolve, reject) {
        if (window === window.parent) {
          reject(new Error(
            "LLM access requires the Usernode platform shell (not available standalone)."
          ));
          return;
        }
        var id = "llm-" + String(Date.now()) + "-" +
          Math.random().toString(16).slice(2);
        var entry = { resolve: resolve, reject: reject, ackTimer: null, timer: null };
        _llmPending[id] = entry;
        entry.ackTimer = setTimeout(function () {
          if (!_llmPending[id]) return;
          delete _llmPending[id];
          if (entry.timer) clearTimeout(entry.timer);
          reject(new Error(
            "Usernode shell did not respond — not running inside the platform, " +
            "or the host page predates LLM access."
          ));
        }, _LLM_ACK_TIMEOUT_MS);
        entry.timer = setTimeout(function () {
          if (!_llmPending[id]) return;
          delete _llmPending[id];
          if (entry.ackTimer) clearTimeout(entry.ackTimer);
          reject(new Error("LLM access request timed out."));
        }, _LLM_DECISION_TIMEOUT_MS);
        try {
          console.log(_BRIDGE_TAG, "llm → parent:", type, "id", id);
          window.parent.postMessage({ __usernode_llm: type, id: id }, "*");
        } catch (err) {
          delete _llmPending[id];
          if (entry.ackTimer) clearTimeout(entry.ackTimer);
          if (entry.timer) clearTimeout(entry.timer);
          reject(err);
        }
      });
    }

    if (typeof window.usernode.requestLlmAccess !== "function") {
      window.usernode.requestLlmAccess = function requestLlmAccess() {
        return llmCall("request-access");
      };
    }
    if (typeof window.usernode.getLlmAccess !== "function") {
      window.usernode.getLlmAccess = function getLlmAccess() {
        return llmCall("get-access");
      };
    }
    if (typeof window.usernode.getLlmUsage !== "function") {
      window.usernode.getLlmUsage = function getLlmUsage() {
        return llmCall("get-usage");
      };
    }
  })();

  // =====================================================================
  //  Public API: user locale (usernode.getUserLocale) — additive within v1
  // =====================================================================
  //
  // Platform-level user language preference (SV issue #757). The user
  // picks a language once in the platform's Settings; apps read it as
  // their DEFAULT locale instead of guessing from navigator.language.
  //
  //   usernode.getUserLocale() → { locale: "id" } or { locale: null }
  //       when the user has no platform preference set. NEVER rejects —
  //       a null answer is meaningful ("auto — use device language").
  //
  // Like the LLM family above, this targets the SV shell (the parent
  // page owning the app iframe) via a distinct `__usernode_locale`
  // message family — the shell answers instantly from its cached user,
  // so there is no ack stage, just a short timeout. Fallbacks, in order:
  // the `locale` claim of the iframe's `?token=` JWT (captured at script
  // load — SPA routers rewrite location.search later), then null. No
  // signature verification on the fallback — same display-level-reads
  // rationale as autoConfigureFromIframeToken above.
  //
  // The shell also PUSHES changes: when the user switches language in
  // the platform Settings while an app is open, the shell posts
  // { __usernode_locale: "changed", locale } and the bridge re-dispatches
  // it as a `usernode:locale-changed` CustomEvent on window with
  // detail { locale } (same convention as `usernode:node-status`).
  // Apps following the platform default should listen and re-render.
  (function () {
    var _LOCALE_TIMEOUT_MS = 3000;
    var _localePending = {};

    // Capture the JWT `locale` claim once at load (mirrors
    // autoConfigureFromIframeToken — kept separate so that path stays
    // untouched).
    var _tokenLocale = null;
    try {
      if (typeof location !== "undefined" && location.search) {
        var _lp = new URLSearchParams(location.search);
        var _ltok = _lp.get("token");
        if (_ltok) {
          var _lparts = _ltok.split(".");
          if (_lparts.length >= 2) {
            var _lpayload = _lparts[1].replace(/-/g, "+").replace(/_/g, "/");
            while (_lpayload.length % 4) _lpayload += "=";
            var _ldecoded = JSON.parse(atob(_lpayload));
            if (_ldecoded && typeof _ldecoded.locale === "string" && _ldecoded.locale.trim()) {
              _tokenLocale = _ldecoded.locale.trim();
            }
          }
        }
      }
    } catch (_) { /* ignore parse errors — fall through to null */ }

    window.addEventListener("message", function (e) {
      if (e.source !== window.parent) return;
      var data = e.data;
      if (!data || !data.__usernode_locale) return;
      if (data.__usernode_locale === "changed") {
        try {
          window.dispatchEvent(new CustomEvent("usernode:locale-changed", {
            detail: { locale: typeof data.locale === "string" ? data.locale : null },
          }));
        } catch (_) {}
        return;
      }
      if (data.__usernode_locale === "response" && data.id) {
        var entry = _localePending[data.id];
        if (!entry) return;
        delete _localePending[data.id];
        if (entry.timer) clearTimeout(entry.timer);
        var value = data.value && typeof data.value.locale === "string"
          ? { locale: data.value.locale }
          : { locale: null };
        entry.resolve(value);
      }
    });

    if (typeof window.usernode.getUserLocale !== "function") {
      window.usernode.getUserLocale = function getUserLocale() {
        return new Promise(function (resolve) {
          var fallback = { locale: _tokenLocale };
          if (window === window.parent) {
            // Standalone (no shell): the JWT claim is the best we have.
            resolve(fallback);
            return;
          }
          var id = "locale-" + String(Date.now()) + "-" +
            Math.random().toString(16).slice(2);
          var entry = { resolve: resolve, timer: null };
          _localePending[id] = entry;
          entry.timer = setTimeout(function () {
            if (!_localePending[id]) return;
            delete _localePending[id];
            // No shell answer (non-SV host, or a shell predating the
            // feature) — fall back to the JWT claim, then null.
            resolve(fallback);
          }, _LOCALE_TIMEOUT_MS);
          try {
            window.parent.postMessage({ __usernode_locale: "get", id: id }, "*");
          } catch (err) {
            delete _localePending[id];
            if (entry.timer) clearTimeout(entry.timer);
            resolve(fallback);
          }
        });
      };
    }
  })();

  // Rendering invariants (issue #360) — additive within v1.
  //
  // Opt-in, no-op-by-default self-checks an app registers to catch
  // structural rendering bugs (e.g. "the canvas should exactly fill the
  // window") in the live preview. A check is a function returning a
  // truthy value when the invariant holds, or `false` / a string reason
  // when it's violated. Violations are reported through the EXISTING
  // dev-console postMessage pipe (the `__usernodeDevConsole` sentinel the
  // platform shell's public/js/dev-console.js already listens for), so
  // they surface in the in-app developer console — no new channel, no
  // change to the vendored forwarder or the receiver.
  //
  // Nothing runs until at least one invariant is registered: an app that
  // registers none behaves exactly as before, at zero cost.
  /* __USERNODE_INVARIANTS_BEGIN__ */
  (function () {
    var DC_SENTINEL = "__usernodeDevConsole";
    var _invariants = []; // each: { name, fn, failing }
    var _wired = false;
    var _rafPending = false;

    function reportInvariant(level, name, reason) {
      try {
        if (!(window.parent && window.parent !== window)) return;
        window.parent.postMessage({
          sentinel: DC_SENTINEL,
          level: level,
          kind: "invariant",
          args: [name + ": " + reason],
          ts: Date.now(),
          url: location.href,
        }, "*");
      } catch (_) {}
    }

    function evaluateAll() {
      for (var i = 0; i < _invariants.length; i++) {
        var inv = _invariants[i];
        var ok = true;
        var reason = "";
        try {
          var r = inv.fn();
          // truthy non-string = pass; false = fail; string = fail w/ reason.
          if (r === true || (r && typeof r !== "string")) {
            ok = true;
          } else {
            ok = false;
            reason = typeof r === "string" ? r : "invariant failed";
          }
        } catch (err) {
          ok = false;
          reason = (err && (err.stack || err.message)) || ("threw " + String(err));
        }
        // Debounce: report only on the transition INTO failure (level
        // error → badges the dev console), and once again on recovery
        // (level info → no red badge), instead of every tick. A
        // persistently-broken invariant therefore logs once, not a flood.
        if (!ok && !inv.failing) {
          inv.failing = true;
          reportInvariant("error", inv.name, reason);
        } else if (ok && inv.failing) {
          inv.failing = false;
          reportInvariant("info", inv.name, "recovered");
        }
      }
    }

    function scheduleEval() {
      if (_rafPending) return;
      _rafPending = true;
      var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
      raf(function () {
        _rafPending = false;
        evaluateAll();
      });
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      // A "canvas fills the window" style check fires exactly when the
      // window geometry changes; the rAF coalesces bursts of resizes.
      window.addEventListener("resize", scheduleEval);
      window.addEventListener("orientationchange", scheduleEval);
    }

    if (!window.usernode.invariants) {
      window.usernode.invariants = {
        register: function register(name, fn) {
          if (typeof fn !== "function") {
            throw new Error("usernode.invariants.register(name, fn): fn must be a function");
          }
          _invariants.push({ name: String(name || "invariant"), fn: fn, failing: false });
          wireOnce();
          // Evaluate now so an invariant already violated at registration
          // time (the common case for a layout/canvas bug) reports without
          // waiting for the first resize.
          scheduleEval();
        },
      };
    }
  })();
  /* __USERNODE_INVARIANTS_END__ */

  // Issue-state snapshots (issue #685) — additive within v1.
  //
  // Opt-in API for sharing a debug snapshot of the app's internal state
  // with the platform's issue-submission flow. Like the `__usernode_llm`
  // family above, this targets the Usernode Social Vibecoding shell (the
  // parent page owning the app iframe), NOT the native relay: on
  // register the bridge announces availability to the parent, and the
  // shell asks for the snapshot at issue-filing time with a `collect`
  // request. Registering is the app's explicit opt-in — the app is
  // responsible for excluding sensitive data (snapshots land in PUBLIC
  // GitHub issue bodies).
  //
  //   usernode.issueState.register(fn)  — fn: zero-arg function
  //       returning a JSON-serializable object (or a Promise of one).
  //       Repeat calls replace the provider (last write wins).
  //   usernode.issueState.unregister() — clears the provider.
  //
  // Fully no-op by default: an app that registers nothing behaves
  // exactly as before, and standalone/top-frame pages register
  // harmlessly (there is no shell to ever ask).
  /* __USERNODE_ISSUE_STATE_BEGIN__ */
  (function () {
    // The shell waits 5 s overall; 3 s bounds the provider itself so a
    // hung provider still yields a distinguishable error, not silence.
    var _PROVIDER_TIMEOUT_MS = 3000;
    // Serialized-snapshot cap. Oversized dumps are sliced (which may
    // leave invalid JSON — acceptable: this is debugging context, not
    // machine-consumed data) and flagged `truncated`.
    var _MAX_STATE_CHARS = 32768;
    var _provider = null;

    function announce(kind) {
      try {
        if (!(window.parent && window.parent !== window)) return;
        window.parent.postMessage({ __usernode_issue_state: kind }, "*");
      } catch (_) { /* parent unreachable — nothing to announce to */ }
    }

    function respond(id, value, error) {
      try {
        if (!(window.parent && window.parent !== window)) return;
        window.parent.postMessage(
          {
            __usernode_issue_state: "response",
            id: id,
            value: value || null,
            error: error || null,
          },
          "*"
        );
      } catch (_) { /* parent gone, ignore */ }
    }

    function handleCollect(id) {
      if (typeof _provider !== "function") {
        respond(id, null, "no provider registered");
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        respond(id, null, "provider timed out");
      }, _PROVIDER_TIMEOUT_MS);
      function finish(value, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        respond(id, value, error);
      }
      var result;
      try {
        result = _provider();
      } catch (err) {
        finish(null, (err && err.message) || String(err));
        return;
      }
      Promise.resolve(result).then(
        function (state) {
          var json;
          try {
            json = JSON.stringify(state);
          } catch (_) {
            // Circular refs, BigInt, throwing toJSON — all land here.
            finish(null, "state not serializable");
            return;
          }
          if (typeof json !== "string") {
            // JSON.stringify(undefined) → undefined.
            finish(null, "state not serializable");
            return;
          }
          var truncated = json.length > _MAX_STATE_CHARS;
          if (truncated) json = json.slice(0, _MAX_STATE_CHARS);
          finish({ json: json, truncated: truncated }, null);
        },
        function (err) {
          finish(null, (err && err.message) || String(err));
        }
      );
    }

    window.addEventListener("message", function (e) {
      if (e.source !== window.parent) return;
      var data = e.data;
      if (!data || data.__usernode_issue_state !== "collect" || !data.id) return;
      handleCollect(data.id);
    });

    if (!window.usernode.issueState) {
      window.usernode.issueState = {
        register: function register(fn) {
          if (typeof fn !== "function") {
            throw new Error("usernode.issueState.register(fn): fn must be a function");
          }
          _provider = fn;
          announce("available");
        },
        unregister: function unregister() {
          _provider = null;
          announce("unavailable");
        },
      };
    }
  })();
  /* __USERNODE_ISSUE_STATE_END__ */

  /* __USERNODE_PLATFORM_LINK_START__ */
  // ── Floating "Open in Usernode" pill (chromeless share views) ─────────
  //
  // Apps shared via their bare production subdomain
  // (<slug>.<platform-host>) render with no platform chrome at all —
  // there's no visible path from the app back to its in-platform page.
  // The bridge is the one piece of platform code every dapp loads, so it
  // injects a small dismissible pill in the bottom-right corner that
  // deep-links back to https://<platform-host>/#app/<slug>/app — the
  // canonical App-tab hash the shell's restoreFromHash understands.
  //
  // Shown ONLY when ALL of these hold:
  //   * top frame         — inside the platform, apps render in iframes
  //                         and the chrome is already present;
  //   * no native channel — the Flutter WebView has its own navigation,
  //                         a web link to the platform origin is wrong
  //                         there;
  //   * location.host is exactly <label>.<platform-host> with no "--" in
  //     the label — i.e. a production app subdomain. That excludes the
  //     platform shell itself (same host, loads the bridge same-origin),
  //     staging previews (<slug>--s<id>), localhost dev, and foreign
  //     embeds. The platform host is derived from this script's own src,
  //     so self-hosted forks serving their own bridge get the right
  //     origin for free.
  //
  // The × only hides the pill for the current page load — no storage
  // flag is kept, so the pill reappears on every refresh.
  (function () {
    // document.currentScript is only valid during synchronous script
    // evaluation — which is exactly when this capture runs.
    var _script = document.currentScript;

    function platformLinkTarget() {
      if (_inIframe || _hasNativeChannel || window.Usernode) return null;
      if (!_script || !_script.src) return null;
      var platformHost;
      try {
        platformHost = new URL(_script.src, location.href).host;
      } catch (_) { return null; }
      if (!platformHost || location.host === platformHost) return null;
      var suffix = "." + platformHost;
      if (location.host.length <= suffix.length) return null;
      if (location.host.slice(-suffix.length) !== suffix) return null;
      var label = location.host.slice(0, -suffix.length);
      // A single clean label only: staging previews (<slug>--s<id>) and
      // deeper/odd hostnames don't get the pill.
      if (!/^[a-z0-9-]+$/i.test(label)) return null;
      if (label.indexOf("--") !== -1) return null;
      return {
        slug: label,
        href: "https://" + platformHost + "/#app/" + label + "/app",
      };
    }

    function injectPlatformLink() {
      var target = platformLinkTarget();
      if (!target) return;
      if (document.getElementById("__un-platform-link")) return;

      if (!document.getElementById("__usernode-platform-link-styles")) {
        var style = document.createElement("style");
        style.id = "__usernode-platform-link-styles";
        style.textContent = [
          // z-index one below the QR overlay (999999) so a transaction
          // prompt still covers the pill. safe-area insets keep it clear
          // of iPhone home indicators.
          ".__un-platform-link{position:fixed;right:calc(12px + env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:999998;display:flex;align-items:center;background:rgba(15,20,32,0.82);color:#e7edf7;border-radius:999px;padding:6px 6px 6px 12px;font:12px/1.2 -apple-system,system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,0.3);opacity:0.85}",
          ".__un-platform-link:hover{opacity:1}",
          ".__un-platform-link-glyph{font-size:11px;opacity:0.75;margin-left:4px}",
          ".__un-platform-link-close{background:none;border:none;color:inherit;font:14px/1 -apple-system,system-ui,sans-serif;padding:2px 6px;margin-left:2px;cursor:pointer;opacity:0.6;border-radius:999px}",
          ".__un-platform-link-close:hover{opacity:1}",
          "@media(prefers-color-scheme:light){.__un-platform-link{background:rgba(255,255,255,0.9);color:#0b1220;box-shadow:0 2px 10px rgba(0,0,0,0.18)}}",
        ].join("\n");
        document.head.appendChild(style);
      }

      var link = document.createElement("a");
      link.id = "__un-platform-link";
      link.className = "__un-platform-link";
      link.href = target.href;
      link.setAttribute("aria-label", "Open this app on Usernode");

      var label = document.createElement("span");
      label.textContent = "Open in Usernode";

      var glyph = document.createElement("span");
      glyph.className = "__un-platform-link-glyph";
      glyph.textContent = "\u2197"; // ↗ (escaped: robust to mis-declared page charsets)
      glyph.setAttribute("aria-hidden", "true");

      var close = document.createElement("button");
      close.className = "__un-platform-link-close";
      close.type = "button";
      close.textContent = "\u00d7"; // × (escaped, same reason)
      close.setAttribute("aria-label", "Hide");
      close.onclick = function (ev) {
        // The button lives inside the anchor: cancel the navigation the
        // bubbled click would otherwise trigger.
        ev.preventDefault();
        ev.stopPropagation();
        if (link.parentNode) link.parentNode.removeChild(link);
      };

      link.appendChild(label);
      link.appendChild(glyph);
      link.appendChild(close);
      document.body.appendChild(link);
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", injectPlatformLink);
    } else {
      injectPlatformLink();
    }
  })();
  /* __USERNODE_PLATFORM_LINK_END__ */
})();
