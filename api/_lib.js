// Shared helpers for the Group City chat API (Vercel serverless, Node CommonJS, no npm packages).
// Env: BOT_TOKEN, ADMIN_IDS, SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SECRET.
// Files whose name starts with "_" are not exposed as routes by Vercel.
"use strict";
const crypto = require("node:crypto");

const SESSION_DAYS = 30;
const MAX_AUTH_AGE = 24 * 3600; // seconds

function env(name) { return String(process.env[name] || "").trim(); }

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(obj));
}
function fail(res, status, message) { json(res, status, { ok: false, message: message }); }

// Same-origin only: no CORS headers are ever sent, and a request whose Origin is another site is refused.
function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true; // same-origin GET / non-browser
  const host = String((req.headers["x-forwarded-host"] || req.headers.host || "")).split(",")[0].trim().toLowerCase();
  try { return new URL(origin).host.toLowerCase() === host; } catch (e) { return false; }
}

// Common request guard. Returns false (and answers) when the request must stop here.
function guard(req, res, methods) {
  if (!sameOrigin(req)) { fail(res, 403, "Not allowed."); return false; }
  if (methods.indexOf(req.method) < 0) { res.setHeader("Allow", methods.join(", ")); fail(res, 405, "Method not allowed."); return false; }
  return true;
}

function query(req) {
  if (req.query && typeof req.query === "object") return req.query;
  try { return Object.fromEntries(new URL(req.url, "http://x").searchParams); } catch (e) { return {}; }
}

async function body(req, max) {
  max = max || 20000;
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  let raw = "";
  if (typeof req.body === "string") raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString("utf8");
  else if (typeof req.on === "function") {
    raw = await new Promise((resolve, reject) => {
      let s = "";
      req.on("data", (c) => { s += c; if (s.length > max) { reject(new Error("too big")); } });
      req.on("end", () => resolve(s));
      req.on("error", reject);
    });
  }
  if (!raw) return {};
  try { const o = JSON.parse(raw); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; }
}

function hmac(key, data) { return crypto.createHmac("sha256", key).update(data).digest(); }
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- Telegram verification ----------
function cleanUser(u) {
  if (!u || !/^\d{1,20}$/.test(String(u.id))) return null;
  const s = (v, n) => (v == null ? "" : String(v).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, n));
  const photo = s(u.photo_url, 500);
  return {
    id: String(u.id),
    first_name: s(u.first_name, 64),
    last_name: s(u.last_name, 64),
    username: /^[A-Za-z0-9_]{1,40}$/.test(String(u.username || "")) ? String(u.username) : "",
    photo_url: /^https:\/\/[^\s"'<>]+$/i.test(photo) ? photo : ""
  };
}
function freshAuthDate(v) {
  const t = Number(v), now = Math.floor(Date.now() / 1000);
  return Number.isFinite(t) && t > 0 && now - t <= MAX_AUTH_AGE && t - now < 300;
}

// Mini App initData: secret = HMAC_SHA256(key "WebAppData", BOT_TOKEN)
function verifyInitData(initData, botToken) {
  if (typeof initData !== "string" || !initData || initData.length > 8000 || !botToken) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  const pairs = [];
  for (const [k, v] of p) if (k !== "hash") pairs.push(k + "=" + v);
  pairs.sort();
  const secret = hmac("WebAppData", botToken);
  const calc = hmac(secret, pairs.join("\n")).toString("hex");
  if (!safeEq(calc, hash.toLowerCase())) return null;
  if (!freshAuthDate(p.get("auth_date"))) return null;
  let u = null;
  try { u = JSON.parse(p.get("user") || "null"); } catch (e) { return null; }
  return cleanUser(u);
}

// Login Widget: secret = SHA256(BOT_TOKEN)
function verifyWidget(data, botToken) {
  if (!data || typeof data !== "object" || !botToken) return null;
  const hash = String(data.hash || "");
  if (!/^[0-9a-f]{64}$/i.test(hash)) return null;
  const pairs = [];
  for (const k of Object.keys(data)) {
    if (k === "hash" || data[k] == null || typeof data[k] === "object") continue;
    pairs.push(k + "=" + data[k]);
  }
  pairs.sort();
  const secret = crypto.createHash("sha256").update(botToken).digest();
  const calc = hmac(secret, pairs.join("\n")).toString("hex");
  if (!safeEq(calc, hash.toLowerCase())) return null;
  if (!freshAuthDate(data.auth_date)) return null;
  return cleanUser(data);
}

// ---------- own session token: uid.exp.hmac ----------
function sessionSecret() { const s = env("SESSION_SECRET"); return s.length >= 16 ? s : ""; }
function makeToken(uid) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = hmac(sessionSecret(), "s:" + uid + "." + exp).toString("hex");
  return { token: uid + "." + exp + "." + sig, exp: exp };
}
function readToken(token) {
  const m = /^(\d{1,20})\.(\d{1,12})\.([0-9a-f]{64})$/.exec(String(token || ""));
  if (!m || !sessionSecret()) return null;
  if (Number(m[2]) <= Math.floor(Date.now() / 1000)) return null;
  const sig = hmac(sessionSecret(), "s:" + m[1] + "." + m[2]).toString("hex");
  return safeEq(sig, m[3]) ? m[1] : null;
}
function authUid(req) {
  const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || "");
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? readToken(m[1]) : null;
}

function adminIds() { return env("ADMIN_IDS").split(/[\s,]+/).filter((x) => /^\d{1,20}$/.test(x)); }
function isAdmin(uid) { return uid != null && adminIds().indexOf(String(uid)) >= 0; }

// Stable opaque id for a user (for avatar color / grouping). Never reveals the Telegram ID.
function userHash(uid) { return hmac(sessionSecret() || "gc", "u:" + uid).toString("hex").slice(0, 12); }

function missingEnv() {
  const m = ["BOT_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SESSION_SECRET"].filter((n) => !env(n));
  if (env("SESSION_SECRET") && !sessionSecret()) m.push("SESSION_SECRET (needs 16+ characters)");
  return m;
}
function configured() {
  return !!(env("BOT_TOKEN") && env("SUPABASE_URL") && env("SUPABASE_SERVICE_KEY") && sessionSecret());
}

// ---------- Supabase REST (PostgREST) with the service key ----------
async function sb(path, opts) {
  opts = opts || {};
  const key = env("SUPABASE_SERVICE_KEY");
  const headers = { apikey: key, "Content-Type": "application/json", Accept: "application/json" };
  if (/^eyJ/.test(key)) headers.Authorization = "Bearer " + key; // legacy JWT service_role key
  if (opts.prefer) headers.Prefer = opts.prefer;
  if (opts.count) headers.Prefer = (headers.Prefer ? headers.Prefer + "," : "") + "count=exact";
  const r = await fetch(env("SUPABASE_URL").replace(/\/+$/, "") + "/rest/v1/" + path, {
    method: opts.method || "GET",
    headers: headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text();
  if (!r.ok) { const e = new Error("supabase " + r.status + ": " + text.slice(0, 200)); e.status = r.status; e.body = text.slice(0, 500); throw e; }
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  if (opts.count) {
    // PostgREST answers "Content-Range: 0-0/57" (or "*/0") when asked for count=exact
    const cr = String((r.headers && typeof r.headers.get === "function" && r.headers.get("content-range")) || "");
    const m = /\/(\d+)\s*$/.exec(cr);
    return { rows: data || [], total: m ? Number(m[1]) : (Array.isArray(data) ? data.length : 0) };
  }
  return data;
}
// True when a Supabase error means "this column does not exist" (e.g. gc_users.last_seen before supabase_update_v10.sql).
function missingColumn(e, col) {
  const t = String((e && (e.body || e.message)) || "");
  return /42703|PGRST204|column .* does not exist|could not find the .* column/i.test(t) && (!col || t.indexOf(col) >= 0);
}
// True when a Supabase error means "this table does not exist" (e.g. gc_settings before supabase_update_v11.sql).
function missingTable(e, table) {
  const t = String((e && (e.body || e.message)) || "");
  return /42P01|PGRST205|relation .* does not exist|could not find the table/i.test(t) && (!table || t.indexOf(table) >= 0);
}
const enc = encodeURIComponent;

// ---------- text helpers shared by chat / profile / stories ----------
function cleanText(v) {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
}
// one line: newlines become spaces, runs of spaces collapse
function cleanName(v) { return cleanText(typeof v === "string" ? v.replace(/\s*\n\s*/g, " ") : v).replace(/\s{2,}/g, " "); }

// Banned words / phrases (whole words, case-insensitive) for chat messages, profile names / bios and My Day captions.
// Edit this list as you like.
const BANNED = [
  "porn", "xxx", "child porn", "cp links",
  "cocaine", "heroin", "meth", "mdma", "drugs for sale", "weed for sale",
  "free money", "double your money", "send crypto", "guaranteed profit", "investment plan"
];
const BANNED_RE = BANNED.map((w) => new RegExp("(^|[^\\p{L}\\p{N}])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "($|[^\\p{L}\\p{N}])", "iu"));
function hasBanned(text) {
  const t = String(text).normalize("NFKC");
  return BANNED_RE.some((re) => re.test(t));
}

// "data:image/jpeg;base64,..." with a real JPEG inside (FF D8 FF) of at most maxBytes decoded bytes. Returns the url, or null.
function checkJpeg(v, maxBytes) {
  if (typeof v !== "string") return null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m || m[1].length > Math.ceil(maxBytes / 3) * 4) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 100 || buf.length > maxBytes || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  return v;
}

// ---------- users + custom profiles (gc_profiles from supabase_update_v13.sql) ----------
function displayName(u) {
  if (!u) return "User";
  const n = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return n || (u.username ? "@" + u.username : "User");
}
// Until gc_profiles exists every read simply returns no custom profiles (checked again after PROF_RECHECK).
const PROF_RECHECK = 2 * 60 * 1000;
const prof = { missingUntil: 0 };
function profilesMissing() { return Date.now() < prof.missingUntil; }
function markProfiles(missing) { prof.missingUntil = missing ? Date.now() + PROF_RECHECK : 0; }
// uid -> {first_name, last_name, updated_at} (no photo: photos are fetched one user at a time and cached by clients)
async function profilesFor(ids) {
  ids = Array.from(new Set((ids || []).map(String).filter((x) => /^\d{1,20}$/.test(x))));
  if (!ids.length || profilesMissing()) return {};
  try {
    const rows = (await sb("gc_profiles?select=user_id,first_name,last_name,updated_at&user_id=in.(" + ids.join(",") + ")")) || [];
    const map = {};
    rows.forEach((r) => { map[String(r.user_id)] = r; });
    return map;
  } catch (e) {
    if (missingTable(e, "gc_profiles")) markProfiles(true);
    else console.error("profiles", e && e.message);
    return {};                                   // never breaks chat
  }
}
// profile version stamp (ms) — clients refetch a user's photo only when it changes
function profV(p) { const t = p && p.updated_at ? Date.parse(p.updated_at) : NaN; return Number.isFinite(t) ? String(t) : ""; }
// a gc_users row with the custom name on top (when the user saved one) and pv = the profile version
function mergeProfile(u, p) {
  const out = Object.assign({}, u || {});
  if (p) {
    if (String(p.first_name || "").trim()) { out.first_name = String(p.first_name); out.last_name = String(p.last_name || ""); }
    out.pv = profV(p);
  }
  return out;
}
async function usersById(ids) {
  ids = Array.from(new Set((ids || []).map(String).filter((x) => /^\d{1,20}$/.test(x))));
  if (!ids.length) return {};
  const [rows, profs] = await Promise.all([
    sb("gc_users?select=id,first_name,last_name,username,photo_url&id=in.(" + ids.join(",") + ")"),
    profilesFor(ids)
  ]);
  const map = {};
  (rows || []).forEach((r) => { map[String(r.id)] = mergeProfile(r, profs[String(r.id)]); });
  return map;
}

module.exports = {
  missingEnv,
  env, json, fail, guard, query, body, verifyInitData, verifyWidget, makeToken, readToken, authUid,
  isAdmin, adminIds, userHash, configured, sb, enc, cleanUser, missingColumn, missingTable,
  cleanText, cleanName, hasBanned, BANNED, checkJpeg, displayName, profilesFor, profV, mergeProfile, usersById, markProfiles, profilesMissing, prof
};
