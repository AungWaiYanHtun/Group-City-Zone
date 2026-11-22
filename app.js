// Group City website. Inside Telegram (opened as the Mini App) it logs in with Telegram initData and pays with
// Telegram.WebApp.openInvoice. In a normal browser it uses the Telegram Login Widget and hands payment to the bot.
// All text from the server is put on the page with textContent (never innerHTML).
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
  var SKEY = "gc_session";

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
  function chips() {
    var cats = [];
    data.featured.concat(data.groups).forEach(function (g) { if (g.cat && cats.indexOf(g.cat) < 0) cats.push(g.cat); });
    var box = $("chips"); box.textContent = "";
    if (!cats.length) { box.classList.add("hide"); return; }
    box.classList.remove("hide");
    ["All"].concat(cats).forEach(function (c) {
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
    var s = inTg ? null : getSession();
    var box = $("acct-groups"); box.textContent = "";
    if (inTg) { box.classList.add("hide"); }
    else if (s) {
      var u = s.user || {};
      var av = el("span", "av-s", letter(u.first_name || u.username || "U")); av.style.background = color(String(u.id || ""));
      box.appendChild(av); box.appendChild(el("span", "nm", userLabel(u)));
      box.classList.remove("hide");
    } else {
      var b = el("button", "pill", "Log in"); b.type = "button"; b.onclick = function () { tab("promote"); };
      box.appendChild(b); box.classList.remove("hide");
    }
    $("userbar").classList.toggle("hide", inTg || !s);
    if (s) $("userbar-name").textContent = "Logged in as " + userLabel(s.user);
  }

  // ---------- Telegram Login Widget (browser only) ----------
  var widgetMounted = {};
  window.gcOnTelegramAuth = function (user) {
    loginMsg("Checking your Telegram login…", "");
    api("/web/api/login", { body: user || {} }).then(function (d) {
      if (!d.ok || !d.token) { loginMsg(d.message || "Telegram login could not be checked. Please try again.", "err"); return; }
      setSession({ token: d.token, exp: d.exp, user: d.user || { id: user && user.id } });
      loginMsg("", ""); mineLoaded = false; renderAccount(); showPromote();
      if (current === "mine") loadMine();
    }).catch(function () { loginMsg("Couldn't connect. Check your connection.", "err"); });
  };
  function loginMsg(text, kind) { var m = $("login-msg"); m.className = "msg" + (kind ? " " + kind : ""); m.textContent = text; if (!text) m.classList.add("hide"); }
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
  function loginPanel(container) {   // login prompt for My groups
    var e = el("div", "panel");
    e.appendChild(el("h3", null, "Log in to see your groups"));
    e.appendChild(el("p", "hint", "Log in with your Telegram account to see the groups you promoted."));
    var box = el("div", "login-box"); box.id = "login-mine"; e.appendChild(box);
    container.appendChild(e);
    widgetMounted["login-mine"] = false;
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
  function msg(text, kind) { var m = $("pr-msg"); m.className = "msg" + (kind ? " " + kind : ""); m.textContent = text; if (!text) m.classList.add("hide"); }
  function showOnly(id) { ["pr-form", "pr-terms", "pr-pay"].forEach(function (x) { $(x).classList.toggle("hide", x !== id); }); window.scrollTo(0, 0); }
  function promote(prefill) {
    if (prefill && prefill.url) { $("pr-url").value = prefill.url; $("pr-title").value = prefill.title && prefill.title.charAt(0) !== "@" ? prefill.title : ""; }
    if (inTg || getSession()) showOnly("pr-form");
    tab("promote");
  }
  function buy(agree) {
    if (busy) return;
    var url = $("pr-url").value.trim();
    if (!/^(https?:\/\/)?(t\.me|telegram\.me)\/\S+$/i.test(url) && !/^@[A-Za-z0-9_]{4,}$/.test(url)) { msg("Enter your Telegram group link, like https://t.me/yourgroup", "err"); $("pr-url").focus(); return; }
    var body = { title: $("pr-title").value.trim(), url: url, pkg: pkg, agree: agree === true };
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
        $("pr-url").value = ""; $("pr-title").value = ""; mineLoaded = false;
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
    $("pay-pkg").textContent = (top ? "⭐ TOP — shown at the top" : "👥 Normal — listed in All Groups") + " · " + (Number(d.price) || "") + " ⭐ · " + (Number(d.days) || data.days) + " days";
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

  // ---------- tabs ----------
  function tab(name) {
    current = name;
    ["groups", "promote", "mine"].forEach(function (t) { $("v-" + t).classList.toggle("hide", t !== name); });
    Array.prototype.forEach.call(document.querySelectorAll(".nav button"), function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === name); });
    if (name === "promote") showPromote();
    if (name === "mine" && !mineLoaded) loadMine();
    window.scrollTo(0, 0);
  }
  Array.prototype.forEach.call(document.querySelectorAll(".nav button"), function (b) { b.onclick = function () { tab(b.getAttribute("data-tab")); }; });
  $("q").addEventListener("input", render);
  $("promo-add").onclick = function () { promote(); };
  $("pk-normal").onclick = function () { setPkg("normal"); };
  $("pk-top").onclick = function () { setPkg("top"); };
  $("pr-buy").onclick = function () { buy(false); };
  $("pr-terms-ok").onclick = function () { buy(true); };
  $("pr-terms-no").onclick = function () { showOnly("pr-form"); msg("You need to agree to the terms before paying.", ""); };
  $("pay-done").onclick = function () { mineLoaded = false; $("pr-url").value = ""; $("pr-title").value = ""; showOnly("pr-form"); tab("mine"); };
  $("pay-new").onclick = function () { $("pr-url").value = ""; $("pr-title").value = ""; showOnly("pr-form"); };
  $("logout").onclick = function () { setSession(null); mineLoaded = false; renderAccount(); showPromote(); };
  if (!inTg) $("pr-note").textContent = "One payment lists one group. You pay with Telegram Stars in the bot.";

  prices(); renderAccount();
  var sp = (inTg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || (new URLSearchParams(location.search).get("tab") || "");
  if (sp === "promote" || sp === "mine") tab(sp);
  load();
})();
