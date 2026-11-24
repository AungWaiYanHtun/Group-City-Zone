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
    try { tg.ready(); tg.expand(); if (tg.setHeaderColor) tg.setHeaderColor("secondary_bg_color"); } catch (e) {}
  }

  var data = { featured: [], groups: [], bot: BOT, short: "", price: 10, topPrice: 50, days: 30 };
  var cat = "All", pkg = "top", busy = false, mineLoaded = false, current = "groups";
  // Group categories: the one list is CATEGORIES in config.js (the worker keeps the same allow-list).
  var CATS = (Array.isArray(CFG.CATEGORIES) ? CFG.CATEGORIES : []).map(function (c) { return String(c || "").trim(); })
    .filter(function (c, i, a) { return c && c !== "All" && a.indexOf(c) === i; });
  var prCat = "";                               // category picked in the Promote form ("" = not chosen yet)
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
  function chatApi(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" }, c = getChat();
    if (c && !opts.noAuth) headers.Authorization = "Bearer " + c.token;
    return fetch(path, { method: opts.body ? "POST" : "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (d) { d = d || {}; d._status = r.status; return d; }); });
  }
  function saveChatLogin(d) {
    if (!d || !d.ok || typeof d.token !== "string") return false;
    setChat({ token: d.token, exp: d.exp, user: d.user || {}, isAdmin: !!d.isAdmin });
    return true;
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
    return fetch(API + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers: opts.body || opts.auth ? headers : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: "omit", mode: "cors" })
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
    var q = $("q").value.trim().toLowerCase();
    return (cat === "All" || g.cat === cat) && (!q || String(g.title || "").toLowerCase().indexOf(q) >= 0);
  }
  function render() {
    var list = $("list"); list.textContent = "";
    var f = data.featured.filter(match), a = data.groups.filter(match);
    if (f.length) { list.appendChild(el("div", "sec", "⭐ Featured")); f.forEach(function (g) { list.appendChild(card(g, true)); }); }
    if (a.length) { list.appendChild(el("div", "sec", "All groups")); a.forEach(function (g) { list.appendChild(card(g, false)); }); }
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
      .map(function (g) { return { title: String(g.title || "Telegram Group"), url: String(g.url), members: Number(g.members) || 0, cat: g.cat ? String(g.cat) : "" }; });
  }
  function load() {
    api("/app/api/groups").then(function (d) {
      if (!d.ok) throw new Error("bad");
      data.featured = clean(d.featured); data.groups = clean(d.groups);
      if (d.bot) data.bot = String(d.bot);
      data.short = String(d.short || "");
      data.price = Number(d.price) || data.price; data.topPrice = Number(d.topPrice) || data.topPrice; data.days = Number(d.days) || data.days;
      prices(); $("promo").classList.remove("hide");
      chips(); render();
    }).catch(function () {
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
    if (!ok) return;
    var admin = !!getChat().isAdmin;
    $("sup-prev").textContent = admin ? "Support inbox" : "Message the Group City team";
    chatApi("/api/chat?view=summary").then(function (d) {
      if (d._status === 401) { chatExpired(); return; }
      if (!d.ok) { var m = $("chats-msg"); m.className = "msg err"; m.textContent = d.message || "Couldn't load messages."; return; }
      if (getChat() && getChat().isAdmin !== !!d.isAdmin) { var c = getChat(); c.isAdmin = !!d.isAdmin; setChat(c); admin = !!d.isAdmin; }
      var p = d.public, s = d.support;
      $("pub-prev").textContent = p ? preview(p, p.name) : "Chat with everyone";
      $("pub-time").textContent = p ? listTime(p.at) : "";
      $("sup-prev").textContent = s ? preview(s, admin ? s.name : (s.mine ? "" : "Support")) : (admin ? "No support messages yet" : "Message the Group City team");
      $("sup-time").textContent = s ? listTime(s.at) : "";
      var badge = $("sup-badge"), n = Number(d.waiting) || 0;
      badge.classList.toggle("hide", !(admin && n));
      badge.className = "cbadge" + (admin && n ? "" : " hide"); badge.textContent = n ? String(n) : "";
    }).catch(function () { var m = $("chats-msg"); m.className = "msg err"; m.textContent = "Couldn't connect. Check your connection."; });
  }

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
    if (id === "v-chat") stopPoll();
    if (id === "v-threads") stopThreadPoll();
    syncBack();
  }
  function goBack() {
    var top = screens[screens.length - 1]; if (!top) return;
    closeScreen(top);
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
        top.appendChild(nm); top.appendChild(el("span", "ctime", t.last ? listTime(t.last.at) : ""));
        bot.appendChild(el("span", "cprev", t.last ? preview(t.last, t.last.admin ? "Support" : "") : ""));
        if (t.waiting) bot.appendChild(el("span", "cbadge dot"));
        info.appendChild(top); info.appendChild(bot); row.appendChild(info);
        row.onclick = function () { openChat({ room: "support", uid: String(t.uid), title: t.name, sub: (t.username ? "@" + t.username + " · " : "") + "ID " + t.uid, photo: t.photo, seed: t.u }); };
        box.appendChild(row);
      });
    }).catch(function () { thBusy = false; });
  }

  // ---------- chat view ----------
  var ch = null;              // {room, uid, msgs:[], admin}
  var pollTimer = null, pollBusy = false, sending = false, errTimer = null;
  var MAX_SHOWN = 200;
  function chatQuery(after) {
    var q = "/api/chat?room=" + encodeURIComponent(ch.room);
    if (ch.uid) q += "&uid=" + encodeURIComponent(ch.uid);
    if (after) q += "&after=" + encodeURIComponent(after);
    return q;
  }
  function openChat(o) {
    if (!chatReady()) { tab("msg"); return; }
    stopPoll();
    ch = { room: o.room, uid: o.uid || "", msgs: [], admin: !!getChat().isAdmin, loaded: false };
    var hav = $("ch-av"), nav;
    if (o.room === "public") { nav = el("span", "av cav", "💬"); nav.style.background = "#3d8bd9"; $("ch-title").textContent = "Group City Chat"; $("ch-sub").textContent = "Everyone on Group City"; }
    else if (o.uid) { nav = avatar(o.photo, o.title, o.seed, "av cav"); $("ch-title").textContent = o.title || "User"; $("ch-sub").textContent = o.sub || "Support thread"; }
    else { nav = el("span", "av cav", "🆘"); nav.style.background = "#e5534b"; $("ch-title").textContent = "Support"; $("ch-sub").textContent = "Ask the Group City team anything"; }
    nav.id = "ch-av"; hav.parentNode.replaceChild(nav, hav);
    $("ch-text").value = ""; autoGrow(); chatErr("");
    $("ch-text").placeholder = o.room === "support" && o.uid ? "Reply as Support" : "Message";
    var list = $("ch-list"); list.textContent = ""; list.appendChild(el("div", "cempty", "Loading…"));
    openScreen("v-chat");
    fetchMsgs(true);
    startPoll();
  }
  function lastId() { return ch && ch.msgs.length ? ch.msgs[ch.msgs.length - 1].id : 0; }
  function nearBottom() { var l = $("ch-list"); return l.scrollHeight - l.scrollTop - l.clientHeight < 90; }
  function toBottom() { var l = $("ch-list"); l.scrollTop = l.scrollHeight; }
  function fetchMsgs(first) {
    if (!ch || pollBusy) return;
    var my = ch; pollBusy = true;
    var after = first ? 0 : lastId();
    chatApi(chatQuery(after)).then(function (d) {
      pollBusy = false;
      if (ch !== my) return;
      if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
      if (!d.ok) { if (first) { var l = $("ch-list"); l.textContent = ""; l.appendChild(el("div", "cempty", d.message || "Couldn't load messages.")); } return; }
      var changed = false, ids = {};
      ch.msgs.forEach(function (m) { ids[m.id] = true; });
      (Array.isArray(d.messages) ? d.messages : []).forEach(function (m) { if (m && m.id && !ids[m.id]) { ch.msgs.push(m); ids[m.id] = true; changed = true; } });
      if (Array.isArray(d.live)) {
        var live = {}, min = Infinity, max = 0;
        d.live.forEach(function (x) { live[x] = true; if (x < min) min = x; if (x > max) max = x; });
        var before = ch.msgs.length;
        // drop only messages inside the live window that the server no longer has (deleted)
        ch.msgs = ch.msgs.filter(function (m) { return live[m.id] || m.id > max || (d.live.length && m.id < min); });
        if (ch.msgs.length !== before) changed = true;
      }
      ch.msgs.sort(function (a, b) { return a.id - b.id; });
      if (ch.msgs.length > MAX_SHOWN) ch.msgs = ch.msgs.slice(-MAX_SHOWN);
      if (first || changed || !ch.loaded) { var stick = first || nearBottom(); ch.loaded = true; renderMsgs(); if (stick) toBottom(); }
    }).catch(function () { pollBusy = false; if (first && ch === my) { var l = $("ch-list"); l.textContent = ""; l.appendChild(el("div", "cempty", "Couldn't connect. Check your connection.")); } });
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
    var ms = ch.msgs;
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
      var row = el("div", "mrow" + (m.mine ? " me" : ""));
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
      t.appendChild(el("span", "btime", isNaN(d) ? "" : hhmm(d)));
      t.appendChild(document.createTextNode(String(m.text || "")));
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
  function sendMsg() {
    if (!ch || sending) return;
    var text = $("ch-text").value.replace(/\r\n?/g, "\n").trim();
    if (!text) return;
    if (text.length > 1000) { chatErr("Message is too long (max 1000 characters)."); return; }
    var my = ch; sending = true; $("ch-send").disabled = true;
    var body = { action: "send", room: ch.room, text: text }; if (ch.uid) body.uid = ch.uid;
    chatApi("/api/chat", { body: body }).then(function (d) {
      sending = false; $("ch-send").disabled = false;
      if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
      if (!d.ok || !d.message) { chatErr(d.message || "Message was not sent."); return; }
      $("ch-text").value = ""; autoGrow(); chatErr("");
      if (ch !== my) return;
      if (!ch.msgs.some(function (m) { return m.id === d.message.id; })) ch.msgs.push(d.message);
      ch.msgs.sort(function (a, b) { return a.id - b.id; });
      renderMsgs(); toBottom();
      fetchMsgs(false);
    }).catch(function () { sending = false; $("ch-send").disabled = false; chatErr("Couldn't connect. Message was not sent."); });
  }

  // tap a message: copy / delete
  var menuMsg = null;
  function msgMenu(m) {
    if (window.getSelection && String(window.getSelection()).length) return; // user is selecting text
    menuMsg = m;
    $("mm-prev").textContent = String(m.text || "").slice(0, 300);
    $("mm-del").classList.toggle("hide", !(m.mine || (getChat() && getChat().isAdmin)));
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
    var m = menuMsg; closeMenu(); if (!m || !ch) return;
    var my = ch;
    chatApi("/api/chat", { body: { action: "delete", id: m.id } }).then(function (d) {
      if (d._status === 401) { closeAllScreens(); chatExpired(); return; }
      if (!d.ok) { chatErr(d.message || "Couldn't delete the message."); return; }
      if (ch !== my) return;
      ch.msgs = ch.msgs.filter(function (x) { return x.id !== m.id; }); renderMsgs();
    }).catch(function () { chatErr("Couldn't connect."); });
  };
  $("ch-back").onclick = goBack;
  $("th-back").onclick = goBack;
  $("ch-form").addEventListener("submit", function (e) { e.preventDefault(); sendMsg(); $("ch-text").focus(); });
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
    setSession(null); setChat(null); mineLoaded = false;
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
    if (name === "msg") renderMsgTab();
    if (name === "profile") renderProfile();
    window.scrollTo(0, 0);
  }
  Array.prototype.forEach.call(document.querySelectorAll(".nav button"), function (b) { b.onclick = function () { tab(b.getAttribute("data-tab")); }; });
  $("q").addEventListener("input", render);
  $("promo-add").onclick = function () { promote(); };
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

  chips(); catPicker(); prices(); renderAccount();
  var sp = (inTg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || (new URLSearchParams(location.search).get("tab") || "");
  if (sp === "promote") promote(); else if (sp === "mine" || sp === "profile" || sp === "msg") tab(sp);
  if (inTg) tgChatLogin().then(function () { renderAccount(); refreshTab(); });
  load();
})();
