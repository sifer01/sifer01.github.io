(function () {
  "use strict";

  var SYNC_URL = "https://papas-saves.papas.workers.dev/sync";
  var TOKEN_KEY = "papas_sync_token";
  var META_KEY = "papas_sync_meta";
  var MIN_PUSH_GAP = 20000;
  var DELETED = "__PAPAS_DELETED__";

  var token = null;
  var meta = {};
  var enabled = false;
  var busy = false;
  var lastPush = 0;

  var api = { onStatus: function () {}, start: start, changePassphrase: changePassphrase, findSaves: findSaves, deleteKeys: deleteKeys };
  window.PapasCloud = api;

  function status(s) {
    var labels = { ok: "\u2601\u2713", syncing: "\u2601\u2026", error: "\u2601!", off: "\u2601 off" };
    try { api.onStatus(labels[s] || "\u2601", s); } catch (e) {}
  }

  function read(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function saveMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) {} }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h + ":" + s.length; }
  function normalize(p) { return String(p).trim().toLowerCase().replace(/\s+/g, " "); }

  function sha256Hex(str) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    });
  }

  // Ruffle stores each Flash save in localStorage as "<host>/<path>/<name>"
  function prefixes() {
    var a = [location.hostname + "/"];
    if (location.host !== location.hostname) a.push(location.host + "/");
    return a;
  }
  function snapshot() {
    var out = {}, pre = prefixes();
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k) continue;
      for (var j = 0; j < pre.length; j++) {
        if (k.indexOf(pre[j]) === 0) { out[k.slice(pre[j].length)] = localStorage.getItem(k); break; }
      }
    }
    return out;
  }
  function restorePrefix() {
    var pre = prefixes();
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      for (var j = 0; j < pre.length; j++) if (k && k.indexOf(pre[j]) === 0) return pre[j];
    }
    return pre[0];
  }

  function request(method, body, keepalive) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    var opts = { method: method, headers: { "X-Token": token }, cache: "no-store" };
    if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    if (keepalive) opts.keepalive = true;
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(SYNC_URL, opts).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  // Cloud -> this browser. Unsynced local changes always win; otherwise newer cloud data replaces local.
  function pull() {
    return request("GET").then(function (bundle) {
      var keys = (bundle && bundle.keys) || {};
      var pre = restorePrefix();
      Object.keys(keys).forEach(function (name) {
        var item = keys[name];
        if (!item || typeof item.v !== "string") return;
        var lk = pre + name;
        var cur = localStorage.getItem(lk);
        var m = meta[name];
        if (item.v === DELETED) {
          if (cur === null) { meta[name] = { h: "deleted", ts: item.ts }; return; }
          if (m && m.h === hash(cur) && item.ts > m.ts) {
            try { localStorage.removeItem(lk); } catch (e) { return; }
            meta[name] = { h: "deleted", ts: item.ts };
          }
          return;
        }
        if (cur === item.v) { meta[name] = { h: hash(cur), ts: item.ts }; return; }
        if (cur !== null && (!m || m.h !== hash(cur))) return;
        if (cur === null || item.ts > m.ts) {
          try { localStorage.setItem(lk, item.v); } catch (e) { return; }
          meta[name] = { h: hash(item.v), ts: item.ts };
        }
      });
      saveMeta();
    });
  }

  // This browser -> cloud, only the saves that changed since the last sync.
  function pushChanged(urgent) {
    if (!enabled || busy) return Promise.resolve();
    if (!urgent && Date.now() - lastPush < MIN_PUSH_GAP) return Promise.resolve();
    var snap = snapshot(), payload = {}, count = 0;
    Object.keys(snap).forEach(function (name) {
      var m = meta[name];
      if (!m || m.h !== hash(snap[name])) {
        payload[name] = { v: snap[name], ts: Math.max(Date.now(), (m ? m.ts : 0) + 1) };
        count++;
      }
    });
    if (!count) return Promise.resolve();
    busy = true;
    status("syncing");
    return request("POST", { keys: payload }, urgent).then(function () {
      Object.keys(payload).forEach(function (name) {
        meta[name] = { h: hash(payload[name].v), ts: payload[name].ts };
      });
      saveMeta();
      lastPush = Date.now();
      status("ok");
    }).catch(function () { status("error"); }).then(function () { busy = false; });
  }

  function ask(message) {
    return new Promise(function (resolve) {
      var o = document.createElement("div");
      o.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;z-index:1000;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:16px;font-family:'Courier New',monospace;";
      var box = document.createElement("div");
      box.style.cssText = "background:#1f1b2e;color:#d77bff;border:1px solid #d77bff;border-radius:12px;padding:18px;max-width:420px;width:100%;box-sizing:border-box;";
      var msg = document.createElement("div");
      msg.style.cssText = "margin-bottom:12px;line-height:1.4;font-size:15px;";
      msg.textContent = message;
      var input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      input.setAttribute("autocorrect", "off");
      input.style.cssText = "width:100%;box-sizing:border-box;font-size:16px;padding:10px;border-radius:8px;border:1px solid #d77bff;background:#0b0c10;color:#fff;";
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;margin-top:12px;";
      function mk(label, bg) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = "flex:1;padding:10px;border-radius:8px;border:1px solid #d77bff66;font:inherit;font-size:15px;color:#fff;background:" + bg + ";";
        return b;
      }
      var ok = mk("Save", "#b53aa1");
      var skip = mk("Skip", "transparent");
      function done(v) { document.body.removeChild(o); resolve(v); }
      ok.onclick = function () { var v = input.value.trim(); if (v) done(v); };
      skip.onclick = function () { done(null); };
      input.onkeydown = function (e) { if (e.key === "Enter") ok.onclick(); };
      row.appendChild(ok); row.appendChild(skip);
      box.appendChild(msg); box.appendChild(input); box.appendChild(row);
      o.appendChild(box);
      document.body.appendChild(o);
      input.focus();
    });
  }

  function getToken() {
    var saved = null;
    try { saved = localStorage.getItem(TOKEN_KEY); } catch (e) {}
    if (saved) return Promise.resolve(saved);
    try { if (sessionStorage.getItem("papas_sync_skip")) return Promise.resolve(null); } catch (e) {}
    return ask("Cloud saves: type your sync passphrase. Use the same one on every device (capital letters don't matter).").then(function (p) {
      if (!p) { try { sessionStorage.setItem("papas_sync_skip", "1"); } catch (e) {} return null; }
      return sha256Hex(normalize(p)).then(function (t) {
        try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
        return t;
      });
    });
  }

  function start() {
    return getToken().then(function (t) {
      if (!t) { status("off"); return; }
      token = t;
      meta = read(META_KEY, {});
      status("syncing");
      return pull().then(function () {
        enabled = true;
        status("ok");
        setInterval(function () { pushChanged(false); }, 5000);
        document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") pushChanged(true); });
        window.addEventListener("pagehide", function () { pushChanged(true); });
        return pushChanged(true);
      }, function () {
        // could not reach the cloud: play offline and don't upload anything this time
        enabled = false;
        status("error");
      });
    });
  }

  function findSaves(gameId, aliases) {
    var words = [gameId].concat(aliases || []).map(function (w) { return String(w).toLowerCase(); });
    var snap = snapshot(), out = [];
    Object.keys(snap).forEach(function (name) {
      var n = name.toLowerCase().replace(/[^a-z]/g, "");
      if (n === "session") return;
      for (var i = 0; i < words.length; i++) {
        if (n.indexOf(words[i]) !== -1) { out.push(name); break; }
      }
    });
    return out;
  }

  function deleteKeys(names) {
    if (!names || !names.length) return Promise.resolve("none");
    if (!Object.keys(meta).length) meta = read(META_KEY, {});
    var pre = restorePrefix(), payload = {};
    names.forEach(function (name) {
      try { localStorage.removeItem(pre + name); } catch (e) {}
      var m = meta[name];
      payload[name] = { v: DELETED, ts: Math.max(Date.now(), (m ? m.ts : 0) + 1) };
    });
    if (!token) { try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {} }
    if (!token) return Promise.resolve("local");
    return request("POST", { keys: payload }).then(function () {
      Object.keys(payload).forEach(function (name) { meta[name] = { h: "deleted", ts: payload[name].ts }; });
      saveMeta();
      return "cloud";
    }, function () { return "local"; });
  }

  function changePassphrase() {
    return ask("Change sync passphrase (same one on every device).").then(function (p) {
      if (!p) return;
      return sha256Hex(normalize(p)).then(function (t) {
        try { localStorage.setItem(TOKEN_KEY, t); localStorage.removeItem(META_KEY); } catch (e) {}
        location.reload();
      });
    });
  }
})();
