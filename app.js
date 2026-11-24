// Group City website. Inside Telegram (opened as the Mini App) it logs in with Telegram initData; in a normal browser it
// uses the Telegram Login Widget. Promotions are paid from the user's Group City Stars balance (kept by the worker);
// the balance is topped up with a Telegram Stars invoice (Telegram.WebApp.openInvoice inside Telegram).
// Chat, support and profile use this site's own /api (Vercel functions + Supabase); groups and Stars payments
// use the Cloudflare worker. All text from the server is put on the page with textContent (never innerHTML).
(function () {
  "use strict";
  var CFG = window.GC_CONFIG || {};
  var API = String(CFG.API_URL || "").replace(/\/+$/, "");
  var BOT = String(CFG.BOT || "").replace(/^@/, "");
  var tg = (window.Telegram && window.Telegram.WebApp) || null;
  var inTg = !!(tg && tg.initData);          // opened inside Telegram (signed data present)
  if (inTg) {
    document.documentElement.classList.add("tg");
    try { tg.ready(); tg.expand(); } catch (e) {}   // header colour: applyTheme below
  }
  // light / dark look. Settings → Theme: "system" (default) = Telegram's colorScheme inside Telegram, the device setting
  // in a browser; "light" / "dark" = always that look (saved on this device as gc_theme; html.thx turns off
  // Telegram's own theme colours so the choice really applies inside Telegram too).
  var THKEY = "gc_theme";
  function themePref() { var v = ""; try { v = localStorage.getItem(THKEY) || ""; } catch (e) {} return v === "light" || v === "dark" ? v : "system"; }
  var applyTheme = (function () {
    var root = document.documentElement, mq = null;
    try { mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null; } catch (e) {}
    function apply() {
      var p = themePref();
      var dark = p === "dark" ? true : p === "light" ? false : (inTg ? tg.colorScheme === "dark" : !!(mq && mq.matches));
      root.classList.toggle("dark", dark);
      root.classList.toggle("thx", p !== "system");
      if (inTg) {
        try {
          if (tg.setHeaderColor) tg.setHeaderColor(p === "system" ? "bg_color" : (dark ? "#17212b" : "#ffffff"));
          if (tg.setBackgroundColor) tg.setBackgroundColor(p === "system" ? "bg_color" : (dark ? "#17212b" : "#ffffff"));
        } catch (e) {}
      }
    }
    apply();
    try {
      if (inTg && tg.onEvent) tg.onEvent("themeChanged", apply);
      if (!inTg && mq && mq.addEventListener) mq.addEventListener("change", apply);
    } catch (e) {}
    return apply;
  })();
  function setTheme(p) {
    p = p === "light" || p === "dark" ? p : "system";
    try { if (p === "system") localStorage.removeItem(THKEY); else localStorage.setItem(THKEY, p); } catch (e) {}
    applyTheme();
  }

  var data = { featured: [], groups: [], bot: BOT, short: "", price: 10, topPrice: 50, days: 30 };
  var cat = "All", pkg = "top", busy = false, mineLoaded = false, current = "groups";
  // Group categories: the one list is CATEGORIES in config.js (the worker keeps the same allow-list).
  var CATS = (Array.isArray(CFG.CATEGORIES) ? CFG.CATEGORIES : []).map(function (c) { return String(c || "").trim(); })
    .filter(function (c, i, a) { return c && c !== "All" && a.indexOf(c) === i; });
  var prCat = "";                               // category picked in the Promote form ("" = not chosen yet)
  // Telegram-style search bar under the header: one input, its own text per tab (Groups / Messages)
  var sq = { groups: "", msg: "" };
  var SKEY = "gc_session", CKEY = "gc_chat_session";

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function safeUrl(u) { return /^https:\/\/[^\s]+$/i.test(String(u || "")) ? String(u) : ""; }
  function isTgUrl(u) { return /^https:\/\/(t\.me|telegram\.me)\/[^\s]+$/i.test(String(u || "")); }
  function open(u) {
    u = safeUrl(u); if (!u) return;
    try {
      if (inTg && isTgUrl(u) && tg.openTelegramLink) return tg.openTelegramLink(u.replace(/^https:\/\/telegram\.me\//i, "https://t.me/"));
      if (inTg && tg.openLink) return tg.openLink(u);
    } catch (e) {}
    window.open(u, "_blank", "noopener");
  }
  // Turns links in a chat message into tappable Telegram-style links (text stays plain text, no HTML).
  function linkify(text) {
    var box = el("span", "mtx"), re = /(https?:\/\/[^\s<>"]+|(?:^|[^\w.\/@])(?:t\.me|telegram\.me)\/[^\s<>"]+|@[A-Za-z][A-Za-z0-9_]{3,31})/g, last = 0, mt;
    while ((mt = re.exec(text))) {
      var raw = mt[0], pre = "";
      if (raw[0] !== "h" && raw[0] !== "@" && raw[0] !== "t") { pre = raw[0]; raw = raw.slice(1); }
      var start = mt.index + pre.length, shown = raw.replace(/[.,!?:;)\]}'"]+$/, ""), end = start + shown.length;
      var url = shown[0] === "@" ? "https://t.me/" + shown.slice(1) : (/^https?:\/\//i.test(shown) ? shown.replace(/^http:\/\//i, "https://") : "https://" + shown);
      if (start > last) hlAppend(box, text.slice(last, start));
      var a = el("a", "mlink"); hlAppend(a, shown); a.href = url; a.target = "_blank"; a.rel = "noopener";
      (function (u) { a.onclick = function (e) { e.preventDefault(); e.stopPropagation(); open(u); }; })(url);
      box.appendChild(a); last = end; re.lastIndex = Math.max(re.lastIndex, end);
    }
    if (last < text.length) hlAppend(box, text.slice(last));
    return box;
  }
  // In-chat search state. While a search is on, hlAppend wraps every match in <mark class="hl"> (text only, no HTML).
  var srch = { on: false, q: "", re: null, marks: [], cur: -1, curKey: "", mid: 0, occ: 0 };
  function hlAppend(parent, s) {
    if (!s) return;
    if (!srch.on || !srch.re) { parent.appendChild(document.createTextNode(s)); return; }
    var re = srch.re, last = 0, mt; re.lastIndex = 0;
    while ((mt = re.exec(s))) {
      if (!mt[0].length) { re.lastIndex++; continue; }
      if (mt.index > last) parent.appendChild(document.createTextNode(s.slice(last, mt.index)));
      var mk = el("mark", "hl", mt[0]); mk.gcKey = srch.mid + ":" + (srch.occ++);
      srch.marks.push(mk); parent.appendChild(mk); last = mt.index + mt[0].length;
    }
    if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
  }
  function botName() { return data.bot || BOT; }
  function botLink(start) { var b = botName(); return b ? "https://t.me/" + encodeURIComponent(b) + (start ? "?start=" + encodeURIComponent(start) : "") : ""; }
  function appLink(start) {
    var b = botName(); if (!b) return "";
    var base = "https://t.me/" + encodeURIComponent(b);
    return (data.short ? base + "/" + encodeURIComponent(data.short) : base) + "?startapp" + (start ? "=" + encodeURIComponent(start) : "");
  }

  // ---------- session (browser login) ----------
  function getSession() {
    try {
      var s = JSON.parse(localStorage.getItem(SKEY) || "null");
      if (s && typeof s.token === "string" && /^\d+\.\d+\.[0-9a-f]{64}$/i.test(s.token) && Number(s.exp) * 1000 > Date.now()) return s;
    } catch (e) {}
    return null;
  }
  function setSession(s) { try { if (s) localStorage.setItem(SKEY, JSON.stringify(s)); else localStorage.removeItem(SKEY); } catch (e) {} }
  // chat session (this site's /api): {token, exp, user, isAdmin}
  function getChat() {
    try {
      var s = JSON.parse(localStorage.getItem(CKEY) || "null");
      if (s && typeof s.token === "string" && /^\d+\.\d+\.[0-9a-f]{64}$/i.test(s.token) && Number(s.exp) * 1000 > Date.now()) return s;
    } catch (e) {}
    return null;
  }
  function setChat(s) { try { if (s) localStorage.setItem(CKEY, JSON.stringify(s)); else localStorage.removeItem(CKEY); } catch (e) {} }
  // ---------- network status (Telegram-style "Connecting..." / "Updating..." in the header title) ----------
  // Every request to this site's /api and to the worker goes through netFetch, which counts requests in flight and
  // records per origin whether the last one reached the server. States: "connecting" (offline, or the last request
  // to an origin failed / timed out), "updating" (a request has been running for NET_DEBOUNCE ms during the first
  // load or while recovering from "connecting"), "ok". Background polls while everything is fine never show anything.
  var NET_DEBOUNCE = 400, NET_TIMEOUT = 15000, NET_RETRY_MAX = 30000;
  var net = { inflight: 0, initial: true, slow: false, slowOn: false, slowGen: 0, fail: {}, offline: false, down: false, state: "ok", retryOn: false, retryMs: 0, retryGen: 0, groupsFailed: false };
  try { net.offline = !!(window.navigator && navigator.onLine === false); net.down = net.offline; } catch (e) {}
  function netOrigin(url) { return /^\//.test(String(url)) ? "api" : "worker"; }
  function netFailing() { for (var k in net.fail) { if (net.fail[k]) return true; } return false; }
  function netCalc() {
    if (net.offline) return "connecting";
    if (net.slow && net.inflight > 0 && (net.initial || net.down)) return "updating";
    if (netFailing()) return "connecting";
    return "ok";
  }
  function netLabel(s) { return s === "connecting" ? "Connecting" : s === "updating" ? "Updating" : ""; }
  function netDots() { var d = el("span", "ndots"); d.setAttribute("aria-hidden", "true"); for (var i = 0; i < 3; i++) d.appendChild(el("i", null, ".")); return d; }
  function netPaint() {
    var t = $("hd-title"), w = $("hd-word"), st = $("hd-stat"), s = net.state;
    if (t) t.classList.toggle("net", s !== "ok");
    if (w && s !== "ok") w.textContent = netLabel(s);          // keep the old word while fading back to the name
    if (st) st.setAttribute("aria-hidden", s === "ok" ? "true" : "false");
    renderSub();
  }
  function netUpdate() { var s = netCalc(); if (s !== net.state) { net.state = s; netPaint(); } }
  function netStart() {
    net.inflight++;
    if (!net.slow && !net.slowOn) {
      net.slowOn = true;
      var gen = net.slowGen;      // the debounce restarts whenever the app goes idle in between
      setTimeout(function () { if (gen !== net.slowGen) return; net.slowOn = false; if (net.inflight > 0) { net.slow = true; netUpdate(); } }, NET_DEBOUNCE);
    }
    netUpdate();
  }
  function netEnd(origin, reached) {
    net.inflight = Math.max(0, net.inflight - 1);
    var was = !!net.fail[origin];
    net.fail[origin] = !reached;
    if (!reached) { net.down = true; netRetry(); }
    else if (was) Promise.resolve().then(function () { netRecovered(origin); });
    if (!net.inflight) { net.slow = false; net.slowOn = false; net.slowGen++; net.initial = false; }
    if (!netFailing() && !net.offline) { net.down = false; netRetryReset(); }
    netUpdate();
  }
  function netFetch(url, init) {
    init = init || {};
    var origin = netOrigin(url), done = false, ctl = null;
    try { if (typeof AbortController === "function") { ctl = new AbortController(); init.signal = ctl.signal; } } catch (e) { ctl = null; }
    netStart();
    if (ctl) setTimeout(function () { if (!done) { try { ctl.abort(); } catch (e) {} } }, NET_TIMEOUT);
    var fin = function (reached) { if (done) return; done = true; netEnd(origin, reached); };
    var p;
    try { p = fetch(url, init); } catch (e) { p = Promise.reject(e); }
    return p.then(function (r) { fin(!(r && (r.status === 502 || r.status === 503 || r.status === 504))); return r; },
      function (e) { fin(false); throw e; });
  }
  // retry with backoff while an origin is failing (paused while the device is offline; "online" retries at once)
  function netRetryReset() { net.retryGen++; net.retryOn = false; net.retryMs = 0; }   // drops a pending retry
  function netRetry() {
    if (net.retryOn || net.offline) return;
    net.retryOn = true;
    net.retryMs = Math.min(net.retryMs ? net.retryMs * 2 : 1000, NET_RETRY_MAX);
    var gen = net.retryGen;
    setTimeout(function () { if (gen !== net.retryGen) return; net.retryOn = false; netProbe(); }, net.retryMs);
  }
  function netProbe() {
    if (net.offline) return;
    Object.keys(net.fail).forEach(function (o) {
      if (!net.fail[o]) return;
      var c = getChat(), h = c ? { Authorization: "Bearer " + c.token } : undefined;
      var req = o === "worker" ? netFetch(API + "/app/api/groups", { credentials: "omit", mode: "cors", cache: "no-store" })
        : netFetch("/api/chat?view=summary", { headers: h, credentials: "same-origin", cache: "no-store" });
      req.then(function () {}, function () {});
    });
  }
  // an origin answers again: refresh what it serves
  function netRecovered(origin) {
    if (origin === "worker") { if (net.groupsFailed) load(); return; }
    if (!chatReady()) return;
    if (ch && screens[screens.length - 1] === "v-chat") fetchMsgs(false);
    else if (current === "msg" && !screens.length) renderMsgTab();
    else loadSummary(true);
  }
  function netOffline() { net.offline = true; net.down = true; net.fail.api = true; net.fail.worker = true; netUpdate(); }
  function netOnline() { net.offline = false; net.down = true; netRetryReset(); net.fail.api = true; net.fail.worker = true; netUpdate(); netProbe(); }
  try {
    if (window.addEventListener) { window.addEventListener("offline", netOffline); window.addEventListener("online", netOnline); }
    document.addEventListener("visibilitychange", function () { if (!document.hidden && !net.offline && netFailing()) netProbe(); });
  } catch (e) {}
  window.gcNet = { state: function () { return net.state; } };   // read-only, for debugging

  function chatApi(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" }, c = getChat();
    if (c && !opts.noAuth) headers.Authorization = "Bearer " + c.token;
    return netFetch(path, { method: opts.body ? "POST" : "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (d) { d = d || {}; d._status = r.status; return d; }); });
  }
  function saveChatLogin(d) {
    if (!d || !d.ok || typeof d.token !== "string") return false;
    setChat({ token: d.token, exp: d.exp, user: d.user || {}, isAdmin: !!d.isAdmin });
    clearMsgCache(cacheOwner());      // another account's cached chats never stay on this device
    return true;
  }
  // ---------- per-chat message cache (this device; Telegram-style instant open) ----------
  // key gc_cache:<my user id>:<room>[:<thread uid>] → {o: owner, t: saved at, m: [compact messages]} (last 100)
  var CPFX = "gc_cache:", CACHE_MAX = 100, CACHE_KEYS = 24;
  function cacheOwner() { var c = getChat(); return c && c.user && c.user.id != null && String(c.user.id) !== "" ? String(c.user.id) : ""; }
  function cacheKey(room, uid) { var o = cacheOwner(); return o ? CPFX + o + ":" + room + (uid ? ":" + uid : "") : ""; }
  function lsKeys() {
    var out = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k != null) out.push(k); } } catch (e) {}
    return out;
  }
  function packMsg(m) {
    var x = { i: m.id, t: String(m.text || ""), a: m.at || "" };
    if (m.u) x.u = m.u; if (m.mine) x.m = 1; if (m.name) x.n = m.name; if (m.admin) x.d = 1; if (m.photo) x.p = m.photo; if (m.pv) x.v = String(m.pv);
    return x;
  }
  function unpackMsg(x) { return { id: Number(x.i), text: x.t || "", at: x.a || "", u: x.u || "", mine: !!x.m, name: x.n || "", admin: !!x.d, photo: x.p || "", pv: x.v || "" }; }
  function readCache(room, uid) {
    var k = cacheKey(room, uid); if (!k) return null;
    try {
      var o = JSON.parse(localStorage.getItem(k) || "null");
      if (!o || o.o !== cacheOwner() || !Array.isArray(o.m)) return null;
      return o.m.filter(function (x) { return x && Number(x.i) > 0; }).map(unpackMsg);
    } catch (e) { return null; }
  }
  function writeCache(room, uid, msgs) {
    var k = cacheKey(room, uid); if (!k) return;
    var keep = (msgs || []).filter(function (m) { return m && !m.pend && Number(m.id) > 0; }).slice(-CACHE_MAX);
    var put = function (list) { localStorage.setItem(k, JSON.stringify({ o: cacheOwner(), t: Date.now(), m: list.map(packMsg) })); };
    try { put(keep); }
    catch (e) {                         // quota: drop the other cached chats, then try a smaller copy
      try { lsKeys().forEach(function (x) { if (x.indexOf(CPFX) === 0 && x !== k) localStorage.removeItem(x); }); put(keep.slice(-50)); }
      catch (e2) { try { localStorage.removeItem(k); } catch (e3) {} }
    }
    pruneCache(k);
  }
  function pruneCache(keepKey) {      // admins open many support threads: keep only the newest CACHE_KEYS chats
    var ks = lsKeys().filter(function (x) { return x.indexOf(CPFX) === 0; });
    if (ks.length <= CACHE_KEYS) return;
    var aged = ks.filter(function (x) { return x !== keepKey; }).map(function (x) {
      var t = 0; try { t = Number((JSON.parse(localStorage.getItem(x) || "{}") || {}).t) || 0; } catch (e) {}
      return { k: x, t: t };
    }).sort(function (a, b) { return a.t - b.t; });
    aged.slice(0, ks.length - CACHE_KEYS).forEach(function (x) { try { localStorage.removeItem(x.k); } catch (e) {} });
  }
  // keep = owner id whose caches stay ("" = remove every cached chat, e.g. on log out)
  function clearMsgCache(keep) {
    lsKeys().forEach(function (x) { if (x.indexOf(CPFX) === 0 && (!keep || x.indexOf(CPFX + keep + ":") !== 0)) { try { localStorage.removeItem(x); } catch (e) {} } });
  }
  // merges a /api/chat read into a message list: new ids appended, ones the server no longer has (deleted) dropped
  function mergeMsgs(list, d) {
    var out = list.slice(), changed = false, ids = {}, incoming = 0;
    out.forEach(function (m) { ids[m.id] = true; });
    (Array.isArray(d.messages) ? d.messages : []).forEach(function (m) { if (m && m.id && !ids[m.id]) { out.push(m); ids[m.id] = true; changed = true; if (!m.mine) incoming++; } });
    if (Array.isArray(d.live)) {
      var live = {}, min = Infinity, max = 0;
      d.live.forEach(function (x) { live[x] = true; if (x < min) min = x; if (x > max) max = x; });
      var before = out.length;
      // drop only messages inside the live window that the server no longer has (deleted)
      out = out.filter(function (m) { return live[m.id] || m.id > max || (d.live.length && m.id < min); });
      if (out.length !== before) changed = true;
    }
    out.sort(function (a, b) { return a.id - b.id; });
    return { msgs: out, changed: changed, incoming: incoming };
  }
  function roomQuery(room, uid, after) {
    var q = "/api/chat?room=" + encodeURIComponent(room);
    if (uid) q += "&uid=" + encodeURIComponent(uid);
    if (after) q += "&after=" + encodeURIComponent(after);
    return q;
  }
  // background warm-up of one chat's cache (at most one request per Messages-summary cycle)
  var warmBusy = false;
  function warmChat(room, uid) {
    if (warmBusy || !chatReady()) return;
    if (ch && ch.room === room && ch.uid === (uid || "") && screens.indexOf("v-chat") >= 0) return;   // open chat polls itself
    var c0 = readCache(room, uid) || [], last = c0.length ? c0[c0.length - 1].id : 0, owner = cacheOwner();
    warmBusy = true;
    chatApi(roomQuery(room, uid, last)).then(function (d) {
      warmBusy = false;
      if (!d || !d.ok || cacheOwner() !== owner) return;
      var cur = readCache(room, uid) || [];
      // stale by a full page or more: start from the latest page (the next cycle can't fill a gap from the middle)
      if (last && Array.isArray(d.messages) && d.messages.length >= CACHE_MAX) cur = [];
      if (!last) cur = [];
      writeCache(room, uid, mergeMsgs(cur, d).msgs);
    }).catch(function () { warmBusy = false; });
  }
  var chatState = "idle";   // inside Telegram: idle | pending | ok | fail
  var chatFailMsg = "";
  function tgChatLogin() {  // inside Telegram: sign in to chat with initData
    if (!inTg) return Promise.resolve(false);
    chatState = "pending";
    return chatApi("/api/login", { body: { initData: tg.initData }, noAuth: true }).then(function (d) {
      if (saveChatLogin(d)) { chatState = "ok"; return true; }
      chatState = "fail"; chatFailMsg = d.message || "Couldn't sign in to chat."; setChat(null); return false;
    }).catch(function () { chatState = "fail"; chatFailMsg = "Couldn't connect. Check your connection."; return false; });
  }
  function anyUser() {
    var c = getChat(), s = getSession();
    if (c && c.user && c.user.id) return c.user;
    if (s && s.user) return s.user;
    if (inTg && tg.initDataUnsafe && tg.initDataUnsafe.user) return tg.initDataUnsafe.user;
    return null;
  }
  function userLabel(u) {
    if (!u) return "";
    if (u.username) return "@" + u.username;
    return [u.first_name, u.last_name].filter(Boolean).join(" ") || ("ID " + u.id);
  }

  // ---------- API ----------
  function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    if (opts.auth) { var s = getSession(); if (s) headers.Authorization = "Bearer " + s.token; }
    return netFetch(API + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers: opts.body || opts.auth ? headers : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: "omit", mode: "cors" })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (d) { d = d || {}; d._status = r.status; return d; }); });
  }

  // ---------- Groups ----------
  function fmt(n) { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, "") + "M"; if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K"; return String(n); }
  var COLORS = ["#8e44ad", "#e67e22", "#16a085", "#2980b9", "#c0392b", "#27ae60", "#d35400", "#e84393", "#0984e3", "#f39c12", "#1abc9c", "#9b59b6"];
  function color(s) { var h = 0; s = String(s || ""); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return COLORS[Math.abs(h) % COLORS.length]; }
  function letter(s) {
    var chars = Array.from(String(s || ""));
    for (var i = 0; i < chars.length; i++) { try { if (/[\p{L}\p{N}]/u.test(chars[i])) return chars[i].toUpperCase(); } catch (e) { if (/[A-Za-z0-9]/.test(chars[i])) return chars[i].toUpperCase(); } }
    return "#";
  }
  // avatar: photo (https only) with letter fallback
  function avatar(photo, name, seed, cls) {
    var a = el("span", cls || "mav", letter(name)); a.style.background = color(seed);
    setAvImg(a, photo, name);
    return a;
  }
  // puts a photo (https, or a custom profile data:image/jpeg) into an avatar; letter while loading / on error
  function setAvImg(a, photo, name) {
    var src = photoOk(photo);
    a.gcSrc = src;
    if (!src) { a.textContent = letter(name); return; }
    var img = document.createElement("img");
    img.alt = ""; img.referrerPolicy = "no-referrer"; img.loading = "lazy";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:50%";
    img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); if (a.gcSrc === src) a.textContent = letter(name); };
    img.onload = function () { if (a.gcSrc !== src) return; a.textContent = ""; a.appendChild(img); };
    if (/^data:/.test(src)) { a.textContent = ""; a.appendChild(img); }   // local data: shows at once
    img.src = src;
  }
  function card(g, top) {
    var c = el("div", "card");
    var av = el("div", "av", letter(g.title)); av.style.background = color(g.title);
    var info = el("div", "info"), name = el("div", "name");
    name.appendChild(el("span", "t", g.title));
    if (top) name.appendChild(el("span", "badge", "TOP"));
    info.appendChild(name);
    var meta = [];
    if (g.members) meta.push("👥 " + fmt(g.members) + " members");
    if (g.cat) meta.push(g.cat);
    if (!meta.length) meta.push("👥 Telegram group");
    info.appendChild(el("div", "meta", meta.join(" · ")));
    var b = el("button", "join", "Join"); b.type = "button"; b.onclick = function () { open(g.url); };
    c.appendChild(av); c.appendChild(info); c.appendChild(b);
    return c;
  }
  function match(g) {
    var q = sq.groups.trim().toLowerCase();
    if (cat !== "All" && g.cat !== cat) return false;
    return !q || (String(g.title || "") + "\n" + String(g.desc || "")).toLowerCase().indexOf(q) >= 0;
  }
  function render() {
    var list = $("list"); list.textContent = "";
    var f = data.featured.filter(match), a = data.groups.filter(match);
    if (f.length) { list.appendChild(el("div", "sec", "⭐ Featured")); f.forEach(function (g) { list.appendChild(card(g, true)); }); }
    if (a.length) { list.appendChild(el("div", "sec", "All groups")); a.forEach(function (g) { list.appendChild(card(g, false)); }); }
    if (!f.length && !a.length && sq.groups.trim() && (data.featured.length || data.groups.length)) { list.appendChild(el("div", "noresults", "No results")); return; }
    if (!f.length && !a.length) {
      var e = el("div", "empty"), none = !data.featured.length && !data.groups.length;
      e.appendChild(el("b", null, none ? "No groups yet" : "No groups found"));
      e.appendChild(document.createTextNode(none ? "Be the first: promote your group." : "Try another name."));
      list.appendChild(e);
    }
  }
  // Always "All" + every configured category, in config order (even when no group has it yet).
  function chips() {
    var box = $("chips"); box.textContent = "";
    if (!CATS.length) { box.classList.add("hide"); return; }
    if (cat !== "All" && CATS.indexOf(cat) < 0) cat = "All";
    box.classList.remove("hide");
    ["All"].concat(CATS).forEach(function (c) {
      var b = el("button", "chip" + (c === cat ? " on" : ""), c); b.type = "button";
      b.onclick = function () { cat = c; chips(); render(); };
      box.appendChild(b);
    });
  }
  function clean(list) {
    return (Array.isArray(list) ? list : []).filter(function (g) { return g && safeUrl(g.url); })
      .map(function (g) { return { title: String(g.title || "Telegram Group"), url: String(g.url), members: Number(g.members) || 0, cat: g.cat ? String(g.cat) : "", desc: String(g.desc || g.description || "") }; });
  }
  function load() {
    api("/app/api/groups").then(function (d) {
      if (!d.ok) throw new Error("bad");
      net.groupsFailed = false;
      data.featured = clean(d.featured); data.groups = clean(d.groups);
      if (d.bot) data.bot = String(d.bot);
      data.short = String(d.short || "");
      data.price = Number(d.price) || data.price; data.topPrice = Number(d.topPrice) || data.topPrice; data.days = Number(d.days) || data.days;
      prices(); $("promo").classList.remove("hide");
      chips(); render();
    }).catch(function () {
      net.groupsFailed = true;
      var list = $("list"); list.textContent = "";
      var e = el("div", "empty"); e.appendChild(el("b", null, "Couldn't load groups")); e.appendChild(document.createTextNode("Check your connection."));
      var b = el("button", "big", "Try again"); b.type = "button"; b.onclick = function () { list.textContent = ""; list.appendChild(el("div", "empty", "Loading groups…")); load(); };
      e.appendChild(b); list.appendChild(e);
    });
  }

  // ---------- account display ----------
  function renderAccount() {
    var s = inTg ? null : getSession(), u = inTg ? null : (getSession() || getChat()) && anyUser();
    var box = $("acct-groups"); box.textContent = "";
    box.onclick = null; box.style.cursor = "";
    $("acct-row").classList.toggle("hide", inTg);
    if (inTg) { box.classList.add("hide"); }
    else if (u) {
      box.appendChild(avatar(myPhoto(), myName(), String(u.id || ""), "av-s")); box.appendChild(el("span", "nm", userLabel(u)));
      box.onclick = function () { tab("profile"); }; box.style.cursor = "pointer";
      box.classList.remove("hide");
    } else {
      var b = el("button", "pill", "Log in"); b.type = "button"; b.onclick = function () { tab("profile"); };
      box.appendChild(b); box.classList.remove("hide");
    }
    $("userbar").classList.toggle("hide", inTg || !s);
    if (s) $("userbar-name").textContent = "Logged in as " + userLabel(s.user);
  }

  // ---------- Telegram Login Widget (browser only) ----------
  var widgetMounted = {};
  // Browser login: the same Telegram data signs in to the worker (groups/payments) and to this site's chat API.
  window.gcOnTelegramAuth = function (user) {
    loginMsg("Checking your Telegram login…", "");
    var w = api("/web/api/login", { body: user || {} }).then(function (d) {
      if (!d.ok || !d.token) return d.message || "Telegram login could not be checked.";
      setSession({ token: d.token, exp: d.exp, user: d.user || { id: user && user.id } });
      return "";
    }).catch(function () { return "Couldn't connect."; });
    var c = chatApi("/api/login", { body: user || {}, noAuth: true }).then(function (d) {
      if (!saveChatLogin(d)) return d.message || "Chat login failed.";
      return "";
    }).catch(function () { return "Couldn't connect to chat."; });
    Promise.all([w, c]).then(function (r) {
      var we = r[0], ce = r[1];
      if (we && ce) loginMsg(we + " Please try again.", "err");
      else if (we) loginMsg("Chat is on, but promoting is not available right now (" + we + ")", "err");
      else if (ce) loginMsg("Logged in. Chat and support are not available right now (" + ce + ")", "err");
      else loginMsg("", "");
      mineLoaded = false; renderAccount(); showPromote(); refreshTab();
      if (!we) { loadBalance(); if (starsOpen()) showStars(); }
      if (!ce && current !== "msg") loadSummary(true);   // badge + warm the chat cache so the first open is instant
    });
  };
  function loginMsg(text, kind) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-lstatus]"), function (m) {
      m.className = "msg" + (kind ? " " + kind : ""); m.textContent = text; if (!text) m.classList.add("hide");
    });
  }
  function mountLogin(box) {
    if (widgetMounted[box.id]) return;
    widgetMounted[box.id] = true;
    box.textContent = "";
    var wait = el("div", "login-wait", "Loading Telegram login…"); box.appendChild(wait);
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.setAttribute("data-telegram-login", BOT);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-radius", "12");
    s.setAttribute("data-request-access", "write");
    s.setAttribute("data-onauth", "gcOnTelegramAuth(user)");
    var failed = function () {
      if (box.querySelector("iframe")) return;
      box.textContent = "";
      box.appendChild(el("div", "login-wait", "Telegram login didn't load here."));
      var b = el("button", "big", "Open Group City in Telegram"); b.type = "button"; b.onclick = function () { open(appLink("promote") || botLink("promote")); };
      box.appendChild(b);
      widgetMounted[box.id] = false;
    };
    s.onload = function () { setTimeout(function () { if (box.querySelector("iframe")) { if (wait.parentNode) wait.parentNode.removeChild(wait); } else failed(); }, 2500); };
    s.onerror = failed;
    box.appendChild(s);
  }
  function loginPanel(container, o) {   // Telegram login prompt (browser)
    o = o || {};
    var id = o.id || "login-mine";
    var e = el("div", "panel");
    e.appendChild(el("h3", null, o.title || "Log in to see your groups"));
    e.appendChild(el("p", "hint", o.hint || "Log in with your Telegram account to see the groups you promoted."));
    var box = el("div", "login-box"); box.id = id; e.appendChild(box);
    var st = el("div", "msg hide"); st.setAttribute("data-lstatus", "1"); e.appendChild(st);
    container.appendChild(e);
    widgetMounted[id] = false;
    mountLogin(box);
  }

  // ---------- Promote ----------
  function showPromote() {
    var logged = inTg || !!getSession();
    var showing = !$("pr-terms").classList.contains("hide");
    $("pr-login").classList.toggle("hide", logged);
    if (!logged) { $("pr-form").classList.add("hide"); $("pr-terms").classList.add("hide"); mountLogin($("login-promote")); return; }
    if (!showing) $("pr-form").classList.remove("hide");
  }
  function setPkg(p) {
    pkg = p === "normal" ? "normal" : "top";
    $("pk-normal").classList.toggle("on", pkg === "normal"); $("pk-top").classList.toggle("on", pkg === "top");
    $("pr-buy").textContent = "Pay · " + pkgCost() + " ⭐";
    lowCheck();
  }
  function pkgCost() { return pkg === "top" ? data.topPrice : data.price; }
  function prices() {
    var d = data.days ? " · " + data.days + " days" : "";
    $("pk-normal-p").textContent = data.price + " ⭐"; $("pk-top-p").textContent = data.topPrice + " ⭐";
    $("pk-normal-d").textContent = "Listed in All Groups" + d; $("pk-top-d").textContent = "Shown at the top" + d;
    $("promo-sub").textContent = "From " + data.price + " Stars";
    setPkg(pkg);
  }
  function catPicker() {
    var box = $("pr-cats"); box.textContent = "";
    $("pr-cats").parentNode.classList.toggle("hide", !CATS.length);
    CATS.forEach(function (c) {
      var b = el("button", "catb" + (c === prCat ? " on" : ""), c); b.type = "button";
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", c === prCat ? "true" : "false");
      b.onclick = function () { prCat = c; box.classList.remove("need"); catPicker(); if ($("pr-msg").textContent === "Choose a category") msg("", ""); };
      box.appendChild(b);
    });
  }
  function resetForm() { $("pr-url").value = ""; $("pr-title").value = ""; prCat = ""; catPicker(); }
  function msg(text, kind) { var m = $("pr-msg"); m.className = "msg" + (kind ? " " + kind : ""); m.textContent = text; if (!text) m.classList.add("hide"); }
  function showOnly(id) { ["pr-form", "pr-terms"].forEach(function (x) { $(x).classList.toggle("hide", x !== id); }); $("sheet").scrollTop = 0; }
  function openSheet() { $("v-promote").classList.remove("hide"); document.body.classList.add("lock"); showPromote(); if (loggedIn()) loadBalance(); }
  function closeSheet() { $("v-promote").classList.add("hide"); closeStars(); syncBack(); }
  function promote(prefill) {
    if (prefill && prefill.url) { $("pr-url").value = prefill.url; $("pr-title").value = prefill.title && prefill.title.charAt(0) !== "@" ? prefill.title : ""; }
    if (inTg || getSession()) showOnly("pr-form");
    openSheet();
  }
  function buy(agree) {
    if (busy) return;
    if (CATS.length && CATS.indexOf(prCat) < 0) { showOnly("pr-form"); $("pr-cats").classList.add("need"); msg("Choose a category", "err"); return; }
    var url = $("pr-url").value.trim();
    if (!/^(https?:\/\/)?(t\.me|telegram\.me)\/\S+$/i.test(url) && !/^@[A-Za-z0-9_]{4,}$/.test(url)) { msg("Enter your Telegram group link, like https://t.me/yourgroup", "err"); $("pr-url").focus(); return; }
    if (stars.bal != null && stars.bal < pkgCost()) { showOnly("pr-form"); msg("", ""); showLow(pkgCost() - stars.bal); return; }   // known short: no request
    var body = { title: $("pr-title").value.trim(), url: url, pkg: pkg, agree: agree === true };
    if (prCat) body.cat = prCat;
    var req;
    if (inTg) { body.initData = tg.initData; req = api("/app/api/promote-balance", { body: body }); }
    else if (getSession()) req = api("/web/api/promote-balance", { body: body, auth: true });
    else { showPromote(); return; }
    var top = pkg === "top";
    busy = true; $("pr-buy").disabled = true; $("pr-terms-ok").disabled = true; msg("Paying from your balance…", "");
    req.then(function (d) {
      busy = false; $("pr-buy").disabled = false; $("pr-terms-ok").disabled = false;
      if (d._status === 401) {
        if (inTg) { showOnly("pr-form"); msg("Your Telegram session expired. Close and open Group City again.", "err"); return; }
        setSession(null); renderAccount(); showPromote(); loginMsg("Please log in with Telegram again.", "err"); return;
      }
      if (d.error === "terms") { $("pr-terms-text").textContent = String(d.terms || ""); showOnly("pr-terms"); return; }
      showOnly("pr-form");
      if (d.balance != null && isFinite(Number(d.balance))) setBal(Number(d.balance));
      if (d.error === "balance") { msg("", ""); showLow(Number(d.need) || Math.max(1, (Number(d.price) || pkgCost()) - (stars.bal || 0))); return; }
      if (d.ok) {
        var until = Number(d.until) ? " until " + new Date(Number(d.until)).toISOString().slice(0, 10) : "";
        msg("✅ Paid " + (Number(d.price) || pkgCost()) + " ⭐ from your balance. Your group is listed" + (top ? " in ⭐ Featured" : " in All Groups") + until + ".", "okm");
        resetForm(); mineLoaded = false;
        setTimeout(load, 800);
        return;
      }
      msg(d.error === "nodb" ? "Stars balance is not available right now. Please try again later." : (d.message || "Something went wrong. Please try again."), "err");
    }).catch(function () { busy = false; $("pr-buy").disabled = false; $("pr-terms-ok").disabled = false; showOnly("pr-form"); msg("Couldn't connect. Check your connection.", "err"); });
  }
  // "Not enough Stars" box in the Promote form; its Top up opens the Stars sheet with a pack that covers the gap
  var lowNeed = 0;
  function showLow(need) {
    lowNeed = Math.max(1, Math.ceil(Number(need) || 1));
    $("pr-low-d").textContent = "You have " + fmtStars(stars.bal || 0) + " ⭐. " + (pkg === "top" ? "TOP" : "Normal") + " costs " + fmtStars(pkgCost()) + " ⭐, so you need " + fmtStars(lowNeed) + " more.";
    $("pr-low").classList.remove("hide"); $("pr-buy").classList.add("hide");
  }
  function hideLow() { lowNeed = 0; $("pr-low").classList.add("hide"); $("pr-buy").classList.remove("hide"); }
  function lowCheck() {   // after the balance or the package changes
    if ($("pr-low").classList.contains("hide")) return;
    if (stars.bal != null && stars.bal >= pkgCost()) hideLow(); else showLow(pkgCost() - (stars.bal || 0));
  }

  // ---------- Stars balance (worker D1) + top-up ----------
  var stars = { bal: null, packs: [10, 50, 100, 250, 500], pick: 0, fromPromote: false, busy: false, termsPack: 0, gen: 0, view: "st-main", need: 0, max: 10000, me: null, hist: null, histGen: 0 };
  function loggedIn() { return inTg || !!getSession(); }
  function fmtStars(n) { return String(Math.max(0, Math.floor(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function setBal(n) {
    stars.bal = n == null ? null : Math.max(0, Math.floor(Number(n) || 0));
    var t = fmtStars(stars.bal || 0);
    $("hd-bal").textContent = t; $("st-bal").textContent = t; $("pr-bal-n").textContent = t; $("pf-stars-v").textContent = t; $("set-stars-v").textContent = t;
    $("st-bal-b").textContent = t; $("sd-bal").textContent = "Balance: " + t + " ⭐ · up to " + fmtStars(stars.max) + " per transfer"; sdCheck();
    $("hd-stars").setAttribute("aria-label", "Stars balance: " + t);
    lowCheck();
  }
  function balReq() {
    if (inTg) return api("/app/api/balance", { body: { initData: tg.initData } });
    if (getSession()) return api("/web/api/balance", { auth: true });
    return null;
  }
  function loadBalance() {   // resolves to the balance (or null)
    var req = balReq();
    if (!req) { setBal(null); return Promise.resolve(null); }
    var gen = ++stars.gen;
    return req.then(function (d) {
      if (d._status === 401 && !inTg) { setSession(null); renderAccount(); }
      if (d.ok && Array.isArray(d.packs) && d.packs.length) stars.packs = d.packs.map(Number).filter(function (n) { return n > 0; });
      if (d.ok && Number(d.transferMax) > 0) stars.max = Math.floor(Number(d.transferMax));
      if (d.ok && /^\d{1,20}$/.test(String(d.id || ""))) stars.me = { id: String(d.id), username: /^[A-Za-z0-9_]{1,40}$/.test(String(d.username || "")) ? String(d.username) : "" };
      if (gen === stars.gen && d.ok) setBal(d.balance);
      return d.ok ? stars.bal : null;
    }).catch(function () { return null; });
  }
  function starsOpen() { return !$("v-stars").classList.contains("hide"); }
  function stMsg(text, kind) { var m = $("st-msg"); m.className = "msg" + (kind ? " " + kind : ""); m.textContent = text; if (!text) m.classList.add("hide"); }
  // wallet views inside the Stars sheet: st-main (balance, Send / Receive / Buy, History), st-body (Buy packs), st-send,
  // st-done (sent), st-recv (Receive), st-terms
  var ST_VIEWS = ["st-main", "st-body", "st-send", "st-done", "st-recv", "st-terms"];
  var ST_HEAD = { "st-main": ["Stars", "Your Group City balance"], "st-body": ["Buy Stars", "Top up your Group City balance"], "st-send": ["Send Stars", "To another Group City user"],
    "st-done": ["Send Stars", "To another Group City user"], "st-recv": ["Receive Stars", "Share your ID or username"], "st-terms": ["Buy Stars", "Top up your Group City balance"] };
  function stOnly(id) {
    ST_VIEWS.forEach(function (x) { $(x).classList.toggle("hide", x !== id); });
    stars.view = id;
    var h = ST_HEAD[id] || ST_HEAD["st-main"];
    $("st-title").textContent = h[0]; $("st-sub").textContent = h[1];
    $("st-back").classList.toggle("hide", id === "st-main");
    if (id !== "st-send") sdConfShow(false);
    try { $("st-sheet").scrollTop = 0; } catch (e) {}
  }
  function stBack() {
    var v = stars.view;
    if (v === "st-send" && !$("sd-conf").classList.contains("hide")) { sdConfShow(false); return; }
    if (v === "st-terms") { stOnly("st-body"); return; }
    if (v === "st-body" && stars.fromPromote) { closeStars(); return; }
    stOnly("st-main"); loadHist();
  }
  function packFor(need) {   // smallest pack that covers `need` (largest pack when none does)
    var ps = stars.packs.slice().sort(function (a, b) { return a - b; });
    for (var i = 0; i < ps.length; i++) if (ps[i] >= need) return ps[i];
    return ps[ps.length - 1] || 0;
  }
  function renderPacks() {
    var box = $("st-packs"); box.textContent = "";
    stars.packs.forEach(function (n, i) {
      var b = el("button", "stpack" + (n === stars.pick ? " on" : "")); b.type = "button"; b.setAttribute("role", "listitem");
      b.setAttribute("data-pack", String(n));
      var ic = el("span", "stack"); for (var k = 0; k <= Math.min(i, 2); k++) ic.appendChild(starIcon());
      b.appendChild(ic);
      var mid = el("span", "spi"); mid.appendChild(el("span", "spn", fmtStars(n) + " Stars"));
      if (n === stars.pick && (lowNeed || stars.need)) mid.appendChild(el("span", "spd", "Covers what you need"));
      b.appendChild(mid);
      b.appendChild(el("span", "spb", "Buy"));
      b.onclick = function () { stars.pick = n; topup(n, false); };
      box.appendChild(b);
    });
  }
  function starIcon() {
    var ns = "http://www.w3.org/2000/svg", sv = document.createElementNS ? document.createElementNS(ns, "svg") : el("svg");
    sv.setAttribute("viewBox", "0 0 24 24"); sv.setAttribute("aria-hidden", "true"); sv.setAttribute("class", "stico");
    var pth = document.createElementNS ? document.createElementNS(ns, "path") : el("path");
    pth.setAttribute("d", "M12 2.2l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.1l-5.9 3.2 1.3-6.6-4.9-4.6 6.6-.8z"); sv.appendChild(pth);
    return sv;
  }
  function showStars() {
    var logged = loggedIn();
    $("st-login").classList.toggle("hide", logged);
    if (!logged) {
      ST_VIEWS.forEach(function (x) { $(x).classList.add("hide"); });
      $("st-title").textContent = "Stars"; $("st-sub").textContent = "Your Group City balance"; $("st-back").classList.add("hide");
      mountLogin($("login-stars")); return;
    }
    stOnly(stars.view || "st-main");
    renderPacks();
    if (stars.view === "st-main") loadHist();
    if (stars.view === "st-recv") renderRecv();
  }
  // o: {need} → Buy with the pack that covers it, {buy}, {send: "@user" | id}, {recv}; default = wallet home
  function openStars(o) {
    o = o || {};
    stars.fromPromote = !!o.fromPromote;
    stars.need = 0;
    stars.pick = o.need ? packFor(o.need) : 0;
    stMsg("", ""); $("st-refresh").classList.add("hide");
    var v = o.need || o.buy ? "st-body" : o.send != null ? "st-send" : o.recv ? "st-recv" : "st-main";
    if (v === "st-send") sdReset(o.send ? String(o.send) : "");
    stars.view = v;
    $("v-stars").classList.remove("hide"); document.body.classList.add("lock");
    showStars();
    if (loggedIn()) loadBalance().then(function () { if (starsOpen()) { renderPacks(); if (stars.view === "st-recv") renderRecv(); } });
    if (v === "st-send" && o.send) sdLookup(true);
  }
  function starsReq(path, body) {   // wallet endpoints on the worker: Mini App initData, or the browser session
    body = body || {};
    if (inTg) { body.initData = tg.initData; return api("/app/api/" + path, { body: body }); }
    if (getSession()) return api("/web/api/" + path, { body: body, auth: true });
    return null;
  }
  function starsAuthLost(d) {   // 401: browser session ended → log in again
    if (d._status !== 401) return false;
    if (!inTg) { setSession(null); renderAccount(); showStars(); loginMsg("Please log in with Telegram again.", "err"); }
    return true;
  }

  // ---------- wallet: History ----------
  function hDate(ts) {
    var d = new Date(Number(ts) || 0), M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return M[d.getMonth()] + " " + d.getDate() + (d.getFullYear() !== new Date().getFullYear() ? ", " + d.getFullYear() : "") + " · " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function peerLabel(p) { return p ? (p.username ? "@" + p.username : String(p.name || ("User " + p.id))) : "someone"; }
  var H_ICON = { topup: "M12 5v14M5 12h14", promote: "M4 10v4h3l6 4V6L7 10zM16.5 9a4 4 0 010 6", promote_refund: "M9 14 4 9l5-5M4 9h11a5 5 0 010 10h-2", refund: "M9 14 4 9l5-5M4 9h11a5 5 0 010 10h-2", refund_undo: "M15 14l5-5-5-5M20 9H9a5 5 0 000 10h2", other: "M12 7v5l3 2" };
  function hIcon(type) {
    var ns = "http://www.w3.org/2000/svg", w = el("span", "hic hic-" + type);
    var sv = document.createElementNS ? document.createElementNS(ns, "svg") : el("svg"); sv.setAttribute("viewBox", "0 0 24 24"); sv.setAttribute("aria-hidden", "true");
    var pth = document.createElementNS ? document.createElementNS(ns, "path") : el("path"); pth.setAttribute("d", H_ICON[type] || H_ICON.other); sv.appendChild(pth);
    w.appendChild(sv); return w;
  }
  function histTitle(it) {
    switch (it.type) {
      case "topup": return "Bought Stars";
      case "promote": return it.top ? "Promote · TOP" : "Promote · Normal";
      case "promote_refund": return "Promote not added · Stars back";
      case "refund": return "Top-up refunded";
      case "refund_undo": return "Refund cancelled · Stars back";
      case "sent": return "Sent to " + peerLabel(it.peer);
      case "received": return "Received from " + peerLabel(it.peer);
    }
    return "Balance change";
  }
  function histRow(it) {
    var r = el("div", "hrow"); r.setAttribute("role", "listitem"); r.setAttribute("data-type", String(it.type || ""));
    if ((it.type === "sent" || it.type === "received") && it.peer) r.appendChild(avatar("", it.peer.name || peerLabel(it.peer), String(it.peer.id), "av hav"));
    else r.appendChild(hIcon(it.type));
    var mid = el("div", "hmid");
    mid.appendChild(el("div", "ht", histTitle(it)));
    mid.appendChild(el("div", "hs", hDate(it.at) + (it.note ? " · " + it.note : "")));
    r.appendChild(mid);
    var a = Math.floor(Number(it.amount) || 0);
    var am = el("div", "ham " + (a >= 0 ? "plus" : "minus"), (a >= 0 ? "+" : "−") + fmtStars(Math.abs(a)));
    am.appendChild(starIcon()); r.appendChild(am);
    return r;
  }
  function renderHist() {
    var box = $("st-hist"); box.textContent = "";
    var h = stars.hist;
    if (h == null) { box.appendChild(el("div", "hempty", "Loading…")); return; }
    if (h === "err") { box.appendChild(el("div", "hempty", "Couldn't load history.")); return; }
    if (!h.length) { box.appendChild(el("div", "hempty", "No transactions yet. Buy, send or receive Stars and they show up here.")); return; }
    h.forEach(function (it) { if (it && typeof it === "object") box.appendChild(histRow(it)); });
  }
  function loadHist() {
    var req = starsReq("history");
    if (!req) return;
    var gen = ++stars.histGen;
    if (stars.hist === "err") stars.hist = null;
    renderHist();
    req.then(function (d) {
      if (gen !== stars.histGen) return;
      if (starsAuthLost(d)) return;
      stars.hist = d.ok && Array.isArray(d.items) ? d.items.slice(0, 30) : "err";
      if (d.ok && d.balance != null) setBal(d.balance);
      renderHist();
    }).catch(function () { if (gen === stars.histGen) { stars.hist = stars.hist || "err"; renderHist(); } });
  }

  // ---------- wallet: Send ----------
  var sd = { user: null, q: "", seq: 0, key: "", busy: false, timer: 0, look: false };
  function sdMsg(text, kind) { var m = $("sd-msg"); m.className = "msg" + (kind ? " " + kind : ""); m.textContent = text; if (!text) m.classList.add("hide"); }
  function sdErr(text) { var e = $("sd-err"); e.textContent = text || ""; e.classList.toggle("hide", !text); }
  function sdAmount() { var v = String($("sd-amt").value || "").trim(); return /^\d{1,9}$/.test(v) ? Number(v) : 0; }
  function sdReset(to) {
    sd.user = null; sd.q = ""; sd.key = ""; sd.busy = false; sd.seq++;
    $("sd-to").value = to || ""; $("sd-amt").value = ""; $("sd-note").value = ""; $("sd-ncount").textContent = "100";
    $("sd-who").textContent = ""; $("sd-who").classList.add("hide"); sdErr(""); sdMsg("", ""); $("sd-topup").classList.add("hide");
    sdConfShow(false); sdChips(); sdCheck();
  }
  function sdChips() {
    var a = sdAmount();
    Array.prototype.forEach.call($("sd-chips").children, function (b) { b.classList.toggle("on", Number(b.getAttribute("data-amt")) === a); });
  }
  // validates the form and sets the Send button ("Send ⭐ 50"); also shows Not enough Stars + Top up
  function sdCheck() {
    if (!$("sd-go") || !sd) return false;
    var a = sdAmount(), bal = stars.bal || 0, go = $("sd-go"), low = false, okv = true;
    go.textContent = a ? "Send ⭐ " + fmtStars(a) : "Send ⭐";
    if (!sd.user || sd.busy) okv = false;
    if (a < 1) okv = false;
    if (a > stars.max) { okv = false; if (!sd.busy) sdMsg("You can send up to " + fmtStars(stars.max) + " Stars at a time.", "err"); }
    else if (a > 0 && stars.bal != null && a > bal) { okv = false; low = true; if (!sd.busy) sdMsg("Not enough Stars. You have " + fmtStars(bal) + " ⭐, so you need " + fmtStars(a - bal) + " more.", "err"); }
    else if (/^(You can send up to|Not enough Stars)/.test($("sd-msg").textContent)) sdMsg("", "");
    $("sd-topup").classList.toggle("hide", !low);
    go.disabled = !okv;
    return okv;
  }
  function sdWho(u) {
    var box = $("sd-who"); box.textContent = "";
    if (!u) { box.classList.add("hide"); return; }
    box.appendChild(avatar(u.photo || "", u.name, String(u.id), "av sdav"));
    var t = el("div", "sdw-t"); t.appendChild(el("div", "sdw-n", u.name));
    t.appendChild(el("div", "sdw-u", (u.username ? "@" + u.username + " · " : "") + "ID " + u.id));
    box.appendChild(t);
    var ck = el("span", "sdw-ok", "✓"); ck.setAttribute("aria-label", "Found"); box.appendChild(ck);
    box.classList.remove("hide");
  }
  function sdLookup(now) {
    clearTimeout(sd.timer);
    var q = String($("sd-to").value || "").trim();
    if (q === sd.q && (sd.user || sd.look)) return;
    sd.q = q; sd.user = null; sd.key = ""; sdWho(null); sdErr(""); sdCheck();
    if (!q) return;
    var go = function () {
      var req = starsReq("lookup-user", { q: q });
      if (!req) return;
      var my = ++sd.seq; sd.look = true;
      $("sd-who").classList.remove("hide"); $("sd-who").textContent = ""; $("sd-who").appendChild(el("div", "sdw-l", "Looking up…"));
      req.then(function (d) {
        if (my !== sd.seq) return;
        sd.look = false;
        if (starsAuthLost(d)) return;
        if (d.ok && d.user && /^\d{1,20}$/.test(String(d.user.id))) {
          sd.user = { id: String(d.user.id), username: /^[A-Za-z0-9_]{1,40}$/.test(String(d.user.username || "")) ? String(d.user.username) : "", name: String(d.user.name || "User " + d.user.id).slice(0, 80), photo: "" };
          sdWho(sd.user); sdCheck(); sdProfile(sd.user, my);
          return;
        }
        sdWho(null);
        sdErr(d.error === "notfound" ? "User not found. They must open Group City once." : d.error === "self" ? "You can't send Stars to yourself." : (d.message || "Couldn't find this user."));
      }).catch(function () { if (my === sd.seq) { sd.look = false; sdWho(null); sdErr("Couldn't connect. Check your connection."); } });
    };
    if (now) go(); else sd.timer = setTimeout(go, 600);
  }
  // their Group City profile (custom name + photo from Edit Info), when they saved one
  function sdProfile(u, my) {
    if (!chatReady()) return;
    chatApi("/api/profile?tid=" + encodeURIComponent(u.id)).then(function (d) {
      if (my !== sd.seq || !sd.user || sd.user.id !== u.id || !d || !d.ok || !d.profile) return;
      var p = d.profile;
      if (p.name) sd.user.name = String(p.name).slice(0, 80);
      if (photoOk(p.photo)) sd.user.photo = p.photo;
      sdWho(sd.user);
    }).catch(function () {});
  }
  function newKey() {
    var r = "";
    try { var a = new Uint32Array(3); window.crypto.getRandomValues(a); for (var i = 0; i < a.length; i++) r += a[i].toString(36); } catch (e) { r = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
    return ("w" + Date.now().toString(36) + r).replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  }
  function sdConfShow(on) { var c = $("sd-conf"); if (c) c.classList.toggle("hide", !on); }
  function sdConfirm() {
    if (!sdCheck() || sd.busy) return;
    var a = sdAmount(), u = sd.user, note = String($("sd-note").value || "").trim();
    if (!sd.key) sd.key = newKey();            // one key per attempt: a retry after a lost answer can't send twice
    var av = $("sd-conf-av"); av.textContent = ""; av.appendChild(avatar(u.photo || "", u.name, u.id, "av sdcav"));
    $("sd-conf-t").textContent = "Send " + fmtStars(a) + " ⭐ to " + u.name + "?";
    $("sd-conf-d").textContent = (u.username ? "@" + u.username + " · " : "") + "ID " + u.id + (note ? "\nNote: " + note : "") + "\nSent Stars can't be refunded.";
    $("sd-conf-ok").textContent = "Send ⭐ " + fmtStars(a); $("sd-conf-ok").disabled = false;
    sdConfShow(true);
  }
  function sdSend() {
    if (sd.busy || !sd.user) return;
    var a = sdAmount(), u = sd.user, note = String($("sd-note").value || "").trim();
    var req = starsReq("transfer", { to: u.id, amount: a, note: note, key: sd.key || (sd.key = newKey()) });
    if (!req) return;
    sd.busy = true; $("sd-conf-ok").disabled = true; $("sd-go").disabled = true; sdMsg("Sending…", "");
    req.then(function (d) {
      sd.busy = false; $("sd-conf-ok").disabled = false; sdConfShow(false);
      if (d._status === 401) { if (inTg) sdMsg("Your Telegram session expired. Close and open Group City again.", "err"); else starsAuthLost(d); return; }
      if (d.ok) {
        if (d.balance != null) setBal(d.balance);
        sdDone(a, u, note, d);
        stars.hist = null; sd.key = "";
        return;
      }
      sd.key = "";   // refused: nothing moved, the next tap is a new attempt
      if (d.balance != null && isFinite(Number(d.balance))) setBal(Number(d.balance));
      if (d.error === "balance") { sdMsg("", ""); sdCheck(); if (!/Not enough/.test($("sd-msg").textContent)) sdMsg("Not enough Stars. You have " + fmtStars(stars.bal || 0) + " ⭐.", "err"); $("sd-topup").classList.remove("hide"); return; }
      if (d.error === "notfound" || d.error === "self") { sd.user = null; sdWho(null); sdErr(d.error === "self" ? "You can't send Stars to yourself." : "User not found. They must open Group City once."); sdMsg("", ""); sdCheck(); return; }
      sdMsg(d.error === "nodb" ? "Stars balance is not available right now. Please try again later." : (d.message || "Something went wrong. Please try again."), "err"); sdCheck();
    }).catch(function () {
      sd.busy = false; $("sd-conf-ok").disabled = false; sdConfShow(false); sdCheck();
      sdMsg("Couldn't connect. Tap Send to try again — you won't be charged twice.", "err");   // same key on retry
    });
  }
  function sdDone(a, u, note, d) {
    $("sdd-t").textContent = fmtStars(a) + " Stars sent";
    $("sdd-d").textContent = "to " + u.name + (u.username ? " (@" + u.username + ")" : "");
    $("sdd-n").textContent = note ? "“" + note + "”" : ""; $("sdd-n").classList.toggle("hide", !note);
    $("sdd-b").textContent = "Balance: " + fmtStars(d.balance != null ? d.balance : stars.bal) + " ⭐";
    stOnly("st-done");
    if (tg && tg.HapticFeedback) { try { tg.HapticFeedback.notificationOccurred("success"); } catch (e) {} }
  }

  // ---------- wallet: Receive ----------
  function myWalletId() {
    if (stars.me && stars.me.id) return stars.me.id;
    if (inTg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) return String(tg.initDataUnsafe.user.id);
    var s = getSession(); var m = s && /^(\d+)\./.exec(s.token); return m ? m[1] : "";
  }
  function myWalletUser() {
    if (stars.me && stars.me.username) return stars.me.username;
    var u = anyUser(); return u && /^[A-Za-z0-9_]{1,40}$/.test(String(u.username || "")) ? String(u.username) : "";
  }
  function recvLink() { var id = myWalletId(); return id ? botLink("send_" + id) : ""; }
  function recvText() { var l = recvLink(); return l ? "Send me Stars on Group City: " + l : ""; }
  function rcMsg(text, kind) { var m = $("rc-msg"); m.className = "msg" + (kind ? " " + kind : ""); m.textContent = text; if (!text) m.classList.add("hide"); }
  function renderRecv() {
    var id = myWalletId(), un = myWalletUser();
    var av = $("rc-av"); av.textContent = ""; av.appendChild(avatar(myPhoto(), myName(), id, "av rcavi"));
    $("rc-name").textContent = myName() || (un ? "@" + un : "");
    $("rc-id").textContent = id || "—";
    $("rc-user").textContent = un ? "@" + un : "No username";
    $("rc-user-c").classList.toggle("hide", !un);
    $("rc-share-t").textContent = recvText();
  }
  function copyText(t, what) {
    if (!t) return;
    var done = function () { rcMsg(what + " copied", "okm"); };
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(done, function () { rcMsg("Couldn't copy. Press and hold the text to copy it.", "err"); }); return; } } catch (e) {}
    rcMsg("Couldn't copy. Press and hold the text to copy it.", "err");
  }
  function recvShare() {
    var l = recvLink(); if (!l) return;
    var txt = "Send me Stars on Group City";
    if (inTg) { open("https://t.me/share/url?url=" + encodeURIComponent(l) + "&text=" + encodeURIComponent(txt)); return; }
    try { if (navigator.share) { navigator.share({ title: "Group City", text: txt, url: l }).catch(function () {}); return; } } catch (e) {}
    copyText(recvText(), "Share text");
  }
  function closeStars() { if (!$("v-stars")) return; $("v-stars").classList.add("hide"); stars.fromPromote = false; syncBack(); }
  function topup(n, agree) {
    if (stars.busy) return;
    var body = { pack: n, agree: agree === true }, req;
    if (inTg) { body.initData = tg.initData; req = api("/app/api/topup", { body: body }); }
    else if (getSession()) req = api("/web/api/topup", { body: body, auth: true });
    else { showStars(); return; }
    stars.busy = true; stMsg("Preparing payment…", ""); renderPacks();
    req.then(function (d) {
      stars.busy = false;
      if (d._status === 401) {
        if (inTg) { stMsg("Your Telegram session expired. Close and open Group City again.", "err"); return; }
        setSession(null); renderAccount(); showStars(); loginMsg("Please log in with Telegram again.", "err"); return;
      }
      if (d.error === "terms") { stars.termsPack = n; $("st-terms-text").textContent = String(d.terms || ""); stOnly("st-terms"); return; }
      stOnly("st-body");
      if (d.ok && isTgUrl(d.link)) { stMsg("", ""); payTopup(d.link, n); return; }
      stMsg(d.error === "nodb" ? "Stars balance is not available right now. Please try again later." : (d.message || "Something went wrong. Please try again."), "err");
    }).catch(function () { stars.busy = false; stOnly("st-body"); stMsg("Couldn't connect. Check your connection.", "err"); });
  }
  function payTopup(link, n) {
    var before = stars.bal || 0;
    var done = function (status) {
      if (status === "paid") { stMsg("✅ Paid! Adding " + fmtStars(n) + " Stars to your balance…", "okm"); waitCredit(before + n, n, 0); }
      else if (status === "pending") { stMsg("Payment is being processed…", ""); waitCredit(before + n, n, 0); }
      else if (status === "cancelled") stMsg("Payment cancelled.", "");
      else if (status === "failed") stMsg("Payment failed. Please try again.", "err");
    };
    try { if (inTg && tg.openInvoice) { tg.openInvoice(link, done); return; } } catch (e) {}
    open(link);   // browser: Telegram opens the invoice; the balance is checked again on return
    stMsg("Telegram opens the payment. After you pay, come back here; your balance updates by itself.", "");
    $("st-refresh").classList.remove("hide");
    stars.waitFor = { target: before + n, n: n };
  }
  var CREDIT_WAIT = [1500, 3000, 5000, 8000];   // the bot adds the Stars when Telegram confirms the payment
  function waitCredit(target, n, step) {
    loadBalance().then(function (b) {
      if (b != null && b >= target) { credited(n); return; }
      if (step >= CREDIT_WAIT.length) { stMsg("Payment received. Your balance updates in a moment.", ""); $("st-refresh").classList.remove("hide"); stars.waitFor = { target: target, n: n }; return; }
      setTimeout(function () { waitCredit(target, n, step + 1); }, CREDIT_WAIT[step]);
    });
  }
  function credited(n) {
    stars.waitFor = null; $("st-refresh").classList.add("hide"); stars.hist = null;
    if (stars.fromPromote && !$("v-promote").classList.contains("hide")) {
      closeStars(); lowCheck();
      var enough = stars.bal >= pkgCost();
      if (enough) hideLow();
      msg("✅ " + fmtStars(n) + " Stars added. Balance: " + fmtStars(stars.bal) + " ⭐." + (enough ? " Tap Pay to promote your group." : ""), "okm");
      return;
    }
    stMsg("✅ " + fmtStars(n) + " Stars added. Balance: " + fmtStars(stars.bal) + " ⭐", "okm"); renderPacks();
  }
  function recheckCredit() {   // browser: back from Telegram, or "I paid · refresh balance"
    var w = stars.waitFor;
    loadBalance().then(function (b) { if (w && b != null && b >= w.target) credited(w.n); });
  }

  // ---------- My groups ----------
  function loadMine() {
    var box = $("mine");
    var req;
    if (inTg) req = api("/app/api/mine", { body: { initData: tg.initData } });
    else if (getSession()) req = api("/web/api/mine", { auth: true });
    else { box.textContent = ""; loginPanel(box); return; }
    box.textContent = ""; box.appendChild(el("div", "empty", "Loading…"));
    req.then(function (d) {
      box.textContent = "";
      if (d._status === 401 && !inTg) { setSession(null); renderAccount(); loginPanel(box); return; }
      if (!d.ok) { var x = el("div", "empty"); x.appendChild(el("b", null, "Couldn't load your groups")); x.appendChild(document.createTextNode("Please try again.")); box.appendChild(x); return; }
      mineLoaded = true;
      if (d.bot) data.bot = String(d.bot);
      var gs = (Array.isArray(d.groups) ? d.groups : []).filter(function (g) { return g && safeUrl(g.url); });
      if (!gs.length) {
        var e = el("div", "empty"); e.appendChild(el("b", null, "No promoted groups yet"));
        e.appendChild(document.createTextNode("Promote a group to list it in Group City."));
        var b = el("button", "big", "⭐ Promote a group"); b.type = "button"; b.onclick = function () { promote(); }; e.appendChild(b); box.appendChild(e); return;
      }
      var live = gs.filter(function (g) { return !g.expired; }), ended = gs.filter(function (g) { return g.expired; });
      var day = function (t) { var n = Number(t) || 0; return n ? new Date(n).toISOString().slice(0, 10) : "?"; };
      if (live.length) box.appendChild(el("div", "sec", "Active"));
      live.forEach(function (g) {
        var c = card({ title: String(g.title || ""), url: String(g.url) }, !!g.top);
        c.querySelector(".meta").textContent = (g.top ? "⭐ TOP" : "👥 Normal") + " · until " + day(g.until);
        box.appendChild(c);
      });
      if (ended.length) box.appendChild(el("div", "sec", "Expired"));
      ended.forEach(function (g) {
        var c = card({ title: String(g.title || ""), url: String(g.url) }, false);
        c.querySelector(".meta").textContent = "Expired " + day(g.until) + " · " + (g.top ? "TOP" : "Normal");
        var old = c.querySelector(".join"), b = el("button", "join", "Promote again"); b.type = "button";
        b.onclick = function () { promote({ title: String(g.title || ""), url: String(g.url) }); };
        c.replaceChild(b, old); c.style.opacity = "0.85";
        box.appendChild(c);
      });
      var rb = el("button", "big", "⭐ Promote a group"); rb.type = "button"; rb.onclick = function () { promote(); };
      box.appendChild(rb);
      box.appendChild(el("div", "note", "Each promotion lists one group for " + (Number(d.days) || data.days) + " days, paid from your Stars balance. When it ends, promote it again."));
    }).catch(function () { box.textContent = ""; var x = el("div", "empty"); x.appendChild(el("b", null, "Couldn't connect")); x.appendChild(document.createTextNode("Check your connection.")); box.appendChild(x); });
  }

  // ---------- time helpers ----------
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hhmm(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function listTime(iso) {
    var d = new Date(iso); if (isNaN(d)) return "";
    var now = new Date();
    if (sameDay(d, now)) return hhmm(d);
    if (now - d < 6 * 864e5) return d.toLocaleDateString("en-US", { weekday: "short" });
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  function dayLabel(d) {
    var now = new Date(), y = new Date(now.getTime() - 864e5);
    if (sameDay(d, now)) return "Today";
    if (sameDay(d, y)) return "Yesterday";
    var o = { day: "numeric", month: "long" }; if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
    return d.toLocaleDateString("en-GB", o);
  }

  // ---------- chat sign-in state ----------
  function chatReady() { return !!getChat(); }
  function chatExpired() {   // chat API answered 401
    setChat(null);
    if (inTg) return tgChatLogin().then(function (ok) { refreshTab(); return ok; });
    renderAccount(); refreshTab(); return Promise.resolve(false);
  }
  // shows a login prompt / status in `box` when chat isn't usable; returns true when it is
  function needChat(box, title, hint, id) {
    box.textContent = "";
    if (chatReady()) { box.classList.add("hide"); return true; }
    box.classList.remove("hide");
    if (inTg) {
      if (chatState === "pending" || chatState === "idle") { box.appendChild(el("div", "empty", "Connecting…")); return false; }
      var e = el("div", "empty"); e.appendChild(el("b", null, "Chat is not available")); e.appendChild(document.createTextNode(chatFailMsg || "Please try again."));
      var b = el("button", "big", "Try again"); b.type = "button"; b.onclick = function () { tgChatLogin().then(refreshTab); refreshTab(); };
      e.appendChild(b); box.appendChild(e); return false;
    }
    loginPanel(box, { id: id, title: title, hint: hint });
    return false;
  }

  // ---------- public chat settings: name / photo / description (admins edit them; everyone sees them) ----------
  // Cached on this device (gc_pubchat) so the Messages row and the chat header render at once; the summary's
  // settingsV says when the server copy changed, and only then is ?view=settings fetched.
  var PUBKEY = "gc_pubchat", PUB_NAME = "Group City Chat", NAME_MAX = 64, DESC_MAX = 255;
  var pubCur = null, pubBusy = false;
  function photoOk(u) { u = String(u || ""); return /^data:image\/jpeg;base64,[A-Za-z0-9+\/]+={0,2}$/.test(u) || safeUrl(u) ? u : ""; }
  function cleanPub(o) {
    o = o && typeof o === "object" ? o : {};
    return { name: String(o.name || "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX) || PUB_NAME, photo: photoOk(o.photo),
      description: String(o.description || "").slice(0, DESC_MAX), v: String(o.v || "") };
  }
  function pubInfo() {
    if (!pubCur) { var o = null; try { o = JSON.parse(localStorage.getItem(PUBKEY) || "null"); } catch (e) {} pubCur = cleanPub(o); }
    return pubCur;
  }
  function setPubInfo(o) {
    pubCur = cleanPub(o);
    var custom = pubCur.v || pubCur.photo || pubCur.description || pubCur.name !== PUB_NAME;
    try { if (custom) localStorage.setItem(PUBKEY, JSON.stringify(pubCur)); else localStorage.removeItem(PUBKEY); }
    catch (e) { try { localStorage.setItem(PUBKEY, JSON.stringify(Object.assign({}, pubCur, { photo: "", v: "" }))); } catch (e2) {} }
    applyPubInfo();
  }
  function isAdminNow() { var c = getChat(); return !!(c && c.isAdmin); }
  // round chat avatar: the custom photo, else the blue 💬
  function pubAvatar(cls, photo) {
    photo = photo === undefined ? pubInfo().photo : photo;
    var a = el("span", cls, photo ? "" : "💬"); a.style.background = "#3d8bd9";
    if (photo) {
      var img = document.createElement("img");
      img.alt = ""; img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:50%";
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); a.textContent = "💬"; };
      img.src = photo; a.appendChild(img);
    }
    return a;
  }
  var pubAvDefault = null;   // the Messages row's own icon, put back when the photo is removed
  function swapAv(id, next) { var cur = $(id); next.id = id; if (cur && cur !== next && cur.parentNode) cur.parentNode.replaceChild(next, cur); }
  // puts the current name / photo everywhere the public chat shows: Messages row, chat header, info page
  function applyPubInfo() {
    var p = pubInfo();
    if (!pubAvDefault) pubAvDefault = $("pub-av");
    $("pub-name").textContent = p.name;
    swapAv("pub-av", p.photo ? pubAvatar("av cav") : pubAvDefault);
    if (ch && ch.room === "public") { swapAv("ch-av", pubAvatar("av cav")); $("ch-title").textContent = p.name; }
    if (info && info.kind === "group") { infoAvatar(info); $("ci-name").textContent = p.name; renderInfoPub(); }
    if (typeof filterChats === "function" && current === "msg") filterChats();
  }
  function syncPubInfo(v) {
    v = String(v || "");
    if (v === pubInfo().v) return;
    if (!v) { setPubInfo(null); return; }        // no settings saved (or the table is not there yet): defaults
    fetchPubInfo();
  }
  function fetchPubInfo() {
    if (pubBusy || !chatReady()) return; pubBusy = true;
    chatApi("/api/chat?view=settings").then(function (d) {
      pubBusy = false;
      if (d && d.ok && d.settings) setPubInfo(d.settings);
    }).catch(function () { pubBusy = false; });
  }

  // ---------- Messages list ----------
  function preview(m, who) { return m ? (m.mine ? "You: " : (who ? who + ": " : "")) + String(m.text || "").replace(/\s+/g, " ") : ""; }
  function renderMsgTab() {
    var ok = needChat($("msg-login"), "Log in to chat", "Log in with your Telegram account to message support and chat with everyone.", "login-msgtab");
    $("chats").classList.toggle("hide", !ok);
    $("chats-msg").classList.add("hide");
    if (!ok) { $("msg-none").classList.add("hide"); renderDays(); return; }
    var admin = !!getChat().isAdmin;
    $("sup-prev").textContent = admin ? "Support inbox" : "Message the Group City team";
    muteIcons(); filterChats();
    loadSummary(false);
    loadStories(false);   // My Day strip (renders the cached list at once)
  }
  // Messages search: filter the chat rows by name / last message (live, as you type)
  var CHAT_ROWS = [{ row: "row-support", name: "Support", prev: "sup-prev" }, { row: "row-public", name: "Group City Chat", nameEl: "pub-name", prev: "pub-prev" }];
  function filterChats() {
    var q = sq.msg.trim().toLowerCase(), shown = 0;
    CHAT_ROWS.forEach(function (r) {
      var hit = !q || ((r.nameEl ? $(r.nameEl).textContent : r.name) + "\n" + $(r.prev).textContent).toLowerCase().indexOf(q) >= 0;
      $(r.row).classList.toggle("hide", !hit); if (hit) shown++;
    });
    $("msg-none").classList.toggle("hide", !(q && !shown && !$("chats").classList.contains("hide")));
  }
  // ---------- mute (per chat, this device only) ----------
  function muteKey(room, uid) { return "gc_mute:" + room + (uid ? ":" + uid : ""); }
  function isMuted(room, uid) { try { return localStorage.getItem(muteKey(room, uid)) === "1"; } catch (e) { return false; } }
  function setMuted(room, uid, on) { try { if (on) localStorage.setItem(muteKey(room, uid), "1"); else localStorage.removeItem(muteKey(room, uid)); } catch (e) {} }
  function muteIcons() {
    var admin = !!(getChat() && getChat().isAdmin);
    $("pub-muted").classList.toggle("hide", !isMuted("public"));
    $("sup-muted").classList.toggle("hide", admin || !isMuted("support"));
  }
  // light new-message signal (unmuted chats only): Telegram haptic inside Telegram, a short vibration elsewhere
  function haptic() {
    try { if (inTg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred) { tg.HapticFeedback.notificationOccurred("success"); return; } } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
  }
  // unread count for the public chat: last public message id seen on this device; counted with the normal ?after= read
  var SEENKEY = "gc_seen_public", lastSum = null, unread = { at: "", n: 0 };
  function getSeen() { try { return Number(localStorage.getItem(SEENKEY)) || 0; } catch (e) { return 0; } }
  function setSeen(id) { id = Number(id) || 0; if (id > getSeen()) { try { localStorage.setItem(SEENKEY, String(id)); } catch (e) {} } }
  // Telegram-style counts: the row always shows the count (green when unmuted, grey when muted) and the time turns
  // green for unmuted unread; the bottom-nav Messages badge counts unmuted unread only.
  function badgeText(n, capped) { return capped ? n + "+" : String(n); }
  function setCount(badge, time, n, muted, capped) {
    badge.className = "cbadge " + (muted ? "muted" : "unm") + (n ? "" : " hide");
    badge.textContent = n ? badgeText(n, capped) : "";
    if (time) time.classList.toggle("unread", !!n && !muted);
  }
  function showUnread(n, capped) {
    var muted = isMuted("public");
    setCount($("pub-badge"), $("pub-time"), n, muted, capped);
    var u = muted ? 0 : n;
    var nb = $("nav-msg-badge"); nb.classList.toggle("hide", !u); nb.textContent = u ? badgeText(u, capped) : "";
  }
  function countUnread(p) {
    if (!p || !p.id) { showUnread(0); return; }
    var seen = getSeen();
    if (!seen) { setSeen(p.id); showUnread(0); return; }          // first run on this device: history counts as read
    var ukey = p.id + ":" + seen;
    if (p.id <= seen) { unread = { at: ukey, n: 0 }; showUnread(0); return; }
    if (unread.at === ukey) { showUnread(unread.n, unread.capped); return; }
    chatApi("/api/chat?room=public&after=" + encodeURIComponent(seen)).then(function (d) {
      if (!d || !d.ok) return;
      var ms = Array.isArray(d.messages) ? d.messages : [];
      var n = ms.filter(function (m) { return m && !m.mine && m.id > getSeen(); }).length;
      var capped = ms.length >= 100 && n > 0;
      if (capped) n = 100;
      unread = { at: ukey, n: n, capped: capped };
      if (screens[screens.length - 1] === "v-chat" && ch && ch.room === "public") { n = 0; capped = false; }
      showUnread(n, capped);
    }).catch(function () {});
  }
  function loadSummary(quiet) {
    if (!chatReady()) return;
    var admin = !!getChat().isAdmin;
    chatApi("/api/chat?view=summary").then(function (d) {
      if (d._status === 401) { if (!quiet) chatExpired(); return; }
      if (!d.ok) { if (quiet) return; var m = $("chats-msg"); m.className = "msg err"; m.textContent = d.message || "Couldn't load messages."; return; }
      if (getChat() && getChat().isAdmin !== !!d.isAdmin) { var c = getChat(); c.isAdmin = !!d.isAdmin; setChat(c); admin = !!d.isAdmin; }
      var onList = current === "msg" && !screens.length;
      if (lastSum && onList) {
        var np = d.public && !d.public.mine && d.public.id > lastSum.pub && !isMuted("public");
        var ns = !admin && d.support && !d.support.mine && d.support.id > lastSum.sup && !isMuted("support");
        if (np || ns) haptic();
      }
      lastSum = { pub: d.public ? Number(d.public.id) || 0 : 0, sup: d.support ? Number(d.support.id) || 0 : 0 };
      var p = d.public, s = d.support;
      $("pub-prev").textContent = p ? preview(p, p.name) : "Chat with everyone";
      $("pub-time").textContent = p ? listTime(p.at) : "";
      countUnread(d.public); muteIcons();
      $("sup-prev").textContent = s ? preview(s, admin ? s.name : (s.mine ? "" : "Support")) : (admin ? "No support messages yet" : "Message the Group City team");
      $("sup-time").textContent = s ? listTime(s.at) : "";
      var badge = $("sup-badge"), n = Number(d.waiting) || 0;
      setCount(badge, $("sup-time"), admin ? n : 0, false, false);
      if (d.settingsV !== undefined) syncPubInfo(d.settingsV);
      filterChats();
      warmFromSummary(d, admin);
    }).catch(function () { if (quiet) return; var m = $("chats-msg"); m.className = "msg err"; m.textContent = "Couldn't connect. Check your connection."; });
  }
  // picks the one chat whose cache is behind the summary (public first, then the user's own support thread)
  function warmFromSummary(d, admin) {
    if (screens.indexOf("v-chat") >= 0) return;
    var need = function (room, last) {
      if (!last || !last.id) return false;
      var c = readCache(room, ""); return !c || !c.length || c[c.length - 1].id < Number(last.id);
    };
    if (need("public", d.public)) warmChat("public", "");
    else if (!admin && need("support", d.support)) warmChat("support", "");
  }
  // keeps the Messages list and the unread badge fresh (not while a chat is open: the chat polls itself)
  setInterval(function () {
    if (document.hidden || !chatReady() || screens[screens.length - 1] === "v-chat") return;
    loadSummary(true);
    if (current === "msg" && !screens.length) loadStories(false);   // My Day list: at most once a minute (no photos)
  }, 20000);

  // ---------- screens (support inbox, chat) ----------
  var screens = [];   // open screen ids, top last
  function syncBack() {
    document.body.classList.toggle("lock", screens.length > 0 || !$("v-promote").classList.contains("hide") || !$("v-stars").classList.contains("hide"));
    if (!inTg || !tg.BackButton) return;
    try { if (screens.length) tg.BackButton.show(); else tg.BackButton.hide(); } catch (e) {}
  }
  function openScreen(id) { $(id).classList.remove("hide"); if (screens.indexOf(id) < 0) screens.push(id); syncBack(); }
  function closeScreen(id) {
    $(id).classList.add("hide"); screens = screens.filter(function (x) { return x !== id; });
    if (id === "v-chat") { stopPoll(); closePop(); closeSearch(true); }
    if (id === "v-threads") stopThreadPoll();
    if (id === "v-info") info = null;
    if (id === "v-edit") { edShowEmo(false); ed = null; }
    if (id === "v-pedit") pe = null;
    if (id === "v-spost") sp = null;
    if (id === "v-sview") { svStop(); sv = null; }
    syncBack();
  }
  function goBack() {
    var top = screens[screens.length - 1]; if (!top) return;
    if (top === "v-chat" && popOpen()) { closePop(); return; }
    if (top === "v-chat" && srch.on) { closeSearch(); return; }
    if (top === "v-edit" && !$("ed-emop").classList.contains("hide")) { edShowEmo(false); return; }
    closeScreen(top);
    if (top === "v-info" && screens[screens.length - 1] === "v-chat") { muteUi(); fetchMsgs(false); return; }
    if (top === "v-chat" && screens.indexOf("v-threads") >= 0) { loadThreads(); startThreadPoll(); }
    if (!screens.length && current === "msg") renderMsgTab();
  }
  function closeAllScreens() { screens.slice().forEach(closeScreen); }
  if (inTg && tg.BackButton && tg.onEvent) { try { tg.onEvent("backButtonClicked", goBack); } catch (e) {} }

  // ---------- admin support inbox ----------
  var thTimer = null, thBusy = false;
  function openThreads() { $("th-list").textContent = ""; $("th-list").appendChild(el("div", "cempty", "Loading…")); openScreen("v-threads"); loadThreads(); startThreadPoll(); }
  function startThreadPoll() { stopThreadPoll(); thTimer = setInterval(function () { if (!document.hidden && screens[screens.length - 1] === "v-threads") loadThreads(); }, 10000); }
  function stopThreadPoll() { if (thTimer) clearInterval(thTimer); thTimer = null; }
  function loadThreads() {
    if (thBusy) return; thBusy = true;
    chatApi("/api/chat?view=threads").then(function (d) {
      thBusy = false;
      var box = $("th-list");
      if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
      if (!d.ok) { box.textContent = ""; box.appendChild(el("div", "cempty", d.message || "Couldn't load support threads.")); return; }
      var th = Array.isArray(d.threads) ? d.threads : [];
      $("th-sub").textContent = th.length ? th.filter(function (t) { return t.waiting; }).length + " waiting · " + th.length + " threads" : "All user threads";
      box.textContent = "";
      if (!th.length) { var e = el("div", "cempty"); e.appendChild(el("b", null, "No support messages yet")); e.appendChild(document.createTextNode("When a user writes to support, the thread shows here.")); box.appendChild(e); return; }
      th.forEach(function (t) {
        var row = el("button", "crow"); row.type = "button";
        row.appendChild(uAvatar({ u: t.u, pv: t.pv, photo: t.photo, name: t.name }, "av cav"));
        var info = el("span", "cinfo"), top = el("span", "ctop"), bot = el("span", "cbot");
        var nm = el("span", "cname", t.name + (t.username ? "  @" + t.username : ""));
        var nmw = el("span", "cnm"); nmw.appendChild(nm);
        if (isMuted("support", String(t.uid))) { var mi = el("span", "mutei"); mi.setAttribute("aria-label", "Muted"); nmw.appendChild(mi); }
        top.appendChild(nmw); top.appendChild(el("span", "ctime", t.last ? listTime(t.last.at) : ""));
        bot.appendChild(el("span", "cprev", t.last ? preview(t.last, t.last.admin ? "Support" : "") : ""));
        var tm = isMuted("support", String(t.uid));
        if (t.waiting) { bot.appendChild(el("span", "cbadge dot " + (tm ? "muted" : "unm"))); if (!tm) top.lastChild.classList.add("unread"); }
        info.appendChild(top); info.appendChild(bot); row.appendChild(info);
        row.onclick = function () { openChat({ room: "support", uid: String(t.uid), title: t.name, username: t.username || "", sub: (t.username ? "@" + t.username + " · " : "") + "ID " + t.uid, photo: t.photo, seed: t.u, pv: t.pv }); };
        box.appendChild(row);
      });
    }).catch(function () { thBusy = false; });
  }

  // ---------- chat view ----------
  var ch = null;              // {room, uid, msgs:[], admin}
  var pollTimer = null, pollBusy = false, sending = false, errTimer = null;
  var MAX_SHOWN = 200;
  function chatQuery(after) { return roomQuery(ch.room, ch.uid, after); }
  // chat subtitle: the network tracker's state when not ok (same words as the header), else the chat's own line.
  // Opening a cached chat whose first read is slow also shows "Updating..." here only.
  function renderSub() {
    if (!ch) return;
    var e = $("ch-sub"), s = net.state !== "ok" ? net.state : (ch.slow && !ch.loaded ? "updating" : "ok");
    if (s === "ok") { e.textContent = ch.sub; e.classList.remove("cnet"); return; }
    e.textContent = netLabel(s); e.appendChild(netDots()); e.classList.add("cnet");
  }
  function subNormal() { renderSub(); }
  function openChat(o) {
    if (!chatReady()) { tab("msg"); return; }
    stopPoll(); closePop(); closeSearch(true);
    ch = { room: o.room, uid: o.uid || "", msgs: [], pend: [], admin: !!getChat().isAdmin, loaded: false, cached: false, slow: false, sub: "",
      info: { title: o.title || "", username: o.username || "", photo: o.photo || "", seed: o.seed || "", pv: o.pv || "" } };
    var hav = $("ch-av"), nav;
    if (o.room === "public") { nav = pubAvatar("av cav"); $("ch-title").textContent = pubInfo().name; $("ch-sub").textContent = "Everyone on Group City"; }
    else if (o.uid) { nav = uAvatar({ u: o.seed, pv: o.pv, photo: o.photo, name: o.title }, "av cav"); $("ch-title").textContent = o.title || "User"; $("ch-sub").textContent = o.sub || "Support thread"; }
    else { nav = el("span", "av cav", "🆘"); nav.style.background = "#e5534b"; $("ch-title").textContent = "Support"; $("ch-sub").textContent = "Ask the Group City team anything"; }
    nav.id = "ch-av"; hav.parentNode.replaceChild(nav, hav);
    ch.sub = $("ch-sub").textContent; renderSub();
    muteUi();
    $("ch-text").value = ""; autoGrow(); chatErr(""); if ($("ch-emop")) { $("ch-emop").classList.add("hide"); $("ch-emo").classList.remove("on"); }
    $("ch-text").placeholder = o.room === "support" && o.uid ? "Reply as Support" : "Message";
    // Telegram-style: cached messages show at once; the network read only appends what's new
    var cached = readCache(o.room, ch.uid);
    var list = $("ch-list"); list.textContent = "";
    if (cached && cached.length) { ch.msgs = cached.slice(-MAX_SHOWN); ch.cached = true; renderMsgs(); }
    else list.appendChild(smallLoader());
    openScreen("v-chat");
    if (ch.cached) toBottom();
    fetchMsgs(true);
    startPoll();
  }
  function smallLoader() { var d = el("div", "cload"); d.setAttribute("role", "status"); d.appendChild(el("span", "spin")); d.appendChild(el("span", null, "Loading…")); return d; }
  function lastId() { return ch && ch.msgs.length ? ch.msgs[ch.msgs.length - 1].id : 0; }
  function nearBottom() { var l = $("ch-list"); return l.scrollHeight - l.scrollTop - l.clientHeight < 90; }
  function toBottom() { var l = $("ch-list"); l.scrollTop = l.scrollHeight; }
  function fetchMsgs(first, full) {
    if (!ch || pollBusy) return;
    var my = ch; pollBusy = true;
    var after = full ? 0 : lastId();      // first open with a cache: only what's newer than the cache
    var hadMsgs = ch.msgs.length > 0;
    if (first && ch.cached) setTimeout(function () { if (ch === my && pollBusy && !ch.loaded) { ch.slow = true; renderSub(); } }, NET_DEBOUNCE);
    chatApi(chatQuery(after)).then(function (d) {
      pollBusy = false;
      if (ch !== my) return;
      if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
      if (!d.ok) {
        if (!hadMsgs && !ch.loaded) { var l = $("ch-list"); l.textContent = ""; l.appendChild(el("div", "cempty", d.message || "Couldn't load messages.")); }
        return;
      }
      // cache is a full page or more behind: replace it with the latest page instead of filling from the middle
      if (after && first && Array.isArray(d.messages) && d.messages.length >= CACHE_MAX) { pollBusy = false; fetchMsgs(true, true); return; }
      var r = mergeMsgs(full ? [] : ch.msgs, d), changed = r.changed || (full && hadMsgs);
      ch.msgs = r.msgs;
      if (!first && ch.loaded && r.incoming && !isMuted(ch.room, ch.uid)) haptic();
      if (ch.msgs.length > MAX_SHOWN) ch.msgs = ch.msgs.slice(-MAX_SHOWN);
      if (ch.room === "public") { setSeen(lastId()); showUnread(0); }
      if (first || changed || !ch.loaded) writeCache(ch.room, ch.uid, ch.msgs);
      var wasLoaded = ch.loaded; ch.loaded = true; subNormal();
      if (changed || !wasLoaded && !hadMsgs || (first && !hadMsgs)) {
        var stick = (!hadMsgs || full || nearBottom()) && !srch.on, l2 = $("ch-list"), st = l2.scrollTop;
        renderMsgs();
        if (srch.on) l2.scrollTop = st;      // a poll while searching keeps the place and the current match
        if (stick) toBottom();
      }
    }).catch(function () {
      pollBusy = false;
      if (ch !== my) return;
      if (!hadMsgs && !ch.loaded) { var l = $("ch-list"); l.textContent = ""; l.appendChild(el("div", "cempty", "Couldn't connect. Check your connection.")); }
      // with a cache the bubbles stay; the network tracker shows "Connecting..." in the subtitle
    });
  }
  function startPoll() { stopPoll(); pollTimer = setInterval(function () { if (!document.hidden && screens[screens.length - 1] === "v-chat") fetchMsgs(false); }, 5000); }
  function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    if (screens[screens.length - 1] === "v-chat") fetchMsgs(false);
    else if (screens[screens.length - 1] === "v-threads") loadThreads();
  });

  function renderMsgs() {
    var list = $("ch-list"); list.textContent = "";
    var ms = ch.msgs.concat(ch.pend || []);
    srch.marks = [];
    try { renderList(list, ms); } finally { searchSync(false); }
  }
  function renderList(list, ms) {
    if (!ms.length) {
      var e = el("div", "cempty");
      if (ch.room === "public") { e.appendChild(el("b", null, "No messages yet")); e.appendChild(document.createTextNode("Say hello to everyone on Group City. Be kind, no spam.")); }
      else if (ch.uid) { e.appendChild(el("b", null, "No messages")); e.appendChild(document.createTextNode("This thread is empty.")); }
      else { e.appendChild(el("b", null, "How can we help?")); e.appendChild(document.createTextNode("Write your question. The Group City team will reply here.")); }
      list.appendChild(e); return;
    }
    var prevDay = null;
    ms.forEach(function (m, i) {
      var d = new Date(m.at), p = ms[i - 1], n = ms[i + 1];
      if (!isNaN(d) && (!prevDay || !sameDay(prevDay, d))) { var dl = el("div", "day"); dl.appendChild(el("span", null, dayLabel(d))); list.appendChild(dl); prevDay = d; }
      var key = function (x) { return x ? (x.mine ? "me" : x.u + (x.admin ? "a" : "")) : ""; };
      var firstOfRun = !p || key(p) !== key(m) || (p && !sameDay(new Date(p.at), d));
      var lastOfRun = !n || key(n) !== key(m) || (n && !sameDay(new Date(n.at), d));
      var row = el("div", "mrow" + (m.mine ? " me" : "") + (m.pend ? " pending" : "") + (m.fail ? " failed" : ""));
      if (!m.mine) {
        var av;
        if (m.admin && m.name === "Support") { av = el("span", "mav", "🆘"); av.style.background = "#e5534b"; }
        else {
          av = uAvatar(m, "mav");
          if (av.classList.contains("ring")) (function (u) { av.onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); var g = storyGroup(u); if (g) openViewer([g], 0); }; })(m.u);
        }
        if (!lastOfRun) { av.classList.add("sp"); av.classList.remove("ring", "seen"); av.onclick = null; }
        row.appendChild(av);
      }
      var b = el("div", "bub");
      if (!m.mine && firstOfRun) {
        var nm = el("div", "bname"); var nt = el("span", null, m.name || "User"); nt.style.color = m.admin && m.name === "Support" ? "#ff8a80" : color(m.u);
        nm.appendChild(nt);
        if (m.admin && ch.room === "public") nm.appendChild(el("span", "adm", "admin"));
        b.appendChild(nm);
      }
      var t = el("div", "btext");
      var bt = el("span", "btime", isNaN(d) ? "" : hhmm(d));
      if (m.pend) { var ck = el("span", m.fail ? "bst bfail" : "bst bclock"); ck.setAttribute("aria-label", m.fail ? "Not sent" : "Sending"); bt.appendChild(ck); }
      t.appendChild(bt);
      srch.mid = m.id; srch.occ = 0;
      t.appendChild(linkify(String(m.text || "")));
      b.appendChild(t);
      b.onclick = function () { msgMenu(m); };
      row.appendChild(b);
      list.appendChild(row);
    });
  }
  function chatErr(text) {
    var e = $("ch-err"); e.textContent = text; e.classList.toggle("hide", !text);
    if (errTimer) clearTimeout(errTimer);
    if (text) errTimer = setTimeout(function () { e.classList.add("hide"); }, 5000);
  }
  function autoGrow() { var t = $("ch-text"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }
  var pendSeq = 0;
  function sendMsg() {
    if (!ch || sending) return;
    var text = $("ch-text").value.replace(/\r\n?/g, "\n").trim();
    if (!text) return;
    if (text.length > 1000) { chatErr("Message is too long (max 1000 characters)."); return; }
    var my = ch; sending = true; $("ch-send").disabled = true;
    var body = { action: "send", room: ch.room, text: text }; if (ch.uid) body.uid = ch.uid;
    // optimistic bubble with a clock until the server confirms it
    var u = anyUser() || {}, pm = { id: "p" + (++pendSeq), pend: true, text: text, at: new Date().toISOString(), u: "me", mine: true, name: myName() || u.first_name || "" };
    ch.pend.push(pm);
    $("ch-text").value = ""; autoGrow(); chatErr("");
    renderMsgs(); toBottom();
    var drop = function () { my.pend = my.pend.filter(function (x) { return x !== pm; }); };
    var failed = function (msg) {
      drop();
      if (ch === my) { renderMsgs(); if (!$("ch-text").value) { $("ch-text").value = text; autoGrow(); } }   // text back in the box to retry
      chatErr(msg);
    };
    chatApi("/api/chat", { body: body }).then(function (d) {
      sending = false; $("ch-send").disabled = false;
      if (d._status === 401) { drop(); closeAllScreens(); chatExpired(); return; }
      if (!d.ok || !d.message) { failed(d.message || "Message was not sent."); return; }
      drop();
      if (!my.msgs.some(function (m) { return m.id === d.message.id; })) my.msgs.push(d.message);
      my.msgs.sort(function (a, b) { return a.id - b.id; });
      writeCache(my.room, my.uid, my.msgs);
      if (ch !== my) return;
      renderMsgs(); toBottom();
      fetchMsgs(false);
    }).catch(function () { sending = false; $("ch-send").disabled = false; failed("Couldn't connect. Message was not sent."); });
  }

  // tap a message: copy / delete
  var menuMsg = null;
  function msgMenu(m) {
    if (window.getSelection && String(window.getSelection()).length) return; // user is selecting text
    menuMsg = m;
    $("mm-prev").textContent = String(m.text || "").slice(0, 300);
    $("mm-del").classList.toggle("hide", !!m.pend || !(m.mine || (getChat() && getChat().isAdmin)));
    $("mmenu").classList.remove("hide");
  }
  function closeMenu() { $("mmenu").classList.add("hide"); menuMsg = null; }
  $("mm-cancel").onclick = closeMenu;
  $("mmenu").addEventListener("click", function (e) { if (e.target === $("mmenu")) closeMenu(); });
  $("mm-copy").onclick = function () {
    var t = menuMsg ? String(menuMsg.text || "") : ""; closeMenu();
    try { navigator.clipboard.writeText(t).then(function () { chatErr(""); }, function () {}); } catch (e) {}
  };
  $("mm-del").onclick = function () {
    var m = menuMsg; closeMenu(); if (!m || !ch || m.pend) return;
    var my = ch;
    chatApi("/api/chat", { body: { action: "delete", id: m.id } }).then(function (d) {
      if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
      if (!d.ok) { chatErr(d.message || "Couldn't delete the message."); return; }
      if (ch !== my) return;
      ch.msgs = ch.msgs.filter(function (x) { return x.id !== m.id; }); writeCache(ch.room, ch.uid, ch.msgs); renderMsgs();
    }).catch(function () { chatErr("Couldn't connect."); });
  };
  $("ch-back").onclick = goBack;
  $("th-back").onclick = goBack;

  // ---------- chat ⋮ menu: Mute / Search (Telegram-style popup) ----------
  function popOpen() { return !$("ch-pop").classList.contains("hide"); }
  function openPop() {
    if (!ch) return;
    muteUi();
    $("ch-pop").classList.remove("hide"); $("ch-popbg").classList.remove("hide");
    $("ch-more").classList.add("on"); $("ch-more").setAttribute("aria-expanded", "true");
  }
  function closePop() {
    $("ch-pop").classList.add("hide"); $("ch-popbg").classList.add("hide");
    $("ch-more").classList.remove("on"); $("ch-more").setAttribute("aria-expanded", "false");
  }
  function muteUi() {
    var m = !!ch && isMuted(ch.room, ch.uid);
    $("ch-muted").classList.toggle("hide", !m);
    $("ch-mute").classList.toggle("muted", m);
    $("ch-mute-l").textContent = m ? "Unmute" : "Mute";
  }
  $("ch-more").onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); if (popOpen()) closePop(); else openPop(); };
  $("ch-popbg").onclick = closePop;
  $("ch-popbg").addEventListener("touchmove", function (e) { closePop(); if (e && e.preventDefault) e.preventDefault(); });
  // one mute switch for the open chat: chat header icon, ⋮ menus, info page and the Messages list all follow it
  function toggleMute() {
    if (!ch) return;
    setMuted(ch.room, ch.uid, !isMuted(ch.room, ch.uid));
    muteUi(); infoMuteUi(); muteIcons();
    if (ch.room === "public") showUnread(0);
  }
  $("ch-mute").onclick = function () { if (ch) toggleMute(); closePop(); };
  $("ch-find").onclick = function () { closePop(); openSearch(); };

  // ---------- chat info (tap the chat header pill): Telegram-style group / support / user info ----------
  // group  = Group City Chat: members (online / last seen, Admin pill) + Links tab
  // support = a user's own support chat; user = an admin's view of one user's support thread
  var info = null;                 // {kind, tab, my chat}
  var MEMBERS_TTL = 60000, memCache = null, linkCache = null, infoBusy = { m: false, l: false, u: false };
  function infoMuteUi() {
    var m = !!ch && isMuted(ch.room, ch.uid);
    $("ci-mute").classList.toggle("muted", m); $("ci-mute-l").textContent = m ? "Unmute" : "Mute";
    $("ci-mute").setAttribute("aria-pressed", m ? "true" : "false");
  }
  function n0(n) { n = Number(n) || 0; try { return n.toLocaleString("en-US"); } catch (e) { return String(n); } }
  function countLine(d) {
    var t = Number(d.total) || 0, s = n0(t) + (t === 1 ? " member" : " members");
    if (d.online != null && Number(d.online) > 0) s += ", " + n0(d.online) + " online";
    return s;
  }
  // "online" / "last seen at 14:05" / "last seen yesterday at 9:30" / "last seen 3 Nov" / "last seen recently"
  function seenText(m) {
    if (!m) return "last seen recently";
    if (m.mine || m.online) return "online";
    var d = m.seen ? new Date(m.seen) : null;
    if (!d || isNaN(d)) return "last seen recently";
    var now = new Date(), y = new Date(now.getTime() - 864e5);
    if (sameDay(d, now)) return "last seen at " + hhmm(d);
    if (sameDay(d, y)) return "last seen yesterday at " + hhmm(d);
    var o = { day: "numeric", month: "short" }; if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
    return "last seen " + d.toLocaleDateString("en-GB", o);
  }
  function infoAvatar(o) {
    var a;
    if (o.kind === "group") a = pubAvatar("av iav");
    else if (o.kind === "support") { a = el("span", "av iav", "🆘"); a.style.background = "#e5534b"; }
    else a = uAvatar({ u: ch.info.seed, pv: ch.info.pv, photo: ch.info.photo, name: ch.info.title }, "av iav");
    a.id = "ci-av";
    var old = $("ci-av"); old.parentNode.replaceChild(a, old);
  }
  function openInfo() {
    if (!ch || srch.on || screens[screens.length - 1] !== "v-chat") return;
    closePop(); emoShow(false);
    var kind = ch.room === "public" ? "group" : (ch.uid ? "user" : "support");
    info = { kind: kind, tab: "m", ch: ch };
    infoAvatar(info);
    $("ci-name").textContent = kind === "group" ? pubInfo().name : kind === "support" ? "Group City Support" : (ch.info.title || "User");
    $("ci-sub").textContent = kind === "group" ? (memFresh(true) ? countLine(memCache.d) : "Everyone on Group City") : kind === "support" ? "Support" : "last seen recently";
    $("ci-sub").classList.remove("on");
    $("ci-tabs").classList.toggle("hide", kind !== "group");
    $("ci-members").classList.toggle("hide", kind !== "group");
    $("ci-links").classList.add("hide");
    $("ci-about").classList.toggle("hide", kind !== "user");
    renderInfoPub();
    infoTab("m", true);
    infoMuteUi();
    $("ci-body").scrollTop = 0;
    openScreen("v-info");
    if (kind === "group") loadMembers(false);
    if (kind === "user") { renderAbout(null); loadUserInfo(); }
  }
  function memFresh(any) { var o = cacheOwner(); return !!(memCache && memCache.o === o && (any || Date.now() - memCache.t < MEMBERS_TTL)); }
  function loadMembers(force) {
    var box = $("ci-members");
    if (memFresh(true)) renderMembers(memCache.d);
    else { box.textContent = ""; box.appendChild(smallLoader()); }
    if (!force && memFresh(false)) return;            // cached for 60 s
    if (infoBusy.m) return; infoBusy.m = true;
    var my = info, owner = cacheOwner();
    chatApi("/api/chat?view=members").then(function (d) {
      infoBusy.m = false;
      if (d._status === 401) { if (info === my) { closeAllScreens(); chatExpired(); } return; }
      if (!d.ok) { if (info === my && !memFresh(true)) { box.textContent = ""; box.appendChild(el("div", "iempty", d.message || "Couldn't load members.")); } return; }
      memCache = { o: owner, t: Date.now(), d: d };
      if (info === my && info.kind === "group") { renderMembers(d); $("ci-sub").textContent = countLine(d); }
    }).catch(function () {
      infoBusy.m = false;
      if (info === my && !memFresh(true)) { box.textContent = ""; box.appendChild(el("div", "iempty", "Couldn't connect. Check your connection.")); }
    });
  }
  function memberSort(a, b) {
    if (!!a.admin !== !!b.admin) return a.admin ? -1 : 1;
    var oa = !!(a.online || a.mine), ob = !!(b.online || b.mine);
    if (oa !== ob) return oa ? -1 : 1;
    return (b.seen ? Date.parse(b.seen) : 0) - (a.seen ? Date.parse(a.seen) : 0);
  }
  function renderMembers(d) {
    var box = $("ci-members"); box.textContent = "";
    var ms = (Array.isArray(d.members) ? d.members : []).filter(function (m) { return m && typeof m === "object"; }).slice().sort(memberSort);
    if (!ms.length) { box.appendChild(el("div", "iempty", "No members yet")); return; }
    ms.forEach(function (m) {
      var row = el("div", "irow");
      row.appendChild(uAvatar(m, "av imav"));
      var tx = el("div", "itx"), top = el("div", "itop");
      top.appendChild(el("span", "inm", m.name || "User"));
      if (m.admin) top.appendChild(el("span", "iadm", "Admin"));
      tx.appendChild(top);
      var st = seenText(m);
      tx.appendChild(el("div", "ist" + (st === "online" ? " on" : ""), st));
      row.appendChild(tx);
      box.appendChild(row);
    });
    if (d.more) box.appendChild(el("div", "ifoot", "Showing the " + ms.length + " most recently active members"));
  }
  // links posted in the public chat: this device's messages (open chat + cache) plus the server's last 50 link messages
  var LINK_RE = /(https?:\/\/[^\s<>"]+|(?:^|[^\w.\/@])(?:t\.me|telegram\.me)\/[^\s<>"]+)/g;
  function msgLinks(text) {
    var out = [], mt; text = String(text || ""); LINK_RE.lastIndex = 0;
    while ((mt = LINK_RE.exec(text))) {
      var raw = mt[0];
      if (raw[0] !== "h" && raw[0] !== "t") raw = raw.slice(1);
      var shown = raw.replace(/[.,!?:;)\]}'"]+$/, "");
      var url = /^https?:\/\//i.test(shown) ? shown.replace(/^http:\/\//i, "https://") : "https://" + shown;
      if (safeUrl(url) && out.every(function (x) { return x.url !== url; })) out.push({ url: url, shown: shown });
    }
    return out;
  }
  function linkItems() {
    var byId = {};
    var add = function (m) { if (m && Number(m.id) > 0 && !m.pend && !byId[m.id]) byId[m.id] = m; };
    if (linkCache && linkCache.o === cacheOwner()) (linkCache.ms || []).forEach(add);
    (readCache("public") || []).forEach(add);
    if (info && info.ch && info.ch.room === "public") info.ch.msgs.forEach(add);
    var items = [];
    Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) { return b.id - a.id; }).forEach(function (m) {
      msgLinks(m.text).forEach(function (l) { items.push({ url: l.url, shown: l.shown, name: m.mine ? "You" : (m.name || "User"), at: m.at, id: m.id }); });
    });
    return items;
  }
  function linkDate(d) {      // "14:05" today, else "3 Nov" (+ year when not this year)
    var now = new Date(); if (sameDay(d, now)) return hhmm(d);
    var o = { day: "numeric", month: "short" }; if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
    return d.toLocaleDateString("en-GB", o);
  }
  function linkHost(u) { var m = /^https:\/\/([^\/?#]+)/i.exec(u); return m ? m[1].replace(/^www\./i, "").toLowerCase() : ""; }
  function renderLinks() {
    var box = $("ci-links"); box.textContent = "";
    var items = linkItems();
    if (!items.length) {
      if (infoBusy.l) box.appendChild(smallLoader());
      else { var e = el("div", "iempty"); e.appendChild(el("b", null, "No links yet")); e.appendChild(document.createTextNode("Links posted in Group City Chat show here.")); box.appendChild(e); }
      return;
    }
    items.forEach(function (it) {
      var row = el("button", "irow ilink"); row.type = "button";
      var host = linkHost(it.url), tile = el("span", "av imav itile", letter(host === "t.me" || host === "telegram.me" ? it.url.replace(/^https:\/\/[^\/]+\/\+?/, "") : host));
      tile.style.background = color(host || it.url);
      row.appendChild(tile);
      var tx = el("span", "itx");
      tx.appendChild(el("span", "ilk", it.shown));
      var d = new Date(it.at);
      tx.appendChild(el("span", "ist", it.name + (isNaN(d) ? "" : " · " + linkDate(d))));
      row.appendChild(tx);
      (function (u) { row.onclick = function () { open(u); }; })(it.url);
      box.appendChild(row);
    });
  }
  function loadLinks() {
    renderLinks();
    if (linkCache && linkCache.o === cacheOwner() && Date.now() - linkCache.t < MEMBERS_TTL) return;
    if (infoBusy.l) return; infoBusy.l = true;
    var my = info, owner = cacheOwner();
    chatApi("/api/chat?view=links").then(function (d) {
      infoBusy.l = false;
      if (d._status === 401) { if (info === my) { closeAllScreens(); chatExpired(); } return; }
      if (d.ok) linkCache = { o: owner, t: Date.now(), ms: Array.isArray(d.messages) ? d.messages : [] };
      if (info === my && info.tab === "l") renderLinks();
    }).catch(function () { infoBusy.l = false; if (info === my && info.tab === "l") renderLinks(); });
  }
  function infoTab(t, quiet) {
    if (info) info.tab = t;
    $("ci-tab-m").classList.toggle("on", t === "m"); $("ci-tab-m").setAttribute("aria-selected", t === "m" ? "true" : "false");
    $("ci-tab-l").classList.toggle("on", t === "l"); $("ci-tab-l").setAttribute("aria-selected", t === "l" ? "true" : "false");
    if (!info || info.kind !== "group") return;
    $("ci-members").classList.toggle("hide", t !== "m");
    $("ci-links").classList.toggle("hide", t !== "l");
    if (quiet) return;
    if (t === "l") loadLinks(); else loadMembers(false);
  }
  // admin: one user's info for their support thread
  function aboutRow(box, value, label) { var r = el("div", "iarow"); r.appendChild(el("div", "iav1", value)); r.appendChild(el("div", "ial", label)); box.appendChild(r); }
  function renderAbout(m) {
    var box = $("ci-about"); box.textContent = "";
    if (info && m) info.member = m;
    var pv = (m && m.pv) || (ch && ch.info.pv) || "", pc = pv && ch ? profGet(ch.info.seed) : null;
    if (pv && ch && (!pc || pc.v !== String(pv))) profNeed(ch.info.seed, String(pv));
    if (pc && pc.v === String(pv) && pc.b) { var br = el("div", "iarow"), bt = el("div", "iav1 idtx"); bt.appendChild(linkify(pc.b)); br.appendChild(bt); br.appendChild(el("div", "ial", "Bio")); box.appendChild(br); }
    if (m && m.name && ch && info && info.kind === "user") $("ci-name").textContent = m.name;
    var uname = (m && m.username) || (ch && ch.info.username) || "";
    if (uname) aboutRow(box, "@" + uname, "Username");
    aboutRow(box, (m && m.uid) || (ch && ch.uid) || "", "User ID");
    if (m) { var st = seenText(m); $("ci-sub").textContent = st; $("ci-sub").classList.toggle("on", st === "online"); }
  }
  function loadUserInfo() {
    if (infoBusy.u || !ch || !ch.uid) return; infoBusy.u = true;
    var my = info;
    chatApi("/api/chat?view=member&uid=" + encodeURIComponent(ch.uid)).then(function (d) {
      infoBusy.u = false;
      if (d._status === 401) { if (info === my) { closeAllScreens(); chatExpired(); } return; }
      if (info === my && d.ok && d.member) renderAbout(d.member);
    }).catch(function () { infoBusy.u = false; });
  }
  $("ch-pill").onclick = function () { openInfo(); };
  $("ch-pill").addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openInfo(); } });
  $("ci-back").onclick = goBack;
  $("ci-msg").onclick = goBack;                                   // Message = back to the chat
  $("ci-mute").onclick = function () { toggleMute(); };
  function infoSearch() { if (screens[screens.length - 1] === "v-info") goBack(); if (screens[screens.length - 1] === "v-chat") openSearch(); }
  $("ci-find").onclick = infoSearch;
  $("ci-edit").onclick = function () { openEdit(); };
  $("ci-tab-m").onclick = function () { infoTab("m"); };
  $("ci-tab-l").onclick = function () { infoTab("l"); };

  // ---------- Edit the public chat (admins): name, photo, description — Telegram-style Edit screen ----------
  // The photo is cut to a centre square and made a 320x320 JPEG on this device before it is sent.
  var ed = null;                     // {photo: undefined (unchanged) | "" | data url, busy, sel}
  var PHOTO_PX = 320, PHOTO_SOFT = 80000, PHOTO_HARD = 160000;   // data-url length: ~60 KB target, < 120 KB hard
  function renderInfoPub() {
    var grp = !!info && info.kind === "group", p = pubInfo(), box = $("ci-desc");
    $("ci-edit").classList.toggle("hide", !(grp && isAdminNow()));
    box.textContent = "";
    var show = grp && !!p.description.trim();
    box.classList.toggle("hide", !show);
    if (!show) return;
    var r = el("div", "iarow"), t = el("div", "iav1 idtx");
    t.appendChild(linkify(p.description.trim()));
    r.appendChild(t); r.appendChild(el("div", "ial", "Description")); box.appendChild(r);
  }
  function edPhoto() { return ed && ed.photo !== undefined ? ed.photo : pubInfo().photo; }
  function edAvatar() { swapAv("ed-av", pubAvatar("av eav", edPhoto())); }
  function edMsg(text) { var m = $("ed-msg"); m.textContent = text || ""; m.classList.toggle("hide", !text); }
  function edGrow() { var t = $("ed-desc"); t.style.height = "auto"; t.style.height = Math.min(Math.max(t.scrollHeight, 24), 160) + "px"; }
  function edBusy(on) { if (ed) ed.busy = on; $("ed-save").disabled = on; $("ed-save").classList.toggle("busy", on); }
  function openEdit() {
    if (!info || info.kind !== "group" || !isAdminNow()) return;
    var p = pubInfo();
    ed = { photo: undefined, busy: false, sel: null };
    $("ed-name").value = p.name; $("ed-desc").value = p.description;
    edAvatar(); edMsg(""); edBusy(false); edShowEmo(false);
    $("ed-body").scrollTop = 0;
    openScreen("v-edit");
    edGrow();
  }
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var U = window.URL || window.webkitURL, url;
      try { url = U.createObjectURL(file); } catch (e) { reject(e); return; }
      var img = new Image(), done = function () { try { U.revokeObjectURL(url); } catch (e) {} };
      img.onload = function () { done(); resolve(img); };
      img.onerror = function () { done(); reject(new Error("image")); };
      img.src = url;
    });
  }
  function squareJpeg(img) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error("empty image");
    var s = Math.min(w, h), c = document.createElement("canvas"); c.width = PHOTO_PX; c.height = PHOTO_PX;
    var g = c.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, PHOTO_PX, PHOTO_PX);            // transparent PNGs: white, not black
    try { g.imageSmoothingQuality = "high"; } catch (e) {}
    g.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, PHOTO_PX, PHOTO_PX);
    var q = 0.85, url = c.toDataURL("image/jpeg", q);
    while (url.length > PHOTO_SOFT && q > 0.5) { q = Math.round((q - 0.1) * 100) / 100; url = c.toDataURL("image/jpeg", q); }
    if (!/^data:image\/jpeg;base64,/.test(url) || url.length > PHOTO_HARD) throw new Error("jpeg");
    return url;
  }
  function resizePhoto(file) { return loadImage(file).then(squareJpeg); }
  function pickPhoto() { if (!ed || ed.busy) return; edShowEmo(false); var f = $("ed-file"); f.value = ""; f.click(); }
  $("ed-photo").onclick = pickPhoto;
  $("ed-avb").onclick = pickPhoto;
  $("ed-file").addEventListener("change", function () {
    var f = $("ed-file").files && $("ed-file").files[0];
    if (!f || !ed) return;
    if (f.type && !/^image\//i.test(f.type)) { edMsg("Choose a photo (image file)."); return; }
    var my = ed; edMsg("");
    resizePhoto(f).then(function (url) { if (ed === my) { ed.photo = url; edAvatar(); } },
      function () { if (ed === my) edMsg("Couldn't read this photo. Try another one."); });
  });
  function edSave() {
    if (!ed || ed.busy) return;
    edShowEmo(false);
    var name = $("ed-name").value.replace(/\s+/g, " ").trim(), desc = $("ed-desc").value.replace(/\r\n?/g, "\n").trim();
    if (!name) { edMsg("Enter a chat name."); try { $("ed-name").focus(); } catch (e) {} return; }
    if (name.length > NAME_MAX) { edMsg("Name is too long (max " + NAME_MAX + " characters)."); return; }
    if (desc.length > DESC_MAX) { edMsg("Description is too long (max " + DESC_MAX + " characters)."); return; }
    var body = { action: "settings", name: name, description: desc };
    if (ed.photo !== undefined) body.photo = ed.photo;
    var my = ed; edBusy(true); edMsg("");
    chatApi("/api/chat?action=settings", { body: body }).then(function (d) {
      if (ed !== my) return;
      edBusy(false);
      if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
      if (!d.ok || !d.settings) {
        if (d._status === 403) { var c = getChat(); if (c) { c.isAdmin = false; setChat(c); } renderInfoPub(); }
        edMsg(d.message || "Couldn't save. Please try again."); return;
      }
      setPubInfo(d.settings);
      if (screens[screens.length - 1] === "v-edit") goBack();          // back to the info page, already updated
    }).catch(function () { if (ed === my) { edBusy(false); edMsg("Couldn't connect. Check your connection."); } });
  }
  $("ed-save").onclick = edSave;
  $("ed-back").onclick = goBack;
  // emoji button in the name field: the same EMOJI list as the chat's panel
  var edEmoCat = 0;
  function edEmoGrid() {
    var g = $("ed-emog"); g.textContent = ""; g.scrollTop = 0;
    EMOJI[edEmoCat][1].split(" ").forEach(function (e) {
      if (!e) return; var b = el("button", null, e); b.type = "button";
      b.onclick = function () { edInsert(e); };
      g.appendChild(b);
    });
    var tb = $("ed-emot").children; for (var i = 0; i < tb.length; i++) tb[i].classList.toggle("on", i === edEmoCat);
  }
  function edInsert(e) {
    var t = $("ed-name"), v = t.value, s = ed && ed.sel ? ed.sel[0] : v.length, en = ed && ed.sel ? ed.sel[1] : v.length;
    if (v.length - (en - s) + e.length > NAME_MAX) return;
    t.value = v.slice(0, s) + e + v.slice(en); if (ed) ed.sel = [s + e.length, s + e.length];
  }
  function edShowEmo(on) {
    $("ed-emop").classList.toggle("hide", !on); $("ed-emo").classList.toggle("on", on);
    if (!on) return;
    var t = $("ed-name"), n = t.value.length;
    if (ed) ed.sel = [typeof t.selectionStart === "number" ? t.selectionStart : n, typeof t.selectionEnd === "number" ? t.selectionEnd : n];
    try { t.blur(); } catch (e) {}
    if (!$("ed-emot").children.length) EMOJI.forEach(function (c, i) { var b = el("button", null, c[0]); b.type = "button"; b.onclick = function () { edEmoCat = i; edEmoGrid(); }; $("ed-emot").appendChild(b); });
    edEmoGrid();
  }
  $("ed-emo").addEventListener("click", function (e) {
    if (e && e.preventDefault) e.preventDefault();       // inside the <label>: don't focus the input
    var on = $("ed-emop").classList.contains("hide"); edShowEmo(on); if (!on) { try { $("ed-name").focus(); } catch (x) {} }
  });
  $("ed-name").addEventListener("focus", function () { edShowEmo(false); if (ed) ed.sel = null; });
  $("ed-name").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); try { $("ed-desc").focus(); } catch (x) {} } });
  $("ed-desc").addEventListener("focus", function () { edShowEmo(false); });
  $("ed-desc").addEventListener("input", edGrow);
  window.gcTest = window.gcTest || {};
  window.gcTest.resizePhoto = resizePhoto;       // read-only hook for tests / debugging

  // ---------- in-chat search: highlights matches in the loaded messages, ▲/▼ walk them (newest first) ----------
  function escRe(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function openSearch() {
    if (!ch) return;
    srch.on = true; srch.q = ""; srch.re = null; srch.cur = -1; srch.curKey = "";
    emoShow(false);
    var head = $("ch-sfield").parentNode; head.classList.add("searching");
    $("ch-sback").classList.remove("hide"); $("ch-sfield").classList.remove("hide");
    $("ch-form").classList.add("hide"); $("ch-sbar").classList.remove("hide");
    $("ch-q").value = ""; $("ch-qx").classList.add("hide");
    searchSync(false);
    try { $("ch-q").focus(); } catch (e) {}
  }
  // quiet = closing because the chat closes/changes (no re-render needed)
  function closeSearch(quiet) {
    if (!srch.on) return;
    srch.on = false; srch.q = ""; srch.re = null; srch.cur = -1; srch.curKey = ""; srch.marks = [];
    $("ch-sfield").parentNode.classList.remove("searching");
    $("ch-sback").classList.add("hide"); $("ch-sfield").classList.add("hide");
    $("ch-form").classList.remove("hide"); $("ch-sbar").classList.add("hide");
    $("ch-q").value = "";
    try { $("ch-q").blur(); } catch (e) {}
    if (!quiet && ch && ch.loaded) { var l = $("ch-list"), st = l.scrollTop; renderMsgs(); l.scrollTop = st; }
  }
  function searchQuery(v) {
    v = String(v || "").replace(/\s+/g, " ").trim();
    $("ch-qx").classList.toggle("hide", !$("ch-q").value);
    if (v === srch.q) return;
    srch.q = v; srch.re = v ? new RegExp(escRe(v), "gi") : null; srch.curKey = ""; srch.cur = -1;
    if (!ch || !ch.loaded) { searchSync(false); return; }
    var l = $("ch-list"), st = l.scrollTop;
    renderMsgs(); l.scrollTop = st;
    if (srch.marks.length) searchGo(srch.marks.length - 1);   // newest match first, like Telegram
  }
  // after every render: keep the current match (by message id + position), update "N of M" and the arrows
  function searchSync(scroll) {
    if (!srch.on) return;
    var mk = srch.marks, M = mk.length, i = -1;
    if (srch.curKey) for (var k = 0; k < M; k++) if (mk[k].gcKey === srch.curKey) { i = k; break; }
    if (i < 0 && M) i = srch.cur >= 0 ? Math.min(srch.cur, M - 1) : M - 1;
    srch.cur = M ? i : -1; srch.curKey = M ? mk[i].gcKey : "";
    for (var j = 0; j < M; j++) mk[j].classList.toggle("cur", j === srch.cur);
    $("ch-scount").textContent = !srch.q ? "" : (M ? (M - srch.cur) + " of " + M : "No results");
    $("ch-sup").disabled = !M || srch.cur <= 0;
    $("ch-sdown").disabled = !M || srch.cur >= M - 1;
    if (scroll && M) { var t = mk[srch.cur]; try { if (t.scrollIntoView) t.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { try { t.scrollIntoView(); } catch (e2) {} } }
  }
  function searchGo(i) {
    var M = srch.marks.length; if (!M) return;
    i = Math.max(0, Math.min(M - 1, i));
    srch.cur = i; srch.curKey = srch.marks[i].gcKey; searchSync(true);
  }
  $("ch-sback").onclick = function () { closeSearch(); };
  $("ch-q").addEventListener("input", function () { searchQuery($("ch-q").value); });
  $("ch-q").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); try { $("ch-q").blur(); } catch (x) {} if (srch.marks.length) searchGo(srch.cur > 0 ? srch.cur - 1 : srch.cur); }
    else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
  });
  $("ch-qx").onclick = function () { $("ch-q").value = ""; searchQuery(""); try { $("ch-q").focus(); } catch (e) {} };
  $("ch-sup").onclick = function () { searchGo(srch.cur - 1); };      // older
  $("ch-sdown").onclick = function () { searchGo(srch.cur + 1); };    // newer
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && ["v-info", "v-edit", "v-pedit", "v-set", "v-spost"].indexOf(screens[screens.length - 1]) >= 0) { goBack(); return; }
    if (e.key !== "Escape" || screens[screens.length - 1] !== "v-chat") return;
    if (popOpen()) closePop(); else if (srch.on && document.activeElement !== $("ch-q")) closeSearch();
  });
  // Emoji panel (Telegram-style): tap the smiley to open, tap an emoji to insert it at the cursor.
  var EMOJI = [
    ["😀", "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👻 💀 👽 🤖 💩 😺 😸 😹 😻 😼 😽 🙀 😿 😾"],
    ["👍", "👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 👀 👁️ 👅 👄 💋 🫶 🙋 🙆 🙅 🤷 🤦 🙇 💁 🧏 👫 👬 👭 💏 💑 👪"],
    ["❤️", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 ⚡ 🎉 🎊 🎁 🏆 🥇 👑 💎 💰 💸 📣 📢 🔔 ✅ ❌ ⚠️ ❓ ❗ 🆘 🔞 📌 🔗 💬 🗨️ 👉 🆕 🆓 🔝"],
    ["🐶", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐬 🐳 🦈 🌸 🌹 🌺 🌻 🌼 🌷 🍀 🌿 🌴 🌈 ☀️ 🌙 ⭐ ☁️ ❄️ 🌊"],
    ["🍔", "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🌶️ 🌽 🍞 🧀 🍳 🍗 🍖 🍔 🍟 🍕 🌭 🥪 🌮 🍜 🍝 🍣 🍱 🍛 🍚 🍙 🍦 🍩 🍪 🎂 🍰 🍫 🍬 🍭 ☕ 🧋 🍺 🍻 🥂 🍷 🥤"],
    ["⚽", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🏸 🥊 🎮 🕹️ 🎲 🎯 🎳 🎤 🎧 🎵 🎶 🎸 🎹 🎬 📷 📱 💻 ⌚ 🚗 🚕 🏍️ ✈️ 🚀 🏠 🏙️ 🌃 🎡 🏖️ ⛰️ 🗺️ 🇲🇲"]
  ];
  var emoCat = 0, emoSel = null;
  function emoGrid() {
    var g = $("ch-emog"); g.textContent = ""; g.scrollTop = 0;
    EMOJI[emoCat][1].split(" ").forEach(function (e) {
      if (!e) return; var b = el("button", null, e); b.type = "button";
      b.onclick = function () { emoInsert(e); };
      g.appendChild(b);
    });
    var tb = $("ch-emot").children; for (var i = 0; i < tb.length; i++) tb[i].classList.toggle("on", i === emoCat);
  }
  function emoInsert(e) {
    var t = $("ch-text"), v = t.value, s = emoSel ? emoSel[0] : v.length, en = emoSel ? emoSel[1] : v.length;
    if (v.length - (en - s) + e.length > (t.maxLength > 0 ? t.maxLength : 1000)) return;
    t.value = v.slice(0, s) + e + v.slice(en); emoSel = [s + e.length, s + e.length]; autoGrow();
  }
  function emoShow(on) {
    $("ch-emop").classList.toggle("hide", !on); $("ch-emo").classList.toggle("on", on);
    if (on) { var t = $("ch-text"); emoSel = [t.selectionStart || t.value.length, t.selectionEnd || t.value.length]; t.blur(); if (!$("ch-emot").children.length) { EMOJI.forEach(function (c, i) { var b = el("button", null, c[0]); b.type = "button"; b.onclick = function () { emoCat = i; emoGrid(); }; $("ch-emot").appendChild(b); }); } emoGrid(); var l = $("ch-list"); setTimeout(function () { l.scrollTop = l.scrollHeight; }, 30); }
  }
  $("ch-emo").addEventListener("click", function () { var on = $("ch-emop").classList.contains("hide"); emoShow(on); if (!on) $("ch-text").focus(); });
  $("ch-text").addEventListener("focus", function () { emoShow(false); });
  $("ch-form").addEventListener("submit", function (e) { e.preventDefault(); sendMsg(); emoSel = null; if ($("ch-emop").classList.contains("hide")) $("ch-text").focus(); });
  $("ch-text").addEventListener("input", autoGrow);
  $("ch-text").addEventListener("keydown", function (e) {
    var fine = window.matchMedia && window.matchMedia("(pointer:fine)").matches;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && fine) { e.preventDefault(); sendMsg(); }
  });
  $("row-public").onclick = function () { openChat({ room: "public" }); };
  $("row-support").onclick = function () { if (getChat() && getChat().isAdmin) openThreads(); else openChat({ room: "support" }); };

  // ---------- custom profiles (Edit Info): other users' photos / bios, cached on this device ----------
  // Chat lists carry only `pv` (profile version) and the custom name; the photo is fetched once per user + version
  // (/api/profile?u=) and kept in localStorage gc_prof:<u> (newest PROF_KEEP users). Never part of the 20 s poll.
  var PPFX = "gc_prof:", PROF_KEEP = 30, profMem = {}, profWant = {}, profQ = [], profBusy = 0, avReg = {};
  function profGet(u) {
    if (!u) return null;
    if (profMem[u]) return profMem[u];
    try { var o = JSON.parse(localStorage.getItem(PPFX + u) || "null"); if (o && typeof o === "object" && o.v != null) { profMem[u] = o; return o; } } catch (e) {}
    return null;
  }
  function profPut(u, p) {
    if (!u) return;
    var o = { v: String(p.v || ""), n: String(p.name || ""), b: String(p.bio || ""), p: photoOk(p.photo), t: Date.now() };
    profMem[u] = o;
    var put = function () { localStorage.setItem(PPFX + u, JSON.stringify(o)); };
    try { put(); }
    catch (e) {   // quota: drop the other cached profiles, then the chat caches' oldest half, then give up (memory only)
      try { lsKeys().forEach(function (k) { if (k.indexOf(PPFX) === 0 && k !== PPFX + u) localStorage.removeItem(k); }); put(); } catch (e2) {}
    }
    var ks = lsKeys().filter(function (k) { return k.indexOf(PPFX) === 0; });
    if (ks.length > PROF_KEEP) {
      ks.map(function (k) { var t = 0; try { t = Number((JSON.parse(localStorage.getItem(k) || "{}") || {}).t) || 0; } catch (e) {} return { k: k, t: t }; })
        .sort(function (a, b) { return a.t - b.t; }).slice(0, ks.length - PROF_KEEP)
        .forEach(function (x) { if (x.k !== PPFX + u) { try { localStorage.removeItem(x.k); } catch (e) {} } });
    }
  }
  function profNeed(u, v) {
    if (!u || !v || !chatReady()) return;
    var c = profGet(u);
    if ((c && c.v === v) || profWant[u] === v) return;
    profWant[u] = v; profQ.push(u); profPump();
  }
  function profPump() {
    while (profBusy < 2 && profQ.length) {
      (function (u) {
        var want = profWant[u]; profBusy++;
        chatApi("/api/profile?u=" + encodeURIComponent(u)).then(function (d) {
          profBusy--;
          if (d && d.ok) {
            var p = d.profile;
            profPut(u, p ? { v: p.v || want, name: p.name, bio: p.bio, photo: p.photo } : { v: want, photo: "" });
            profApply(u);
          }
          profPump();
        }).catch(function () { profBusy--; profPump(); });   // profWant keeps the version: no retry storm this session
      })(profQ.shift());
    }
  }
  // avatar for a user that may have a custom profile photo: o = {u, pv, photo (Telegram url), name}
  function uAvatar(o, cls) {
    o = o || {};
    var pv = o.pv ? String(o.pv) : "", c = pv ? profGet(o.u) : null;
    var a = avatar(c && c.v === pv && c.p ? c.p : o.photo, o.name, o.u, cls);
    if (o.u && pv) {
      var list = avReg[o.u] = (avReg[o.u] || []).slice(-40);
      list.push({ a: a, name: o.name, photo: o.photo, pv: pv });
      if (!c || c.v !== pv) profNeed(o.u, pv);
    }
    storyRing(a, o.u);
    return a;
  }
  // a fetched profile arrived: update the avatars already on screen (+ the admin user-info Bio)
  function profApply(u) {
    var c = profGet(u);
    (avReg[u] || []).forEach(function (r) { if (c && c.v === r.pv) setAvImg(r.a, c.p || r.photo, r.name); });
    if (info && info.kind === "user" && ch && ch.info.seed === u) renderAbout(info.member || null);
  }

  // ---------- own profile (GET/POST /api/profile), cached as gc_myprof ----------
  var MYKEY = "gc_myprof", myProf = null, myBusy = false, BIO_MAX = 70, FIRST_MAX = 64;
  function getMyProf() {
    var o = cacheOwner(); if (!o) return null;
    if (myProf && myProf.o === o) return myProf;
    try { var x = JSON.parse(localStorage.getItem(MYKEY) || "null"); if (x && x.o === o) { myProf = x; return x; } } catch (e) {}
    return null;
  }
  function setMyProf(p) {
    var o = cacheOwner(); if (!o || !p) return;
    myProf = { o: o, t: Date.now(), first_name: String(p.first_name || ""), last_name: String(p.last_name || ""), bio: String(p.bio || ""),
      photo: photoOk(p.photo), v: String(p.v || ""), u: String(p.u || ""), username: String(p.username || ""), tg_photo: String(p.tg_photo || ""), custom: !!p.custom };
    try { localStorage.setItem(MYKEY, JSON.stringify(myProf)); }
    catch (e) { try { localStorage.setItem(MYKEY, JSON.stringify(Object.assign({}, myProf, { photo: "" }))); } catch (e2) {} }
    if (myProf.u && myProf.v) profPut(myProf.u, { v: myProf.v, name: myName(), bio: myProf.bio, photo: myProf.photo });
  }
  function loadMyProfile(force) {
    if (!chatReady() || myBusy) return;
    var m = getMyProf();
    if (!force && m && Date.now() - (m.t || 0) < 60000) return;
    myBusy = true;
    var owner = cacheOwner();
    chatApi("/api/profile").then(function (d) {
      myBusy = false;
      if (d._status === 401) { chatExpired(); return; }
      if (!d.ok || !d.profile || cacheOwner() !== owner) return;
      setMyProf(d.profile);
      if (pe && pe.photo === undefined) peAvatar();   // Edit Info open: show the fresh photo / Remove Photo
      if (current === "profile") renderProfile();
    }).catch(function () { myBusy = false; });
  }
  function myName() {
    var m = getMyProf(), u = anyUser() || {};
    var n = m && m.first_name ? [m.first_name, m.last_name].filter(Boolean).join(" ") : [u.first_name, u.last_name].filter(Boolean).join(" ");
    return n || (u.username ? "@" + u.username : "Telegram user");
  }
  function myPhoto() { var m = getMyProf(), u = anyUser() || {}; return (m && m.photo) || (m && m.tg_photo) || u.photo_url || ""; }
  function myU() { var m = getMyProf(); return (m && m.u) || stories.me || ""; }

  // ---------- Profile tab ----------
  function pfMsg(text, kind) { var m = $("pf-msg"); m.className = "msg" + (kind ? " " + kind : ""); m.textContent = text || ""; if (!text) m.classList.add("hide"); }
  function renderProfile() {
    var logged = inTg || getSession() || getChat();
    $("pf-login").classList.toggle("hide", !!logged);
    $("pf-body").classList.toggle("hide", !logged);
    if (!logged) { $("pf-login").textContent = ""; loginPanel($("pf-login"), { id: "login-pf", title: "Log in", hint: "Log in with your Telegram account to see your profile, your promoted groups, and to chat." }); return; }
    var u = anyUser() || {}, c = getChat(), m = getMyProf(), name = myName();
    var old = $("pf-av"), av = avatar(myPhoto(), name, String(u.id || ""), "av pav"); av.id = "pf-av";
    storyRing(av, myU());
    old.parentNode.replaceChild(av, old);
    $("pf-name").textContent = name;
    $("pf-admin").classList.toggle("hide", !(c && c.isAdmin));
    // info card: Bio (links tappable) + Username, like Telegram (never a phone number)
    var box = $("pf-about"); box.textContent = "";
    var bio = m ? m.bio.trim() : "", uname = (m && m.username) || u.username || "";
    if (bio) { var r = el("div", "iarow"), t = el("div", "iav1 idtx"); t.appendChild(linkify(bio)); r.appendChild(t); r.appendChild(el("div", "ial", "Bio")); box.appendChild(r); }
    if (uname) aboutRow(box, "@" + uname, "Username");
    box.classList.toggle("hide", !bio && !uname);
    var cl = $("pf-chatlogin"); cl.textContent = ""; cl.classList.add("hide");
    if (!inTg && !c) { cl.classList.remove("hide"); loginPanel(cl, { id: "login-pfchat", title: "Turn on chat", hint: "Log in with Telegram once more to use Messages, Support, Edit Info and My Day." }); }
    if (c && $("pf-msg").textContent === "Log in with Telegram below first.") pfMsg("");
    loadBalance();
    if (!mineLoaded) loadMine();
    if (c) { loadMyProfile(false); loadStories(false); }
  }
  function needChatHere() {
    if (chatReady()) return true;
    pfMsg(inTg ? (chatState === "fail" ? (chatFailMsg || "Chat is not available.") : "Connecting… try again in a moment.") : "Log in with Telegram below first.", "err");
    return false;
  }
  $("pf-edit").onclick = function () { if (needChatHere()) openPEdit(); };
  $("pf-settings").onclick = function () { openSettings(); };
  $("pf-myday").onclick = function () { if (needChatHere()) pickStory(); };
  $("pf-avb").onclick = function () {
    var ph = myPhoto();
    if (ph) { openPView(); return; }
    var g = storyGroup(myU());
    if (g) openViewer([g], 0); else if (chatReady()) openPEdit();
  };

  // ---------- Profile photo viewer: tap the big avatar → full photo, Change / Delete ----------
  var pvBusy = false;
  function pvMsg(t) { var m = $("pv-msg"); m.textContent = t || ""; m.classList.toggle("hide", !t); }
  function pvUi() {
    var m = getMyProf();
    $("pv-img").src = myPhoto();
    $("pv-del").classList.toggle("hide", !(m && m.photo));
    $("pv-day").classList.toggle("hide", !storyGroup(myU()));
    $("pv-del").disabled = pvBusy;
  }
  function openPView() { pvBusy = false; pvMsg(""); pvUi(); openScreen("v-pview"); }
  $("pv-close").onclick = goBack;
  $("pv-change").onclick = function () { if (!needChatHere()) return; goBack(); openPEdit(); };
  $("pv-day").onclick = function () { var g = storyGroup(myU()); if (g) { goBack(); openViewer([g], 0); } };
  function pvDelete() {
    var m = getMyProf(), u = anyUser() || {};
    if (pvBusy || !m || !m.photo) return;
    if (!chatReady()) { pvMsg("Connecting… try again in a moment."); return; }
    var body = { first_name: m.first_name || u.first_name || myName(), last_name: m.first_name ? (m.last_name || "") : (u.last_name || ""), bio: m.bio || "", photo: "" };
    pvBusy = true; pvUi(); pvMsg("");
    chatApi("/api/profile", { body: body }).then(function (d) {
      pvBusy = false;
      if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
      if (!d.ok || !d.profile) { pvUi(); pvMsg(d.message || "Couldn't delete. Please try again."); return; }
      setMyProf(d.profile); renderProfile();
      if (screens[screens.length - 1] === "v-pview") { if (myPhoto()) pvUi(); else goBack(); }
    }).catch(function () { pvBusy = false; pvUi(); pvMsg("Couldn't connect. Check your connection."); });
  }
  $("pv-del").onclick = function () {
    if (pvBusy) return;
    var go = function (ok) { if (ok) pvDelete(); };
    if (inTg && tg.showConfirm) { try { tg.showConfirm("Delete your profile photo?", go); return; } catch (e) {} }
    go(window.confirm("Delete your profile photo?"));
  };

  // ---------- Edit Info: photo (320x320 JPEG made on this device), first / last name, bio (70) ----------
  var pe = null;   // {photo: undefined (unchanged) | "" (remove) | data url, busy}
  function peMsg(text) { var m = $("pe-msg"); m.textContent = text || ""; m.classList.toggle("hide", !text); }
  function peCustomPhoto() { var m = getMyProf(); return pe && pe.photo !== undefined ? pe.photo : (m ? m.photo : ""); }
  function peAvatar() {
    var u = anyUser() || {}, m = getMyProf(), cp = peCustomPhoto();
    var shown = cp || (m && m.tg_photo) || u.photo_url || "";
    swapAv("pe-av", avatar(shown, $("pe-first").value || myName(), String(u.id || ""), "av peav"));
    $("pe-rmphoto").classList.toggle("hide", !cp);
  }
  function peCount() {
    var n = BIO_MAX - $("pe-bio").value.length, c = $("pe-count");
    c.textContent = String(n); c.classList.toggle("neg", n < 0);
    var t = $("pe-bio"); t.style.height = "auto"; t.style.height = Math.min(Math.max(t.scrollHeight, 24), 140) + "px";
  }
  function peBusy(on) { if (pe) pe.busy = on; $("pe-save").disabled = on; $("pe-save").classList.toggle("busy", on); }
  function openPEdit() {
    if (!chatReady()) return;
    var m = getMyProf(), u = anyUser() || {};
    pe = { photo: undefined, busy: false };
    $("pe-first").value = m && m.first_name ? m.first_name : (u.first_name || "");
    $("pe-last").value = m && m.first_name ? m.last_name : (u.last_name || "");
    $("pe-bio").value = m ? m.bio : "";
    peMsg(""); peBusy(false); peAvatar(); peCount();
    $("pe-body").scrollTop = 0;
    openScreen("v-pedit");
    loadMyProfile(true);   // fresh copy (another device may have changed it); fields stay as typed
  }
  function pePick() { if (!pe || pe.busy) return; var f = $("pe-file"); f.value = ""; f.click(); }
  $("pe-avb").onclick = pePick;
  $("pe-photo").onclick = pePick;
  $("pe-rmphoto").onclick = function () { if (!pe || pe.busy) return; pe.photo = ""; peAvatar(); };
  $("pe-file").addEventListener("change", function () {
    var f = $("pe-file").files && $("pe-file").files[0];
    if (!f || !pe) return;
    if (f.type && !/^image\//i.test(f.type)) { peMsg("Choose a photo (image file)."); return; }
    var my = pe; peMsg("");
    resizePhoto(f).then(function (url) { if (pe === my) { pe.photo = url; peAvatar(); } },
      function () { if (pe === my) peMsg("Couldn't read this photo. Try another one."); });
  });
  $("pe-bio").addEventListener("input", peCount);
  $("pe-first").addEventListener("input", function () { if (pe && !peCustomPhoto()) peAvatar(); });
  $("pe-first").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); try { $("pe-last").focus(); } catch (x) {} } });
  $("pe-last").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); try { $("pe-bio").focus(); } catch (x) {} } });
  function peSave() {
    if (!pe || pe.busy) return;
    var first = $("pe-first").value.replace(/\s+/g, " ").trim(), last = $("pe-last").value.replace(/\s+/g, " ").trim();
    var bio = $("pe-bio").value.replace(/\r\n?/g, "\n").trim();
    if (!first) { peMsg("Enter your first name."); try { $("pe-first").focus(); } catch (e) {} return; }
    if (first.length > FIRST_MAX) { peMsg("First name is too long (max " + FIRST_MAX + " characters)."); return; }
    if (last.length > FIRST_MAX) { peMsg("Last name is too long (max " + FIRST_MAX + " characters)."); return; }
    if (bio.length > BIO_MAX) { peMsg("Bio is too long (max " + BIO_MAX + " characters)."); return; }
    var body = { first_name: first, last_name: last, bio: bio };
    if (pe.photo !== undefined) body.photo = pe.photo;
    var my = pe; peBusy(true); peMsg("");
    chatApi("/api/profile", { body: body }).then(function (d) {
      if (pe !== my) return;
      peBusy(false);
      if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
      if (!d.ok || !d.profile) { peMsg(d.message || "Couldn't save. Please try again."); return; }
      setMyProf(d.profile);
      if (screens[screens.length - 1] === "v-pedit") goBack();
      renderProfile();
    }).catch(function () { if (pe === my) { peBusy(false); peMsg("Couldn't connect. Check your connection."); } });
  }
  $("pe-save").onclick = peSave;
  $("pe-back").onclick = goBack;

  // ---------- Settings ----------
  function themeUi() {
    var p = themePref();
    Array.prototype.forEach.call($("set-theme").children, function (b) {
      var on = b.getAttribute("data-theme") === p; b.classList.toggle("on", on); b.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  function openSettings() {
    themeUi();
    $("set-stars-v").textContent = fmtStars(stars.bal || 0);
    $("set-out").classList.toggle("hide", inTg || !(getSession() || getChat()));
    openScreen("v-set");
    if (loggedIn()) loadBalance().then(function () { $("set-stars-v").textContent = fmtStars(stars.bal || 0); });
  }
  Array.prototype.forEach.call($("set-theme").children, function (b) { b.onclick = function () { setTheme(b.getAttribute("data-theme")); themeUi(); }; });
  $("set-back").onclick = goBack;
  $("set-stars").onclick = function () { openStars(); };
  $("set-help").onclick = function () { open(botLink("paysupport")); };
  $("set-terms").onclick = function () { open(botLink("terms")); };
  $("set-support").onclick = function () {
    if (!chatReady()) { tab("msg"); return; }
    closeAllScreens();
    if (getChat().isAdmin) openThreads(); else openChat({ room: "support" });
  };
  $("set-logout").onclick = function () { logout(); };

  // ---------- My Day (stories) ----------
  // List (metadata only, no photos) from /api/stories, kept in memory + gc_stories on this device; each photo is
  // fetched by id when viewed (memory cache). Seen story ids: gc_story_seen (this device) → grey ring.
  var STKEY = "gc_stories", SEENSTKEY = "gc_story_seen", STORY_MS = 5000, STORIES_TTL = 60000, CAPTION_MAX = 200;
  var stories = { list: [], me: "", at: 0, busy: false, missing: false }, storyImgs = {}, storyImgKeys = [];
  function stLoadCache() {
    try { var o = JSON.parse(localStorage.getItem(STKEY) || "null"); if (o && o.o === cacheOwner() && Array.isArray(o.d)) { stories.list = o.d; stories.me = String(o.me || ""); } } catch (e) {}
  }
  function activeStories() { var now = Date.now(); return stories.list.filter(function (s) { return s && Date.parse(s.exp) > now; }); }
  function seenSet() { try { var a = JSON.parse(localStorage.getItem(SEENSTKEY) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function markSeen(id) {
    var a = seenSet(); if (a.indexOf(id) >= 0) return;
    a.push(id); if (a.length > 400) a = a.slice(-400);
    try { localStorage.setItem(SEENSTKEY, JSON.stringify(a)); } catch (e) {}
  }
  // groups by user (newest user first), each group's stories oldest → newest (viewing order)
  function storyGroups() {
    var by = {}, order = [];
    activeStories().forEach(function (s) { if (!by[s.u]) { by[s.u] = { u: s.u, name: s.name, photo: s.photo, pv: s.pv, mine: s.mine, items: [] }; order.push(s.u); } by[s.u].items.push(s); });
    return order.map(function (u) { var g = by[u]; g.items.sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at) || a.id - b.id; }); return g; });
  }
  function storyGroup(u) { if (!u) return null; var gs = storyGroups(); for (var i = 0; i < gs.length; i++) if (gs[i].u === u) return gs[i]; return null; }
  function groupSeen(g) { var s = seenSet(); return g.items.every(function (x) { return s.indexOf(x.id) >= 0; }); }
  // green ring (grey when every story was seen) on an avatar of a user with active stories
  function storyRing(a, u) {
    var g = storyGroup(u);
    a.classList.toggle("ring", !!g); a.classList.toggle("seen", !!g && groupSeen(g));
    return !!g;
  }
  function loadStories(force) {
    if (!chatReady()) return Promise.resolve(false);
    if (!stories.list.length && !stories.at) stLoadCache();
    if (stories.busy || (!force && Date.now() - stories.at < STORIES_TTL)) { storiesChanged(); return Promise.resolve(false); }
    stories.busy = true;
    var owner = cacheOwner();
    return chatApi("/api/stories").then(function (d) {
      stories.busy = false;
      if (d._status === 401) { chatExpired(); return false; }
      if (!d.ok || cacheOwner() !== owner) return false;
      stories.list = (Array.isArray(d.stories) ? d.stories : []).filter(function (s) { return s && Number(s.id) > 0 && s.u; });
      stories.me = String(d.me || ""); stories.at = Date.now(); stories.missing = !!d.needSql;
      try { localStorage.setItem(STKEY, JSON.stringify({ o: owner, me: stories.me, d: stories.list })); } catch (e) {}
      storiesChanged();
      return true;
    }).catch(function () { stories.busy = false; return false; });
  }
  function storiesChanged() {
    renderDays();
    if (current === "profile" && !$("pf-body").classList.contains("hide")) storyRing($("pf-av"), myU());
    if (ch && screens[screens.length - 1] === "v-chat" && ch.loaded) { var l = $("ch-list"), st = l.scrollTop; renderMsgs(); l.scrollTop = st; }
  }
  // the strip at the top of the Messages tab: Add (own photo + green plus), then people with active stories
  function renderDays() {
    var box = $("days"); box.textContent = "";
    var on = current === "msg" && chatReady() && !sq.msg.trim();
    box.classList.toggle("hide", !on);
    if (!on) return;
    var u = anyUser() || {};
    var add = el("button", "day1 dayadd"); add.type = "button"; add.setAttribute("role", "listitem"); add.setAttribute("aria-label", "Add to My Day");
    var w = el("span", "dayw"); w.appendChild(avatar(myPhoto(), myName(), String(u.id || ""), "av")); w.appendChild(el("span", "dayplus", "+"));
    add.appendChild(w); add.appendChild(el("span", "dayn", "Add"));
    add.onclick = function () { pickStory(); };
    box.appendChild(add);
    var gs = storyGroups(), me = myU();
    gs.sort(function (a, b) { return (a.u === me ? -1 : 0) - (b.u === me ? -1 : 0); });   // own My Day first, then newest
    gs.forEach(function (g, i) {
      var b = el("button", "day1" + (groupSeen(g) ? " seen" : "")); b.type = "button"; b.setAttribute("role", "listitem");
      var own = g.u === me || g.mine;
      var a = own ? avatar(myPhoto(), myName(), String(u.id || ""), "av") : uAvatar({ u: g.u, pv: g.pv, photo: g.photo, name: g.name }, "av");
      storyRing(a, g.u);
      var w2 = el("span", "dayw"); w2.appendChild(a); b.appendChild(w2);
      var label = g.u === me || g.mine ? "My Day" : String(g.name || "User").split(" ")[0];
      b.appendChild(el("span", "dayn", label));
      b.setAttribute("aria-label", (g.u === me || g.mine ? "My Day" : g.name) + ", " + g.items.length + (g.items.length === 1 ? " story" : " stories"));
      b.onclick = function () { openViewer(gs, i); };
      box.appendChild(b);
    });
  }
  // ----- post: pick a photo → preview with caption → Share -----
  var sp = null;   // {photo, busy}
  var STORY_SIDE = 1080, STORY_SOFT = 190000, STORY_HARD = 204000;   // data-url chars: ~140 KB target, < 150 KB hard
  function storyJpeg(img) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error("empty image");
    var scale = Math.min(1, STORY_SIDE / Math.max(w, h)), url = "";
    for (var round = 0; round < 6; round++) {
      var cw = Math.max(1, Math.round(w * scale)), chh = Math.max(1, Math.round(h * scale));
      var c = document.createElement("canvas"); c.width = cw; c.height = chh;
      var g = c.getContext("2d"); g.fillStyle = "#000000"; g.fillRect(0, 0, cw, chh);
      try { g.imageSmoothingQuality = "high"; } catch (e) {}
      g.drawImage(img, 0, 0, w, h, 0, 0, cw, chh);
      var q = 0.82; url = c.toDataURL("image/jpeg", q);
      while (url.length > STORY_SOFT && q > 0.5) { q = Math.round((q - 0.08) * 100) / 100; url = c.toDataURL("image/jpeg", q); }
      if (url.length <= STORY_SOFT) break;
      scale *= 0.8;
    }
    if (!/^data:image\/jpeg;base64,/.test(url) || url.length > STORY_HARD) throw new Error("jpeg");
    return url;
  }
  function spMsg(text) { var m = $("sp-msg"); m.textContent = text || ""; m.classList.toggle("hide", !text); }
  function pickStory() {
    if (!chatReady()) { if (current === "profile") needChatHere(); else tab("msg"); return; }
    var f = $("sp-file"); f.value = ""; f.click();
  }
  $("sp-file").addEventListener("change", function () {
    var f = $("sp-file").files && $("sp-file").files[0];
    if (!f) return;
    if (f.type && !/^image\//i.test(f.type)) { (current === "profile" ? pfMsg : chatsMsg)("Choose a photo (image file).", "err"); return; }
    loadImage(f).then(storyJpeg).then(function (url) { openStoryPost(url); },
      function () { (current === "profile" ? pfMsg : chatsMsg)("Couldn't read this photo. Try another one.", "err"); });
  });
  function chatsMsg(text, kind) { var m = $("chats-msg"); m.className = "msg" + (kind ? " " + kind : ""); m.textContent = text || ""; if (!text) m.classList.add("hide"); }
  function openStoryPost(url) {
    sp = { photo: url, busy: false };
    $("sp-img").src = url; $("sp-cap").value = ""; spCount(); spMsg("");
    $("sp-share").disabled = false; $("sp-share").textContent = "Share";
    openScreen("v-spost"); spCount();   // measure after the screen is visible (hidden = 0 height)
  }
  function spCount() {
    var t = $("sp-cap"), n = CAPTION_MAX - t.value.length; $("sp-count").textContent = String(n);
    t.style.height = "auto"; t.style.height = Math.min(Math.max(t.scrollHeight, 47), 110) + "px";
  }
  $("sp-cap").addEventListener("input", spCount);
  $("sp-close").onclick = goBack;
  function shareStory() {
    if (!sp || sp.busy) return;
    var cap = $("sp-cap").value.replace(/\r\n?/g, "\n").trim();
    if (cap.length > CAPTION_MAX) { spMsg("Caption is too long (max " + CAPTION_MAX + " characters)."); return; }
    var my = sp; sp.busy = true; $("sp-share").disabled = true; $("sp-share").textContent = "Sharing…"; spMsg("");
    chatApi("/api/stories", { body: { action: "post", photo: sp.photo, caption: cap } }).then(function (d) {
      if (sp !== my) return;
      sp.busy = false; $("sp-share").disabled = false; $("sp-share").textContent = "Share";
      if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
      if (!d.ok || !d.story) { spMsg(d.message || "Couldn't share. Please try again."); return; }
      var s = d.story; if (s.id) { storyImgPut(s.id, my.photo); markSeen(s.id); }
      stories.list = [s].concat(stories.list.filter(function (x) { return x.id !== s.id; }));
      if (s.u) stories.me = s.u;
      if (screens[screens.length - 1] === "v-spost") goBack();
      storiesChanged();
      if (current === "profile") pfMsg("✅ Shared to My Day. It stays for 24 hours.", "okm");
      loadStories(true);
    }).catch(function () { if (sp === my) { sp.busy = false; $("sp-share").disabled = false; $("sp-share").textContent = "Share"; spMsg("Couldn't connect. Check your connection."); } });
  }
  $("sp-share").onclick = shareStory;
  function storyImgPut(id, url) {
    storyImgs[id] = url; storyImgKeys = storyImgKeys.filter(function (k) { return k !== id; }); storyImgKeys.push(id);
    while (storyImgKeys.length > 20) delete storyImgs[storyImgKeys.shift()];
  }
  var imgWant = {};
  function storyImg(id) {
    if (storyImgs[id]) return Promise.resolve(storyImgs[id]);
    if (imgWant[id]) return imgWant[id];
    imgWant[id] = chatApi("/api/stories?id=" + encodeURIComponent(id)).then(function (d) {
      delete imgWant[id];
      if (d && d.ok && d.story && photoOk(d.story.image)) { storyImgPut(id, d.story.image); return d.story.image; }
      if (d && d._status === 404) return null;
      throw new Error("load");
    }, function (e) { delete imgWant[id]; throw e; });
    return imgWant[id];
  }
  // ----- viewer -----
  var sv = null;   // {groups, gi, si, timer, startAt, remain, paused, gen}
  function timeAgo(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return "";
    var m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
    var h = Math.floor(m / 60); return h + (h === 1 ? " hour ago" : " hours ago");
  }
  function openViewer(groups, gi) {
    groups = (groups || []).filter(function (g) { return g && g.items && g.items.length; });
    if (!groups.length) return;
    gi = Math.max(0, Math.min(groups.length - 1, gi || 0));
    var seen = seenSet(), g = groups[gi], si = 0;
    for (var i = 0; i < g.items.length; i++) if (seen.indexOf(g.items[i].id) < 0) { si = i; break; }
    sv = { groups: groups, gi: gi, si: si, timer: null, startAt: 0, remain: STORY_MS, paused: false, gen: 0 };
    openScreen("v-sview");
    svShow();
  }
  function svCur() { return sv ? sv.groups[sv.gi].items[sv.si] : null; }
  function svStop() { if (sv && sv.timer) { clearTimeout(sv.timer); sv.timer = null; } }
  function svShow() {
    if (!sv) return;
    svStop();
    var g = sv.groups[sv.gi], s = g.items[sv.si], gen = ++sv.gen;
    var bars = $("sv-bars"); bars.textContent = "";
    g.items.forEach(function (x, i) { var b = el("span", "svbar" + (i < sv.si ? " done" : "")); b.appendChild(el("i")); bars.appendChild(b); });
    var me0 = anyUser() || {};
    swapAv("sv-av", g.mine ? avatar(myPhoto(), myName(), String(me0.id || ""), "av svav") : uAvatar({ u: g.u, pv: g.pv, photo: g.photo, name: g.name }, "av svav"));
    $("sv-av").classList.remove("ring", "seen");
    $("sv-name").textContent = g.mine ? "My Day" : (g.name || "User");
    $("sv-time").textContent = timeAgo(s.at);
    $("sv-del").classList.toggle("hide", !(s.mine || isAdminNow()));
    var cap = $("sv-cap"); cap.textContent = ""; cap.classList.toggle("hide", !s.caption);
    if (s.caption) cap.appendChild(linkify(String(s.caption)));
    $("sv-gone").classList.add("hide");
    var img = $("sv-img"); img.removeAttribute && img.removeAttribute("src"); img.classList.add("hide");
    $("sv-load").classList.remove("hide");
    markSeen(s.id);
    storyImg(s.id).then(function (url) {
      if (!sv || sv.gen !== gen) return;
      $("sv-load").classList.add("hide");
      if (!url) { $("sv-gone").classList.remove("hide"); svStart(1500); return; }
      img.src = url; img.classList.remove("hide");
      svStart(STORY_MS);
      var nx = g.items[sv.si + 1] || (sv.groups[sv.gi + 1] && sv.groups[sv.gi + 1].items[0]);
      if (nx) storyImg(nx.id).catch(function () {});              // preload the next one
    }, function () {
      if (!sv || sv.gen !== gen) return;
      $("sv-load").classList.add("hide"); $("sv-gone").textContent = "Couldn't load this story."; $("sv-gone").classList.remove("hide");
      svStart(2500);
    });
  }
  function svStart(ms) {
    if (!sv) return;
    var bar = $("sv-bars").children[sv.si];
    if (bar) { bar.classList.add("cur"); bar.classList.remove("paused"); var i = bar.children[0]; if (i) i.style.animationDuration = ms + "ms"; }
    sv.remain = ms; sv.startAt = Date.now(); sv.paused = false;
    sv.timer = setTimeout(svNext, ms);
  }
  function svPause(on) {
    if (!sv || !sv.timer && !sv.paused) return;
    var bar = $("sv-bars").children[sv.si];
    if (on && !sv.paused) { svStop(); sv.remain = Math.max(200, sv.remain - (Date.now() - sv.startAt)); sv.paused = true; if (bar) bar.classList.add("paused"); }
    else if (!on && sv.paused) { sv.paused = false; if (bar) bar.classList.remove("paused"); sv.startAt = Date.now(); sv.timer = setTimeout(svNext, sv.remain); }
  }
  function svNext() {
    if (!sv) return;
    var g = sv.groups[sv.gi];
    if (sv.si < g.items.length - 1) { sv.si++; svShow(); return; }
    if (sv.gi < sv.groups.length - 1) { sv.gi++; sv.si = 0; svShow(); return; }
    svClose();
  }
  function svPrev() {
    if (!sv) return;
    if (sv.si > 0) { sv.si--; svShow(); return; }
    if (sv.gi > 0) { sv.gi--; sv.si = sv.groups[sv.gi].items.length - 1; svShow(); return; }
    svShow();   // first story: start it again
  }
  function svClose() { if (screens.indexOf("v-sview") >= 0) closeScreen("v-sview"); storiesChanged(); }
  $("sv-next").onclick = function () { svNext(); };
  $("sv-prev").onclick = function () { svPrev(); };
  $("sv-close").onclick = function () { svClose(); };
  // hold to pause, swipe down to close (touch)
  (function () {
    var y0 = null, x0 = null, t0 = 0, stage = $("v-sview");
    stage.addEventListener("touchstart", function (e) { var t = e.touches && e.touches[0]; if (!t) return; y0 = t.clientY; x0 = t.clientX; t0 = Date.now(); svPause(true); }, { passive: true });
    stage.addEventListener("touchend", function (e) {
      var t = e.changedTouches && e.changedTouches[0], dy = t && y0 != null ? t.clientY - y0 : 0, dx = t && x0 != null ? t.clientX - x0 : 0;
      y0 = null;
      if (dy > 80 && Math.abs(dy) > Math.abs(dx)) { if (e.preventDefault) e.preventDefault(); svClose(); return; }
      svPause(false);
    });
    stage.addEventListener("touchcancel", function () { y0 = null; svPause(false); });
  })();
  function askConfirm(text, cb) {
    try { if (inTg && tg.showConfirm) { tg.showConfirm(text, function (ok) { cb(!!ok); }); return; } } catch (e) {}
    try { if (typeof window.confirm === "function") { cb(!!window.confirm(text)); return; } } catch (e) {}
    cb(true);
  }
  $("sv-del").onclick = function () {
    var s = svCur(); if (!s) return;
    svPause(true);
    askConfirm("Delete this story?", function (yes) {
      if (!yes) { svPause(false); return; }
      chatApi("/api/stories", { body: { action: "delete", id: s.id } }).then(function (d) {
        if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
        if (!d.ok && d._status !== 404) { svPause(false); $("sv-gone").textContent = d.message || "Couldn't delete the story."; $("sv-gone").classList.remove("hide"); return; }
        stories.list = stories.list.filter(function (x) { return x.id !== s.id; });
        delete storyImgs[s.id];
        try { localStorage.setItem(STKEY, JSON.stringify({ o: cacheOwner(), me: stories.me, d: stories.list })); } catch (e) {}
        if (!sv) { storiesChanged(); return; }
        var g = sv.groups[sv.gi];
        g.items = g.items.filter(function (x) { return x.id !== s.id; });
        if (!g.items.length) { sv.groups.splice(sv.gi, 1); sv.si = 0; if (sv.gi >= sv.groups.length) { svClose(); return; } }
        else if (sv.si >= g.items.length) sv.si = g.items.length - 1;
        svShow(); storiesChanged();
      }).catch(function () { svPause(false); });
    });
  };
  document.addEventListener("keydown", function (e) {
    if (screens[screens.length - 1] !== "v-sview") return;
    if (e.key === "ArrowRight") svNext(); else if (e.key === "ArrowLeft") svPrev(); else if (e.key === "Escape") svClose();
  });
  window.gcTest = window.gcTest || {};
  window.gcTest.storyJpeg = storyJpeg; window.gcTest.timeAgo = timeAgo; window.gcTest.openStoryPost = openStoryPost;   // tests / debugging
  window.gcTest.storiesStale = function () { stories.at = 0; };

  function logout() {
    clearMsgCache(""); setSession(null); setChat(null); mineLoaded = false; lastSum = null; unread = { at: "", n: 0 };
    myProf = null; stories.list = []; stories.me = ""; stories.at = 0; profMem = {}; avReg = {}; pfMsg("");
    lsKeys().forEach(function (k) { if (k === MYKEY || k === STKEY || k === SEENSTKEY || k.indexOf(PPFX) === 0) { try { localStorage.removeItem(k); } catch (e) {} } });
    if (!inTg) { setBal(null); stars.me = null; stars.hist = null; }
    closeAllScreens(); renderAccount(); showPromote(); refreshTab();
  }
  function refreshTab() {
    if (current === "msg" && !screens.length) renderMsgTab();
    else if (current === "profile") renderProfile();
  }

  function tab(name) {
    if (name === "promote") { promote(); return; }
    if (name === "mine") name = "profile";
    if (["groups", "msg", "profile"].indexOf(name) < 0) name = "groups";
    closeSheet(); closeAllScreens();
    current = name;
    document.body.classList.toggle("onprof", name === "profile");
    ["groups", "msg", "profile"].forEach(function (t) { $("v-" + t).classList.toggle("hide", t !== name); });
    Array.prototype.forEach.call(document.querySelectorAll(".nav button"), function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === name); });
    searchBar();
    if (name === "msg") renderMsgTab();
    if (name === "profile") renderProfile();
    window.scrollTo(0, 0);
  }
  // search bar: shown on Groups + Messages (a chat / sheet opens above it), placeholder + text follow the tab
  function searchBar() {
    var on = current === "groups" || current === "msg", q = $("q");
    $("tsearch").classList.toggle("hide", !on);
    if (!on) return;
    var ph = current === "msg" ? "Search Chats" : "Search Groups";
    q.placeholder = ph; q.setAttribute("aria-label", ph);
    q.value = sq[current];
    $("q-x").classList.toggle("hide", !q.value);
  }
  function searchInput() {
    if (current !== "groups" && current !== "msg") return;
    sq[current] = $("q").value;
    $("q-x").classList.toggle("hide", !sq[current]);
    if (current === "msg") { filterChats(); renderDays(); } else render();
  }
  Array.prototype.forEach.call(document.querySelectorAll(".nav button"), function (b) { b.onclick = function () { tab(b.getAttribute("data-tab")); }; });
  $("q").addEventListener("input", searchInput);
  $("q").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); try { $("q").blur(); } catch (x) {} }
    else if (e.key === "Escape" && $("q").value) { e.preventDefault(); $("q").value = ""; searchInput(); }
  });
  $("q-x").onclick = function () { $("q").value = ""; searchInput(); try { $("q").focus(); } catch (e) {} };
  $("promo-add").onclick = function () { promote(); };
  // floating button + header Stars pill (the old header ⋮ only opened Profile, which is in the bottom bar)
  $("fab-add").onclick = function () { promote(); };
  $("hd-stars").onclick = function () { openStars(); };
  $("pf-stars").onclick = function () { openStars(); };
  $("pr-bal").onclick = function () { openStars({ fromPromote: true }); };
  $("pr-bal-top").onclick = function () { openStars({ fromPromote: true }); };
  $("pr-topup").onclick = function () { openStars({ fromPromote: true, need: lowNeed || 1 }); };
  $("st-close").onclick = closeStars;
  $("v-stars").addEventListener("click", function (e) { if (e.target === $("v-stars")) closeStars(); });
  $("st-terms-ok").onclick = function () { stOnly("st-body"); topup(stars.termsPack, true); };
  $("st-terms-no").onclick = function () { stOnly("st-body"); stMsg("You need to agree to the terms before buying Stars.", ""); };
  $("st-refresh").onclick = recheckCredit;
  $("st-help").onclick = function () { open(botLink("paysupport")); };
  $("st-terms-l").onclick = function () { open(botLink("terms")); };
  $("st-help-b").onclick = function () { open(botLink("paysupport")); };
  $("st-terms-lb").onclick = function () { open(botLink("terms")); };
  $("st-back").onclick = stBack;
  $("st-a-send").onclick = function () { sdReset(""); stOnly("st-send"); };
  $("st-a-recv").onclick = function () { stOnly("st-recv"); rcMsg("", ""); renderRecv(); };
  $("st-a-buy").onclick = function () { stars.need = 0; stars.pick = 0; stMsg("", ""); stOnly("st-body"); renderPacks(); };
  $("sd-to").addEventListener("input", function () { sdLookup(false); });
  $("sd-to").addEventListener("change", function () { sdLookup(true); });
  $("sd-to").addEventListener("keydown", function (e) { if (e && e.key === "Enter") { sdLookup(true); try { $("sd-amt").focus(); } catch (x) {} } });
  $("sd-amt").addEventListener("input", function () {
    var t = $("sd-amt"), v = String(t.value || "").replace(/\D+/g, "").replace(/^0+(?=\d)/, "").slice(0, 6);
    if (v !== t.value) t.value = v;
    sd.key = ""; sdChips(); sdCheck();
  });
  Array.prototype.forEach.call($("sd-chips").children, function (b) { b.onclick = function () { $("sd-amt").value = b.getAttribute("data-amt"); sd.key = ""; sdChips(); sdCheck(); }; });
  $("sd-note").addEventListener("input", function () { var n = Array.from(String($("sd-note").value || "")).length; $("sd-ncount").textContent = String(Math.max(0, 100 - n)); sd.key = ""; });
  $("sd-go").onclick = sdConfirm;
  $("sd-conf-no").onclick = function () { sdConfShow(false); };
  $("sd-conf-ok").onclick = sdSend;
  $("sd-topup").onclick = function () { var need = Math.max(1, sdAmount() - (stars.bal || 0)); stars.need = need; stars.pick = packFor(need); stMsg("", ""); stOnly("st-body"); renderPacks(); };
  $("sdd-ok").onclick = function () { stOnly("st-main"); loadHist(); };
  $("rc-id-c").onclick = function () { copyText(myWalletId(), "ID"); };
  $("rc-user-c").onclick = function () { var u = myWalletUser(); if (u) copyText("@" + u, "Username"); };
  $("rc-share-c").onclick = function () { copyText(recvText(), "Share text"); };
  $("rc-share").onclick = recvShare;
  document.addEventListener("visibilitychange", function () { if (!document.hidden && stars.waitFor && starsOpen()) recheckCredit(); });
  $("pr-close").onclick = closeSheet;
  $("v-promote").addEventListener("click", function (e) { if (e.target === $("v-promote")) closeSheet(); });
  $("pk-normal").onclick = function () { setPkg("normal"); };
  $("pk-top").onclick = function () { setPkg("top"); };
  $("pr-buy").onclick = function () { buy(false); };
  $("pr-terms-ok").onclick = function () { buy(true); };
  $("pr-terms-no").onclick = function () { showOnly("pr-form"); msg("You need to agree to the terms before paying.", ""); };
  $("logout").onclick = logout;

  chips(); catPicker(); prices(); renderAccount(); netUpdate(); searchBar();
  applyPubInfo();   // cached custom name / photo of the public chat on the Messages row
  var sp = (inTg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || (new URLSearchParams(location.search).get("tab") || "");
  if (sp === "promote") promote(); else if (sp === "mine" || sp === "profile" || sp === "msg") tab(sp);
  var sendTo = (/^send_(\d{1,20})$/.exec(sp) || [])[1] || (/^\d{1,20}$/.test(new URLSearchParams(location.search).get("send") || "") ? new URLSearchParams(location.search).get("send") : "");
  if (sendTo) openStars({ send: sendTo });   // "Send me Stars" link → Send screen with them filled in
  if (loggedIn()) loadBalance();   // header Stars pill
  if (inTg) tgChatLogin().then(function () { renderAccount(); refreshTab(); if (current !== "msg") loadSummary(true); });
  else if (chatReady() && current !== "msg") loadSummary(true);   // unread badge on the bottom-nav Messages
  load();
})();
