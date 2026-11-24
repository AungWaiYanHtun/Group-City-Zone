// Group City chat API. Every call needs "Authorization: Bearer <token from /api/login>".
//
// GET  /api/chat?room=public[&after=<id>]                 public chat (latest 100, or newer than <id>)
// GET  /api/chat?room=support[&uid=<user id>][&after=<id>] support thread: own thread; admins pass uid
// GET  /api/chat?view=summary                             last message of each row on the Messages list
// GET  /api/chat?view=threads                             admins only: all support threads, newest first
// GET  /api/chat?view=members  (or ?action=members)       chat info: members (200 most recently active), total, online
// GET  /api/chat?view=member&uid=<user id>                admins only: one user's info (support thread info page)
// GET  /api/chat?view=links                               chat info Links tab: last 50 public messages with a link
// POST /api/chat {action:"send", room, uid?, text}         send a message
// POST /api/chat {action:"delete", id}                     delete own message (admins: any message)
// GET  /api/chat?view=settings                            public chat name / photo / description (any logged-in user)
// POST /api/chat {action:"settings", name, description, photo?}   admins only: edit the public chat
//      photo: omitted = keep, "" = remove, "data:image/jpeg;base64,..." (≤ 120 KB) = new photo
//      (summary also answers settingsV = the settings version, so clients refetch only when it changed)
//
// Non-admins never receive other users' Telegram IDs: each message carries `u` (opaque hash) and `mine`.
// v13: names come from the user's own profile (gc_profiles, Edit Info) when they saved one; messages / members /
// threads then also carry `pv` (profile version). Photos are never in these lists: clients fetch /api/profile?u= once
// per version and cache it.
// Every authenticated request also stamps gc_users.last_seen (at most once a minute per user) for "online / last seen".
"use strict";
const L = require("./_lib");

const MAX_LEN = 1000;
const RATE_MS = 3000;
const PAGE = 100;
const MEMBERS_MAX = 200;          // members list: the 200 most recently active users
const ONLINE_MS = 5 * 60 * 1000;  // "online" = seen in the last 5 minutes
const SEEN_EVERY = 60 * 1000;     // write last_seen at most once a minute per user (per server instance)
const RECHECK_MS = 10 * 60 * 1000; // column missing: try again after 10 minutes (the owner may have run the SQL)
const LINKS_MAX = 50;

// ---------- public chat settings (gc_settings row 'public_chat', from supabase_update_v11.sql) ----------
const SET_KEY = "public_chat";
const NAME_MAX = 64, DESC_MAX = 255, PHOTO_MAX = 120 * 1024;   // photo: decoded JPEG bytes
const SET_DEFAULT = { name: "Group City Chat", photo: "", description: "", v: "" };
const SET_TTL = 15000;            // per server instance; a save clears it
const NEED_V11 = "Run supabase_update_v11.sql first (Supabase → SQL Editor).";
const setCache = { at: 0, val: null };
function settingsOut(r) {
  if (!r) return Object.assign({}, SET_DEFAULT);
  return {
    name: String(r.name || "").trim() || SET_DEFAULT.name,
    photo: typeof r.photo === "string" && /^data:image\/jpeg;base64,/.test(r.photo) ? r.photo : "",
    description: String(r.description || ""),
    v: String(r.updated_at || "")
  };
}
// Never throws for a missing table: the chat simply uses the defaults until the SQL is run.
async function readSettings() {
  if (setCache.val && Date.now() - setCache.at < SET_TTL) return setCache.val;
  let val;
  try {
    const rows = await L.sb("gc_settings?select=key,name,photo,description,updated_at&key=eq." + SET_KEY + "&limit=1");
    val = settingsOut(rows && rows[0]);
  } catch (e) {
    if (!L.missingTable(e, "gc_settings")) throw e;
    val = Object.assign({ missing: true }, SET_DEFAULT);
  }
  setCache.at = Date.now(); setCache.val = val;
  return val;
}
const cleanName = L.cleanName, cleanText = L.cleanText, hasBanned = L.hasBanned, displayName = L.displayName, usersById = L.usersById;
// "data:image/jpeg;base64,..." with a real JPEG inside and at most PHOTO_MAX bytes. Returns the url, or null.
function checkPhoto(v) { return L.checkJpeg(v, PHOTO_MAX); }
async function saveSettings(me, b) {
  const name = cleanName(b.name), description = cleanText(b.description);
  if (!name) return { status: 400, message: "Enter a chat name." };
  if (name.length > NAME_MAX) return { status: 400, message: "Name is too long (max " + NAME_MAX + " characters)." };
  if (description.length > DESC_MAX) return { status: 400, message: "Description is too long (max " + DESC_MAX + " characters)." };
  const row = { key: SET_KEY, name: name, description: description, updated_at: new Date().toISOString(), updated_by: Number(me) };
  if (b.photo !== undefined && b.photo !== null) {
    if (b.photo === "") row.photo = "";
    else {
      const ph = checkPhoto(b.photo);
      if (!ph) return { status: 400, message: "Photo must be a JPEG under 120 KB." };
      row.photo = ph;
    }
  }
  let saved;
  try {
    saved = await L.sb("gc_settings?on_conflict=key", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: [row] });
  } catch (e) {
    if (L.missingTable(e, "gc_settings")) return { status: 503, message: NEED_V11 };
    throw e;
  }
  setCache.at = 0; setCache.val = null;
  return { status: 200, settings: settingsOut(saved && saved[0] ? saved[0] : row) };
}

// Banned words list (BANNED) and the text helpers now live in api/_lib.js (shared with profile.js / stories.js).

// Which room may this user open? Returns the room key, or null with a reason.
function resolveRoom(me, admin, room, uidParam) {
  if (room === "public") return { room: "public" };
  if (room === "support") {
    if (admin) {
      if (!/^\d{1,20}$/.test(String(uidParam || ""))) return { err: "Choose a support thread." };
      return { room: "support:" + uidParam, threadUid: String(uidParam) };
    }
    return { room: "support:" + me, threadUid: String(me) }; // a user only ever gets their own thread
  }
  return { err: "Unknown chat." };
}

// ---------- presence (gc_users.last_seen) ----------
// The column comes from supabase_update_v10.sql. Until it exists everything still works: no writes are tried
// for a while, and members show "last seen recently" with no online count.
const presence = { touched: new Map(), noColUntil: 0 };
function seenColumnOk() { return Date.now() >= presence.noColUntil; }
function markNoSeenColumn() { presence.noColUntil = Date.now() + RECHECK_MS; }
async function touchSeen(uid) {
  uid = String(uid);
  if (!/^\d{1,20}$/.test(uid) || !seenColumnOk()) return false;
  const now = Date.now(), last = presence.touched.get(uid) || 0;
  if (now - last < SEEN_EVERY) return false;              // throttled: no DB write
  if (presence.touched.size > 5000) presence.touched.clear();
  presence.touched.set(uid, now);
  try {
    await L.sb("gc_users?id=eq." + uid, { method: "PATCH", prefer: "return=minimal", body: { last_seen: new Date(now).toISOString() } });
    return true;
  } catch (e) {
    if (L.missingColumn(e, "last_seen")) markNoSeenColumn();
    else console.error("last_seen", e && e.message);
    return false;                                          // never breaks the chat request
  }
}
function isOnline(seen, now) { const t = seen ? Date.parse(seen) : NaN; return Number.isFinite(t) && now - t < ONLINE_MS; }

const USER_COLS = "id,first_name,last_name,username,photo_url";
// gc_users rows with last_seen when the column exists; falls back to rows without it.
async function readUsers(query) {
  if (seenColumnOk()) {
    try { return { rows: (await L.sb("gc_users?select=" + USER_COLS + ",last_seen" + query.withSeen)) || [], hasSeen: true }; }
    catch (e) { if (!L.missingColumn(e, "last_seen")) throw e; markNoSeenColumn(); }
  }
  return { rows: (await L.sb("gc_users?select=" + USER_COLS + query.noSeen)) || [], hasSeen: false };
}
function memberOut(r, me, viewerAdmin, hasSeen, now) {
  const id = String(r.id);
  const m = { u: L.userHash(id), name: displayName(r), photo: r.photo_url || "", admin: L.isAdmin(id), mine: id === String(me) };
  if (r.pv) m.pv = r.pv;
  m.seen = hasSeen && r.last_seen ? r.last_seen : null;
  m.online = m.mine || (hasSeen && isOnline(r.last_seen, now));
  if (viewerAdmin) { m.uid = id; m.username = r.username || ""; }
  return m;
}
function memberOrder(a, b) {
  if (a.admin !== b.admin) return a.admin ? -1 : 1;
  if (a.online !== b.online) return a.online ? -1 : 1;
  const ta = a.seen ? Date.parse(a.seen) : 0, tb = b.seen ? Date.parse(b.seen) : 0;
  return tb - ta;
}
async function members(me, viewerAdmin) {
  const now = Date.now();
  const got = await readUsers({
    withSeen: "&order=last_seen.desc.nullslast,updated_at.desc&limit=" + MEMBERS_MAX,
    noSeen: "&order=updated_at.desc&limit=" + MEMBERS_MAX
  });
  let rows = got.rows;
  const have = new Set(rows.map((r) => String(r.id)));
  const extra = L.adminIds().filter((id) => !have.has(id)).slice(0, 50);   // admins always listed
  if (extra.length) {
    const q = "&id=in.(" + extra.join(",") + ")";
    const more = got.hasSeen ? await L.sb("gc_users?select=" + USER_COLS + ",last_seen" + q) : await L.sb("gc_users?select=" + USER_COLS + q);
    rows = rows.concat(more || []);
  }
  const total = (await L.sb("gc_users?select=id&limit=1", { count: true })).total;
  let online = null;
  if (got.hasSeen) {
    online = (await L.sb("gc_users?select=id&limit=1&last_seen=gte." + L.enc(new Date(now - ONLINE_MS).toISOString()), { count: true })).total;
    if (!rows.some((r) => String(r.id) === String(me) && isOnline(r.last_seen, now))) online++;   // the viewer is online right now
  }
  const pm = await L.profilesFor(rows.map((r) => r.id));
  const list = rows.map((r) => memberOut(L.mergeProfile(r, pm[String(r.id)]), me, viewerAdmin, got.hasSeen, now)).sort(memberOrder);
  return { total: Math.max(total, list.length), online: online, hasSeen: got.hasSeen, members: list, more: total > list.length };
}

// Shape one message for this viewer.
function shape(m, users, me, viewerAdmin) {
  const uid = String(m.uid);
  const u = users[uid];
  const fromAdmin = L.isAdmin(uid);
  const support = String(m.room).indexOf("support:") === 0;
  const out = {
    id: Number(m.id),
    text: String(m.text || ""),
    at: m.created_at,
    u: L.userHash(uid),
    mine: uid === String(me) || (viewerAdmin && support && fromAdmin),
    admin: fromAdmin,
    name: support && fromAdmin ? "Support" : displayName(u),
    photo: support && fromAdmin ? "" : (u && u.photo_url) || ""
  };
  if (!(support && fromAdmin) && u && u.pv) out.pv = u.pv;      // custom profile (name already applied; photo fetched by clients)
  if (viewerAdmin) { out.uid = uid; out.username = (u && u.username) || ""; }
  return out;
}

async function listRoom(room, after) {
  const base = "gc_messages?select=id,room,uid,text,created_at&deleted=is.false&room=eq." + L.enc(room);
  if (after) return (await L.sb(base + "&id=gt." + after + "&order=id.asc&limit=" + PAGE)) || [];
  const rows = (await L.sb(base + "&order=id.desc&limit=" + PAGE)) || [];
  return rows.reverse();
}

async function threads(viewerAdmin, me) {
  const rows = (await L.sb("gc_messages?select=id,room,uid,text,created_at&deleted=is.false&room=like." + L.enc("support:*") + "&order=id.desc&limit=1000")) || [];
  const seen = {}, list = [];
  for (const m of rows) {
    if (seen[m.room]) continue;
    seen[m.room] = true;
    const tu = String(m.room).slice(8);
    if (!/^\d{1,20}$/.test(tu)) continue;
    list.push({ threadUid: tu, last: m });
  }
  const users = await usersById(list.map((t) => t.threadUid).concat(list.map((t) => t.last.uid)));
  return list.map((t) => {
    const u = users[t.threadUid];
    return {
      uid: t.threadUid,
      name: displayName(u),
      username: (u && u.username) || "",
      photo: (u && u.photo_url) || "",
      pv: (u && u.pv) || undefined,
      u: L.userHash(t.threadUid),
      last: shape(t.last, users, me, viewerAdmin),
      waiting: !L.isAdmin(t.last.uid) // last word is from the user → needs a reply
    };
  });
}

module.exports = async (req, res) => {
  try {
    if (!L.guard(req, res, ["GET", "POST"])) return;
    if (!L.configured()) return L.fail(res, 500, "Chat is not set up yet. Missing in Vercel: " + L.missingEnv().join(", "));
    const me = L.authUid(req);
    if (!me) return L.fail(res, 401, "Please log in with Telegram.");
    const admin = L.isAdmin(me);
    await touchSeen(me);   // "online / last seen" (throttled; never fails the request)

    if (req.method === "GET") {
      const q = L.query(req);
      if (q.view === "members" || q.action === "members") {
        return L.json(res, 200, Object.assign({ ok: true }, await members(me, admin)));
      }
      if (q.view === "member") {
        if (!admin) return L.fail(res, 403, "Admins only.");
        const uid = String(q.uid || "");
        if (!/^\d{1,20}$/.test(uid)) return L.fail(res, 400, "Bad user.");
        const got = await readUsers({ withSeen: "&id=eq." + uid + "&limit=1", noSeen: "&id=eq." + uid + "&limit=1" });
        const pm = await L.profilesFor([uid]);
        const r = L.mergeProfile(got.rows[0] || { id: uid }, pm[uid]);
        return L.json(res, 200, { ok: true, hasSeen: got.hasSeen, member: memberOut(r, me, true, got.hasSeen, Date.now()) });
      }
      if (q.view === "links") {
        const f = "(" + ["text.ilike.\"*http*\"", "text.ilike.\"*t.me/*\"", "text.ilike.\"*telegram.me/*\""].join(",") + ")";
        const rows = (await L.sb("gc_messages?select=id,room,uid,text,created_at&deleted=is.false&room=eq.public&or=" + L.enc(f) + "&order=id.desc&limit=" + LINKS_MAX)) || [];
        const users = await usersById(rows.map((m) => m.uid));
        return L.json(res, 200, { ok: true, messages: rows.map((m) => shape(m, users, me, admin)) });
      }
      if (q.view === "settings") {
        const st = await readSettings();
        const out = { ok: true, isAdmin: admin, settings: { name: st.name, photo: st.photo, description: st.description, v: st.v } };
        if (st.missing && admin) out.needSql = NEED_V11;
        return L.json(res, 200, out);
      }
      if (q.view === "summary") {
        const pub = await L.sb("gc_messages?select=id,room,uid,text,created_at&deleted=is.false&room=eq.public&order=id.desc&limit=1");
        let sup = null, waiting = 0;
        if (admin) {
          const th = await threads(true, me);
          waiting = th.filter((t) => t.waiting).length;
          if (th[0]) sup = Object.assign({}, th[0].last, { name: th[0].last.admin ? "Support" : th[0].name });
        } else {
          const s = await L.sb("gc_messages?select=id,room,uid,text,created_at&deleted=is.false&room=eq." + L.enc("support:" + me) + "&order=id.desc&limit=1");
          if (s && s[0]) sup = shape(s[0], await usersById([s[0].uid]), me, false);
        }
        const pubMsg = pub && pub[0] ? shape(pub[0], await usersById([pub[0].uid]), me, admin) : null;
        let settingsV;
        try { settingsV = (await readSettings()).v; } catch (e) { console.error("settings", e && e.message); }
        return L.json(res, 200, { ok: true, isAdmin: admin, public: pubMsg, support: sup, waiting: waiting, settingsV: settingsV });
      }
      if (q.view === "threads") {
        if (!admin) return L.fail(res, 403, "Admins only.");
        return L.json(res, 200, { ok: true, threads: await threads(true, me) });
      }
      const r = resolveRoom(me, admin, String(q.room || ""), q.uid);
      if (r.err) return L.fail(res, 400, r.err);
      const after = /^\d{1,18}$/.test(String(q.after || "")) ? String(q.after) : "";
      const rows = await listRoom(r.room, after);
      const users = await usersById(rows.map((m) => m.uid).concat(r.threadUid && admin ? [r.threadUid] : []));
      const out = { ok: true, room: String(q.room), isAdmin: admin, messages: rows.map((m) => shape(m, users, me, admin)) };
      if (after) {
        // ids still visible among the latest page, so clients can drop messages deleted by others
        const live = (await L.sb("gc_messages?select=id&deleted=is.false&room=eq." + L.enc(r.room) + "&order=id.desc&limit=" + PAGE)) || [];
        out.live = live.map((x) => Number(x.id));
      }
      if (admin && r.threadUid) { const tu = users[r.threadUid]; out.thread = { uid: r.threadUid, name: displayName(tu), username: (tu && tu.username) || "", photo: (tu && tu.photo_url) || "", pv: (tu && tu.pv) || undefined }; }
      return L.json(res, 200, out);
    }

    // POST
    let b;
    try { b = await L.body(req, 200000); } catch (e) { return L.fail(res, 413, "Request is too big."); }
    const action = String(b.action || L.query(req).action || "");
    if (action === "settings") {
      if (!admin) return L.fail(res, 403, "Only admins can edit this chat.");
      const r = await saveSettings(me, b);
      if (r.status !== 200) return L.fail(res, r.status, r.message);
      return L.json(res, 200, { ok: true, settings: r.settings });
    }
    if (action === "send") {
      const r = resolveRoom(me, admin, String(b.room || ""), b.uid);
      if (r.err) return L.fail(res, 400, r.err);
      const text = cleanText(b.text);
      if (!text) return L.fail(res, 400, "Write a message first.");
      if (text.length > MAX_LEN) return L.fail(res, 400, "Message is too long (max " + MAX_LEN + " characters).");
      if (!admin && hasBanned(text)) return L.fail(res, 400, "This message has words that are not allowed here.");
      if (!admin) {
        const last = await L.sb("gc_messages?select=created_at&uid=eq." + me + "&order=id.desc&limit=1");
        const t = last && last[0] ? Date.parse(last[0].created_at) : 0;
        if (t && Date.now() - t < RATE_MS) return L.fail(res, 429, "Slow down a little — wait a few seconds.");
      }
      const ins = await L.sb("gc_messages", { method: "POST", prefer: "return=representation", body: [{ room: r.room, uid: me, text: text }] });
      const m = ins && ins[0];
      if (!m) return L.fail(res, 500, "Message was not saved. Please try again.");
      return L.json(res, 200, { ok: true, message: shape(m, await usersById([me]), me, admin) });
    }
    if (action === "delete") {
      const id = String(b.id || "");
      if (!/^\d{1,18}$/.test(id)) return L.fail(res, 400, "Bad message.");
      const rows = await L.sb("gc_messages?select=id,uid,room,deleted&id=eq." + id + "&limit=1");
      const m = rows && rows[0];
      if (!m || m.deleted) return L.fail(res, 404, "Message not found.");
      if (String(m.uid) !== String(me) && !admin) return L.fail(res, 403, "You can only delete your own messages.");
      await L.sb("gc_messages?id=eq." + id, { method: "PATCH", prefer: "return=minimal", body: { deleted: true } });
      return L.json(res, 200, { ok: true, id: Number(id) });
    }
    return L.fail(res, 400, "Unknown action.");
  } catch (e) {
    console.error("chat", e && e.message);
    L.fail(res, 500, "Server error. Please try again.");
  }
};

module.exports._test = { hasBanned, cleanText, resolveRoom, touchSeen, presence, memberOrder, ONLINE_MS, SEEN_EVERY, checkPhoto, setCache, NAME_MAX, DESC_MAX, PHOTO_MAX };
