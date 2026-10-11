/* Offline store + Google Drive sync for the ward canvassing app.
   - LocalDB: same small API the app already used (doc/collection/onSnapshot/set/delete),
     stored in IndexedDB on the device, so the app works with no data or signal.
   - Sync: pushes local changes to the central Google Sheet/Drive (Apps Script) and pulls
     everyone else's. Last write wins per record. */
(function () {
  "use strict";
  var DBN = "anc-canvass", STORE = "docs";
  var mem = new Map(), idb = null, listeners = [], readyRes, persistent = true;
  var ready = new Promise(function (r) { readyRes = r; });
  function lg(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function ls(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var clientId = lg("cid") || (function () { var c = Math.random().toString(36).slice(2) + Date.now().toString(36); ls("cid", c); return c; })();

  function openIDB() {
    return new Promise(function (res) {
      try {
        var q = indexedDB.open(DBN, 1);
        q.onupgradeneeded = function () { q.result.createObjectStore(STORE, { keyPath: "p" }); };
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { res(null); };
        q.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function put(rec) {
    if (!idb) return;
    try { idb.transaction(STORE, "readwrite").objectStore(STORE).put(rec); } catch (e) { persistent = false; }
  }
  openIDB().then(function (d) {
    idb = d;
    if (!d) { persistent = false; return; }
    return new Promise(function (res) {
      var q = d.transaction(STORE).objectStore(STORE).getAll();
      q.onsuccess = function () { (q.result || []).forEach(function (r) { mem.set(r.p, r); }); res(); };
      q.onerror = function () { res(); };
    });
  }).then(function () { readyRes(); ui(); });
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  /* ---------- snapshots & listeners ---------- */
  function docSnap(p) { var r = mem.get(p), ex = !!r && !r.x; return { id: p.split("/").pop(), exists: ex, data: function () { return ex ? r.d : undefined; } }; }
  function colSnap(name) {
    var pre = name + "/", docs = [];
    mem.forEach(function (r, p) {
      if (!r.x && p.indexOf(pre) === 0 && p.indexOf("/", pre.length) < 0) docs.push({ id: p.slice(pre.length), data: function () { return r.d; } });
    });
    return { docs: docs };
  }
  function fire(l) { try { l.cb(l.t === "doc" ? docSnap(l.p) : colSnap(l.p)); } catch (e) { console.error(e); } }
  function notify(paths) {
    listeners.forEach(function (l) {
      var hit = paths.some(function (p) { return l.t === "doc" ? p === l.p : (p.indexOf(l.p + "/") === 0 && p.indexOf("/", l.p.length + 1) < 0); });
      if (hit) fire(l);
    });
  }
  function onSnap(t, p, cb) {
    var l = { t: t, p: p, cb: cb }; listeners.push(l);
    ready.then(function () { fire(l); });
    return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
  }

  async function write(p, d, del) {
    await ready;
    var old = mem.get(p), u = Date.now();
    if (old && old.u >= u) u = old.u + 1;
    var rec = { p: p, d: del ? null : JSON.parse(JSON.stringify(d)), u: u, x: del ? 1 : 0, y: 1 };
    mem.set(p, rec); put(rec); notify([p]); kick();
  }
  function applyRemote(list, dirty) {
    var ch = [];
    list.forEach(function (r) {
      var o = mem.get(r.p);
      if (o && o.u >= r.u) return;
      var rec = { p: r.p, d: r.x ? null : r.d, u: r.u, x: r.x ? 1 : 0, y: dirty ? 1 : 0 };
      mem.set(r.p, rec); put(rec); ch.push(r.p);
    });
    if (ch.length) notify(ch);
    return ch.length;
  }
  var db = {
    doc: function (p) {
      return {
        set: function (d) { return write(p, d, false); },
        delete: function () { return write(p, null, true); },
        get: function () { return ready.then(function () { return docSnap(p); }); },
        onSnapshot: function (cb) { return onSnap("doc", p, cb); }
      };
    },
    collection: function (n) { return { onSnapshot: function (cb) { return onSnap("col", n, cb); } }; }
  };
  var pending = function () { var n = 0; mem.forEach(function (r) { if (r.y) n++; }); return n; };

  /* ---------- sync with Google Drive (Apps Script) ---------- */
  var cfg = lg("sync_cfg"), since = +lg("sync_since") || 0;
  var st = { busy: false, err: "", last: +lg("sync_last") || 0 }, timer = null;

  async function post(body) {
    var r;
    try {
      r = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body), redirect: "follow" });
    } catch (e) { throw new Error("Could not reach the central store. Check your internet connection."); }
    var t = await r.text(), j;
    try { j = JSON.parse(t); } catch (e) { throw new Error("The sync link did not respond correctly. Check the link, and that the script is deployed with access set to Anyone."); }
    return j;
  }
  async function run(manual) {
    if (st.busy) return;
    if (!cfg || !cfg.url) { ui(); return; }
    if (navigator.onLine === false) { st.err = manual ? "No internet connection. Your work is saved on this device and will sync when you are back online." : ""; ui(); return; }
    st.busy = true; st.err = ""; ui();
    try {
      await ready;
      for (var guard = 0; guard < 400; guard++) {
        var dirty = [], sz = 0;
        for (var r of mem.values()) {
          if (!r.y) continue;
          var j = r.x ? "" : JSON.stringify(r.d);
          if (dirty.length && sz + j.length > 1200000) break;
          sz += j.length; dirty.push({ p: r.p, u: r.u, x: r.x, j: j });
        }
        var res = await post({ a: "sync", t: cfg.token, c: clientId, since: since, docs: dirty });
        if (!res.ok) throw new Error(res.error || "Sync failed");
        dirty.forEach(function (d) { var r2 = mem.get(d.p); if (r2 && r2.u === d.u && r2.y) { r2.y = 0; put(r2); } });
        applyRemote((res.docs || []).map(function (d) { return { p: d.p, u: d.u, x: d.x, d: d.x ? null : JSON.parse(d.j) }; }), false);
        since = res.next; ls("sync_since", since);
        if (!res.more && pending() === 0) break;
      }
      st.last = Date.now(); ls("sync_last", st.last);
    } catch (e) { st.err = e.message || String(e); }
    st.busy = false; ui();
  }
  function kick() { clearTimeout(timer); timer = setTimeout(function () { run(false); }, 4000); ui(); }

  /* ---------- UI ---------- */
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var hhmm = function (t) { var d = new Date(t); return d.toLocaleDateString("en-ZA", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }); };
  function statusText() {
    var n = pending();
    if (!persistent) return "Warning: this browser is not saving data between visits";
    if (!cfg) return "Works offline · saved on this device";
    if (st.busy) return "Syncing…";
    if (st.err) return "Not synced · " + (n ? n + " change" + (n > 1 ? "s" : "") + " saved on this device" : "saved on this device");
    if (n) return n + " change" + (n > 1 ? "s" : "") + " waiting to sync";
    return st.last ? "Synced " + hhmm(st.last) : "Connected · not synced yet";
  }
  var deferredInstall = null;
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferredInstall = e; ui(); });
  function ui() {
    var el = document.getElementById("st"); if (el) el.textContent = statusText();
    var b = document.getElementById("syb"); if (b) { var n = pending(); b.textContent = "⇅ Sync" + (n ? " (" + n + ")" : ""); }
    var d = document.getElementById("sy"); if (d && d.open) body();
    try { if (typeof access !== "undefined" && !access && typeof showLogin === "function" && typeof ROSTER !== "undefined") showLogin(); } catch (e) {}
  }
  function isAdm() { return typeof isAdmin !== "undefined" && isAdmin; }
  function body() {
    var c = document.getElementById("syc"); if (!c) return;
    var n = pending(), ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone;
    var link = cfg ? location.href.split("#")[0] + "#setup=" + btoa(unescape(encodeURIComponent(JSON.stringify({ u: cfg.url, t: cfg.token })))) : "";
    c.innerHTML =
      '<h2 style="margin-top:0">Sync &amp; backup</h2>' +
      '<p style="margin:0 0 8px"><b>' + esc(statusText()) + '</b>' + (st.last ? '<br><small>Last synced ' + esc(hhmm(st.last)) + '</small>' : '') + '</p>' +
      (st.err ? '<p style="color:var(--rd);font-weight:700;margin:0 0 8px">' + esc(st.err) + '</p>' : '') +
      '<p><small>The app works without data or signal. Everything you record is saved on this device and sent to the central Google Drive store whenever you are online.</small></p>' +
      (cfg ? '<button class="go" style="margin-top:4px" onclick="Sync.run(true)"' + (st.busy ? " disabled" : "") + '>' + (st.busy ? "Syncing…" : "Sync now" + (n ? " (" + n + " waiting)" : "")) + '</button>' : '') +
      '<h2>Connection to central store</h2>' +
      '<label>Sync link (from the Google Apps Script deployment)</label><input id="sul" value="' + esc(cfg ? cfg.url : "") + '" placeholder="https://script.google.com/macros/s/.../exec" autocapitalize="none">' +
      '<label style="margin-top:8px">Access code</label><input id="stk" type="password" value="' + esc(cfg ? cfg.token : "") + '" autocapitalize="none">' +
      '<button class="go" style="background:#26323d" onclick="Sync.save()">Save connection</button>' + mh("sm") +
      (cfg && isAdm() ? '<h2>Set up another device</h2><small>Send this link privately (WhatsApp, e-mail). Opening it connects that device to the central store. Anyone with the link can reach the data, so share it only with registered users.</small><div class="f" style="margin-top:6px"><input readonly value="' + esc(link) + '" onfocus="this.select()"></div><button class="go" style="background:#26323d" onclick="Sync.copy()">Copy setup link</button>' : '') +
      '<h2>Backup file</h2><small>A backup file is a second safety net and a way to move data between devices without internet.</small>' +
      '<button class="go" style="background:#26323d" onclick="Sync.exportAll()">Download backup file</button>' +
      (isAdm() ? '<label style="margin-top:10px">Restore / import a backup or voters-roll data file</label><input type="file" accept=".json,application/json" onchange="Sync.importFile(this.files[0])">' + mh("sim") : '') +
      (deferredInstall ? '<h2>Install</h2><button class="go" onclick="Sync.install()">Install app on this device</button>' : '') +
      (ios ? '<h2>Install</h2><small>On iPhone/iPad: tap the Share button, then <b>Add to Home Screen</b>.</small>' : '') +
      '<button class="go" style="background:none;color:var(--tx);border:2px solid var(--ln)" onclick="document.getElementById(\'sy\').close()">Close</button>';
  }
  function open() {
    var d = document.getElementById("sy");
    if (!d) { d = document.createElement("dialog"); d.id = "sy"; d.style.width = "min(94vw,520px)"; d.innerHTML = '<div id="syc"></div>'; document.body.appendChild(d); }
    body(); if (!d.open) d.showModal();
  }
  var msgs = {};
  function msg(id, t, bad) { msgs[id] = { t: t, bad: bad }; body(); }
  function mh(id) { var m = msgs[id]; return m ? '<div style="font-weight:700;margin-top:6px;color:' + (m.bad ? "var(--rd)" : "var(--ac)") + '">' + esc(m.t) + "</div>" : ""; }
  function save() {
    var u = document.getElementById("sul").value.trim(), t = document.getElementById("stk").value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(u) || !t) { msg("sm", "Enter the full sync link (it starts with https://script.google.com/) and the access code.", true); return; }
    var changed = !cfg || cfg.url !== u;
    cfg = { url: u, token: t }; ls("sync_cfg", cfg);
    if (changed) { since = 0; ls("sync_since", 0); mem.forEach(function (r) { r.y = 1; put(r); }); }
    msg("sm", "Saved. Connecting…"); run(true); if (typeof computeRole === "function") computeRole();
  }
  function applySetupHash() {
    var m = /[#&]setup=([^&]+)/.exec(location.hash || ""); if (!m) return;
    try {
      var o = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      if (o && o.u && o.t) { cfg = { url: o.u, token: o.t }; ls("sync_cfg", cfg); since = 0; ls("sync_since", 0); }
    } catch (e) {}
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  }
  function download(name, text) {
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function exportAll() {
    await ready;
    var docs = []; mem.forEach(function (r) { docs.push({ p: r.p, u: r.u, x: r.x, d: r.d }); });
    download("anc-canvassing-backup-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify({ app: "anc-canvass", v: 1, at: new Date().toISOString(), docs: docs }));
  }
  async function importFile(f) {
    if (!f) return; await ready;
    try {
      var o = JSON.parse(await f.text());
      if (!o || o.app !== "anc-canvass" || !Array.isArray(o.docs)) throw new Error("This is not a canvassing data file.");
      var n = applyRemote(o.docs, true);
      msg("sim", "Imported " + n + " record" + (n === 1 ? "" : "s") + (cfg ? ". Syncing to the central store…" : ". Connect to the central store to share them with other devices."));
      if (cfg) run(true); ui();
    } catch (e) { msg("sim", "Could not import: " + (e.message || e), true); }
  }
  function copy() {
    var i = document.querySelector("#syc input[readonly]"); if (!i) return;
    i.select(); try { navigator.clipboard.writeText(i.value).then(function () { alert("Setup link copied"); }, function () { document.execCommand("copy"); }); } catch (e) { try { document.execCommand("copy"); } catch (e2) {} }
  }

  window.LocalDB = db;
  window.Sync = {
    run: run, kick: kick, open: open, save: save, copy: copy, exportAll: exportAll, importFile: importFile, ui: ui,
    ready: ready, pending: pending,
    install: function () { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; ui(); } },
    configured: function () { return !!cfg; }, hasSynced: function () { return !!st.last; }, busy: function () { return st.busy; }
  };
  applySetupHash();

  window.addEventListener("online", function () { run(false); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) run(false); });
  setInterval(function () { if (!document.hidden && cfg) run(false); }, 90000);
  ready.then(function () { if (cfg) run(false); });

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
})();
