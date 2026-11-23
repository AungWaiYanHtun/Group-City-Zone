// Group City chat API. Every call needs "Authorization: Bearer <token from /api/login>".
//
// GET  /api/chat?room=public[&after=<id>]                 public chat (latest 100, or newer than <id>)
// GET  /api/chat?room=support[&uid=<user id>][&after=<id>] support thread: own thread; admins pass uid
// GET  /api/chat?view=summary                             last message of each row on the Messages list
// GET  /api/chat?view=threads                             admins only: all support threads, newest first
// POST /api/chat {action:"send", room, uid?, text}         send a message
// POST /api/chat {action:"delete", id}                     delete own message (admins: any message)
//
// Non-admins never receive other users' Telegram IDs: each message carries `u` (opaque hash) and `mine`.
"use strict";
const L = require("./_lib");

const MAX_LEN = 1000;
const RATE_MS = 3000;
const PAGE = 100;

// Banned words / phrases (whole words, case-insensitive). Edit this list as you like.
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

function cleanText(v) {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
}
function displayName(u) {
  if (!u) return "User";
  const n = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return n || (u.username ? "@" + u.username : "User");
}

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

async function usersById(ids) {
  ids = Array.from(new Set(ids.map(String).filter((x) => /^\d{1,20}$/.test(x))));
  if (!ids.length) return {};
  const rows = await L.sb("gc_users?select=id,first_name,last_name,username,photo_url&id=in.(" + ids.join(",") + ")");
  const map = {};
  (rows || []).forEach((r) => { map[String(r.id)] = r; });
  return map;
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
      u: L.userHash(t.threadUid),
      last: shape(t.last, users, me, viewerAdmin),
      waiting: !L.isAdmin(t.last.uid) // last word is from the user → needs a reply
    };
  });
}

module.exports = async (req, res) => {
  try {
    if (!L.guard(req, res, ["GET", "POST"])) return;
    if (!L.configured()) return L.fail(res, 500, "Chat is not set up yet (server settings missing).");
    const me = L.authUid(req);
    if (!me) return L.fail(res, 401, "Please log in with Telegram.");
    const admin = L.isAdmin(me);

    if (req.method === "GET") {
      const q = L.query(req);
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
        return L.json(res, 200, { ok: true, isAdmin: admin, public: pubMsg, support: sup, waiting: waiting });
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
      if (admin && r.threadUid) { const tu = users[r.threadUid]; out.thread = { uid: r.threadUid, name: displayName(tu), username: (tu && tu.username) || "", photo: (tu && tu.photo_url) || "" }; }
      return L.json(res, 200, out);
    }

    // POST
    const b = await L.body(req);
    const action = String(b.action || "");
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

module.exports._test = { hasBanned, cleanText, resolveRoom };
