// Group City website. Inside Telegram (opened as the Mini App) it logs in with Telegram initData and pays with
// Telegram.WebApp.openInvoice. In a normal browser it uses the Telegram Login Widget and hands payment to the bot.
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
    try { tg.ready(); tg.expand(); if (tg.setHeaderColor) tg.setHeaderColor("bg_color"); } catch (e) {}
  }
  // light / dark look: Telegram's colorScheme inside Telegram, the device setting in a browser (style only)
  (function () {
    var root = document.documentElement, mq = null;
    try { mq = !inTg && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null; } catch (e) {}
    function apply() { root.classList.toggle("dark", inTg ? tg.colorScheme === "dark" : !!(mq && mq.matches)); }
    apply();
    try {
      if (inTg && tg.onEvent) tg.onEvent("themeChanged", apply);
      else if (mq && mq.addEventListener) mq.addEventListener("change", apply);
    } catch (e) {}
  })();

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
    if (m.u) x.u = m.u; if (m.mine) x.m = 1; if (m.name) x.n = m.name; if (m.admin) x.d = 1; if (m.photo) x.p = m.photo;
    return x;
  }
  function unpackMsg(x) { return { id: Number(x.i), text: x.t || "", at: x.a || "", u: x.u || "", mine: !!x.m, name: x.n || "", admin: !!x.d, photo: x.p || "" }; }
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
    var src = safeUrl(photo);
    if (src) {
      var img = document.createElement("img");
      img.alt = ""; img.referrerPolicy = "no-referrer"; img.loading = "lazy";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:50%";
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); a.textContent = letter(name); };
      img.onload = function () { a.textContent = ""; a.appendChild(img); };
      img.src = src;
    }
    return a;
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
    if (inTg) { box.classList.add("hide"); }
    else if (u) {
      box.appendChild(avatar(u.photo_url, u.first_name || u.username || "U", String(u.id || ""), "av-s")); box.appendChild(el("span", "nm", userLabel(u)));
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
    var showing = !$("pr-terms").classList.contains("hide") || !$("pr-pay").classList.contains("hide");
    $("pr-login").classList.toggle("hide", logged);
    if (!logged) { $("pr-form").classList.add("hide"); $("pr-terms").classList.add("hide"); $("pr-pay").classList.add("hide"); mountLogin($("login-promote")); return; }
    if (!showing) $("pr-form").classList.remove("hide");
  }
  function setPkg(p) {
    pkg = p === "normal" ? "normal" : "top";
    $("pk-normal").classList.toggle("on", pkg === "normal"); $("pk-top").classList.toggle("on", pkg === "top");
    $("pr-buy").textContent = "Buy · " + (pkg === "top" ? data.topPrice : data.price) + " ⭐";
  }
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
  function showOnly(id) { ["pr-form", "pr-terms", "pr-pay"].forEach(function (x) { $(x).classList.toggle("hide", x !== id); }); $("sheet").scrollTop = 0; }
  function openSheet() { $("v-promote").classList.remove("hide"); document.body.classList.add("lock"); showPromote(); }
  function closeSheet() { $("v-promote").classList.add("hide"); document.body.classList.remove("lock"); }
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
    var body = { title: $("pr-title").value.trim(), url: url, pkg: pkg, agree: agree === true };
    if (prCat) body.cat = prCat;
    var req;
    if (inTg) { body.initData = tg.initData; req = api("/app/api/invoice", { body: body }); }
    else if (getSession()) req = api("/web/api/promote", { body: body, auth: true });
    else { showPromote(); return; }
    busy = true; $("pr-buy").disabled = true; $("pr-terms-ok").disabled = true; msg("Preparing payment…", "");
    req.then(function (d) {
      busy = false; $("pr-buy").disabled = false; $("pr-terms-ok").disabled = false;
      if (d._status === 401) {
        if (inTg) { showOnly("pr-form"); msg("Your Telegram session expired. Close and open Group City again.", "err"); return; }
        setSession(null); renderAccount(); showPromote(); loginMsg("Please log in with Telegram again.", "err"); return;
      }
      if (d.error === "terms") { $("pr-terms-text").textContent = String(d.terms || ""); showOnly("pr-terms"); return; }
      if (inTg && d.ok && isTgUrl(d.link)) { showOnly("pr-form"); msg("", ""); payInTelegram(d.link); return; }
      if (!inTg && d.ok && isTgUrl(d.pay)) { showOrder(d, body); return; }
      showOnly("pr-form"); msg(d.message || "Something went wrong. Please try again.", "err");
    }).catch(function () { busy = false; $("pr-buy").disabled = false; $("pr-terms-ok").disabled = false; showOnly("pr-form"); msg("Couldn't connect. Check your connection.", "err"); });
  }
  function payInTelegram(link) {
    var done = function (status) {
      if (status === "paid") {
        msg("✅ Paid! Your group is listed" + (pkg === "top" ? " in ⭐ Featured." : " in All Groups.") + " It can take a few seconds to appear.", "okm");
        resetForm(); mineLoaded = false;
        setTimeout(load, 1500); setTimeout(load, 5000);
      } else if (status === "cancelled") msg("Payment cancelled.", "");
      else if (status === "failed") msg("Payment failed. Please try again.", "err");
      else if (status === "pending") msg("Payment is being processed…", "");
    };
    try { if (tg.openInvoice) { tg.openInvoice(link, done); return; } } catch (e) {}
    open(link);
  }
  function showOrder(d, body) {
    var top = d.pkg === "top";
    $("pay-title").textContent = body.title || body.url.replace(/^https?:\/\//i, "");
    $("pay-url").textContent = body.url;
    $("pay-pkg").textContent = (body.cat ? body.cat + " · " : "") + (top ? "⭐ TOP — shown at the top" : "👥 Normal — listed in All Groups") + " · " + (Number(d.price) || "") + " ⭐ · " + (Number(d.days) || data.days) + " days";
    $("pay-link").setAttribute("href", d.pay);
    $("pay-bot").textContent = botName();
    msg("", ""); showOnly("pr-pay");
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
      box.appendChild(el("div", "note", "Each payment lists one group for " + (Number(d.days) || data.days) + " days. When it ends, promote it again."));
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

  // ---------- Messages list ----------
  function preview(m, who) { return m ? (m.mine ? "You: " : (who ? who + ": " : "")) + String(m.text || "").replace(/\s+/g, " ") : ""; }
  function renderMsgTab() {
    var ok = needChat($("msg-login"), "Log in to chat", "Log in with your Telegram account to message support and chat with everyone.", "login-msgtab");
    $("chats").classList.toggle("hide", !ok);
    $("chats-msg").classList.add("hide");
    if (!ok) { $("msg-none").classList.add("hide"); return; }
    var admin = !!getChat().isAdmin;
    $("sup-prev").textContent = admin ? "Support inbox" : "Message the Group City team";
    muteIcons(); filterChats();
    loadSummary(false);
  }
  // Messages search: filter the chat rows by name / last message (live, as you type)
  var CHAT_ROWS = [{ row: "row-support", name: "Support", prev: "sup-prev" }, { row: "row-public", name: "Group City Chat", prev: "pub-prev" }];
  function filterChats() {
    var q = sq.msg.trim().toLowerCase(), shown = 0;
    CHAT_ROWS.forEach(function (r) {
      var hit = !q || (r.name + "\n" + $(r.prev).textContent).toLowerCase().indexOf(q) >= 0;
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
  setInterval(function () { if (!document.hidden && chatReady() && screens[screens.length - 1] !== "v-chat") loadSummary(true); }, 20000);

  // ---------- screens (support inbox, chat) ----------
  var screens = [];   // open screen ids, top last
  function syncBack() {
    document.body.classList.toggle("lock", screens.length > 0 || !$("v-promote").classList.contains("hide"));
    if (!inTg || !tg.BackButton) return;
    try { if (screens.length) tg.BackButton.show(); else tg.BackButton.hide(); } catch (e) {}
  }
  function openScreen(id) { $(id).classList.remove("hide"); if (screens.indexOf(id) < 0) screens.push(id); syncBack(); }
  function closeScreen(id) {
    $(id).classList.add("hide"); screens = screens.filter(function (x) { return x !== id; });
    if (id === "v-chat") { stopPoll(); closePop(); closeSearch(true); }
    if (id === "v-threads") stopThreadPoll();
    if (id === "v-info") { closeInfoPop(); info = null; }
    syncBack();
  }
  function goBack() {
    var top = screens[screens.length - 1]; if (!top) return;
    if (top === "v-chat" && popOpen()) { closePop(); return; }
    if (top === "v-chat" && srch.on) { closeSearch(); return; }
    if (top === "v-info" && infoPopOpen()) { closeInfoPop(); return; }
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
        row.appendChild(avatar(t.photo, t.name, t.u, "av cav"));
        var info = el("span", "cinfo"), top = el("span", "ctop"), bot = el("span", "cbot");
        var nm = el("span", "cname", t.name + (t.username ? "  @" + t.username : ""));
        var nmw = el("span", "cnm"); nmw.appendChild(nm);
        if (isMuted("support", String(t.uid))) { var mi = el("span", "mutei"); mi.setAttribute("aria-label", "Muted"); nmw.appendChild(mi); }
        top.appendChild(nmw); top.appendChild(el("span", "ctime", t.last ? listTime(t.last.at) : ""));
        bot.appendChild(el("span", "cprev", t.last ? preview(t.last, t.last.admin ? "Support" : "") : ""));
        var tm = isMuted("support", String(t.uid));
        if (t.waiting) { bot.appendChild(el("span", "cbadge dot " + (tm ? "muted" : "unm"))); if (!tm) top.lastChild.classList.add("unread"); }
        info.appendChild(top); info.appendChild(bot); row.appendChild(info);
        row.onclick = function () { openChat({ room: "support", uid: String(t.uid), title: t.name, username: t.username || "", sub: (t.username ? "@" + t.username + " · " : "") + "ID " + t.uid, photo: t.photo, seed: t.u }); };
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
      info: { title: o.title || "", username: o.username || "", photo: o.photo || "", seed: o.seed || "" } };
    var hav = $("ch-av"), nav;
    if (o.room === "public") { nav = el("span", "av cav", "💬"); nav.style.background = "#3d8bd9"; $("ch-title").textContent = "Group City Chat"; $("ch-sub").textContent = "Everyone on Group City"; }
    else if (o.uid) { nav = avatar(o.photo, o.title, o.seed, "av cav"); $("ch-title").textContent = o.title || "User"; $("ch-sub").textContent = o.sub || "Support thread"; }
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
        else av = avatar(m.photo, m.name, m.u, "mav");
        if (!lastOfRun) av.classList.add("sp");
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
    var u = anyUser() || {}, pm = { id: "p" + (++pendSeq), pend: true, text: text, at: new Date().toISOString(), u: "me", mine: true, name: u.first_name || "" };
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
  function infoPopOpen() { return !$("ci-pop").classList.contains("hide"); }
  function closeInfoPop() {
    $("ci-pop").classList.add("hide"); $("ci-popbg").classList.add("hide");
    $("ci-more").classList.remove("on"); $("ci-more").setAttribute("aria-expanded", "false");
  }
  function openInfoPop() {
    infoMuteUi();
    $("ci-pop").classList.remove("hide"); $("ci-popbg").classList.remove("hide");
    $("ci-more").classList.add("on"); $("ci-more").setAttribute("aria-expanded", "true");
  }
  function infoMuteUi() {
    var m = !!ch && isMuted(ch.room, ch.uid);
    $("ci-mute").classList.toggle("muted", m); $("ci-mute-l").textContent = m ? "Unmute" : "Mute";
    $("ci-mute").setAttribute("aria-pressed", m ? "true" : "false");
    $("ci-pmute").classList.toggle("muted", m); $("ci-pmute-l").textContent = m ? "Unmute" : "Mute";
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
    if (o.kind === "group") { a = el("span", "av iav", "💬"); a.style.background = "#3d8bd9"; }
    else if (o.kind === "support") { a = el("span", "av iav", "🆘"); a.style.background = "#e5534b"; }
    else a = avatar(ch.info.photo, ch.info.title, ch.info.seed, "av iav");
    a.id = "ci-av";
    var old = $("ci-av"); old.parentNode.replaceChild(a, old);
  }
  function openInfo() {
    if (!ch || srch.on || screens[screens.length - 1] !== "v-chat") return;
    closePop(); emoShow(false);
    var kind = ch.room === "public" ? "group" : (ch.uid ? "user" : "support");
    info = { kind: kind, tab: "m", ch: ch };
    infoAvatar(info);
    $("ci-name").textContent = kind === "group" ? "Group City Chat" : kind === "support" ? "Group City Support" : (ch.info.title || "User");
    $("ci-sub").textContent = kind === "group" ? (memFresh(true) ? countLine(memCache.d) : "Everyone on Group City") : kind === "support" ? "Support" : "last seen recently";
    $("ci-sub").classList.remove("on");
    $("ci-tabs").classList.toggle("hide", kind !== "group");
    $("ci-members").classList.toggle("hide", kind !== "group");
    $("ci-links").classList.add("hide");
    $("ci-about").classList.toggle("hide", kind !== "user");
    infoTab("m", true);
    infoMuteUi(); closeInfoPop();
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
      row.appendChild(avatar(m.photo, m.name, m.u, "av imav"));
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
  function infoSearch() { closeInfoPop(); if (screens[screens.length - 1] === "v-info") goBack(); if (screens[screens.length - 1] === "v-chat") openSearch(); }
  $("ci-find").onclick = infoSearch;
  $("ci-more").onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); if (infoPopOpen()) closeInfoPop(); else openInfoPop(); };
  $("ci-popbg").onclick = closeInfoPop;
  $("ci-pmute").onclick = function () { toggleMute(); closeInfoPop(); };
  $("ci-pfind").onclick = infoSearch;
  $("ci-tab-m").onclick = function () { infoTab("m"); };
  $("ci-tab-l").onclick = function () { infoTab("l"); };

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
    if (e.key === "Escape" && screens[screens.length - 1] === "v-info") { goBack(); return; }
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

  // ---------- Profile ----------
  function renderProfile() {
    var logged = inTg || getSession() || getChat();
    $("pf-login").classList.toggle("hide", !!logged);
    $("pf-body").classList.toggle("hide", !logged);
    if (!logged) { $("pf-login").textContent = ""; loginPanel($("pf-login"), { id: "login-pf", title: "Log in", hint: "Log in with your Telegram account to see your profile, your promoted groups, and to chat." }); return; }
    var u = anyUser() || {}, c = getChat();
    var name = [u.first_name, u.last_name].filter(Boolean).join(" ") || (u.username ? "@" + u.username : "Telegram user");
    var old = $("pf-av"), av = avatar(u.photo_url, name, String(u.id || ""), "av pav"); av.id = "pf-av"; old.parentNode.replaceChild(av, old);
    $("pf-name").textContent = name;
    $("pf-user").textContent = u.username ? "@" + u.username : "";
    $("pf-admin").classList.toggle("hide", !(c && c.isAdmin));
    var cl = $("pf-chatlogin"); cl.textContent = ""; cl.classList.add("hide");
    if (!inTg && !c) { cl.classList.remove("hide"); loginPanel(cl, { id: "login-pfchat", title: "Turn on chat", hint: "Log in with Telegram once more to use Messages and Support." }); }
    $("pf-logout").classList.toggle("hide", inTg);
    if (!mineLoaded) loadMine();
  }
  function logout() {
    clearMsgCache(""); setSession(null); setChat(null); mineLoaded = false; lastSum = null; unread = { at: "", n: 0 };
    closeAllScreens(); renderAccount(); showPromote(); refreshTab();
  }
  $("pf-logout").onclick = logout;
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
    if (current === "msg") filterChats(); else render();
  }
  Array.prototype.forEach.call(document.querySelectorAll(".nav button"), function (b) { b.onclick = function () { tab(b.getAttribute("data-tab")); }; });
  $("q").addEventListener("input", searchInput);
  $("q").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); try { $("q").blur(); } catch (x) {} }
    else if (e.key === "Escape" && $("q").value) { e.preventDefault(); $("q").value = ""; searchInput(); }
  });
  $("q-x").onclick = function () { $("q").value = ""; searchInput(); try { $("q").focus(); } catch (e) {} };
  $("promo-add").onclick = function () { promote(); };
  // Telegram-style header ⋮ + floating button (UI shortcuts to existing actions); search lives in the bar under the header
  $("fab-add").onclick = function () { promote(); };
  $("hd-menu").onclick = function () { tab("profile"); };
  $("pr-close").onclick = closeSheet;
  $("v-promote").addEventListener("click", function (e) { if (e.target === $("v-promote")) closeSheet(); });
  $("pk-normal").onclick = function () { setPkg("normal"); };
  $("pk-top").onclick = function () { setPkg("top"); };
  $("pr-buy").onclick = function () { buy(false); };
  $("pr-terms-ok").onclick = function () { buy(true); };
  $("pr-terms-no").onclick = function () { showOnly("pr-form"); msg("You need to agree to the terms before paying.", ""); };
  $("pay-done").onclick = function () { mineLoaded = false; resetForm(); showOnly("pr-form"); tab("profile"); };
  $("pay-new").onclick = function () { resetForm(); showOnly("pr-form"); };
  $("logout").onclick = logout;
  if (!inTg) $("pr-note").textContent = "One payment lists one group. You pay with Telegram Stars in the bot.";

  chips(); catPicker(); prices(); renderAccount(); netUpdate(); searchBar();
  var sp = (inTg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || (new URLSearchParams(location.search).get("tab") || "");
  if (sp === "promote") promote(); else if (sp === "mine" || sp === "profile" || sp === "msg") tab(sp);
  if (inTg) tgChatLogin().then(function () { renderAccount(); refreshTab(); if (current !== "msg") loadSummary(true); });
  else if (chatReady() && current !== "msg") loadSummary(true);   // unread badge on the bottom-nav Messages
  load();
})();
