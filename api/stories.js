// Group City "My Day" (Telegram-style stories): a photo with an optional caption, visible to every logged-in user
// for 24 hours. Every call needs "Authorization: Bearer <token from /api/login>". Table gc_stories (supabase_update_v13.sql).
//
// GET  /api/stories                 active stories, newest first, WITHOUT photos:
//                                   {stories:[{id, u, name, pv, photo (Telegram avatar url), caption, at, exp, mine}], me}
// GET  /api/stories?id=<id>         one active story WITH its photo (data:image/jpeg;base64,...)
// POST /api/stories {action:"post", photo, caption}   photo: real JPEG ≤ 150 KB (max side 1080 is done on the device),
//                                   caption ≤ 200 characters; at most 10 active stories per user
// POST /api/stories {action:"delete", id}             delete own story (admins: any story)
//
// Expired stories are never returned and are deleted lazily (at most every 10 minutes per server instance).
// Until the table exists, reads answer an empty list and writes answer "Run supabase_update_v13.sql first".
// Non-admins never receive other users' Telegram IDs (only the opaque `u`).
"use strict";
const L = require("./_lib");

const PHOTO_MAX = 150 * 1024, CAPTION_MAX = 200, MAX_ACTIVE = 10, LIFE_MS = 24 * 3600 * 1000;
const LIST_MAX = 300, RATE_MS = 5000, CLEAN_EVERY = 10 * 60 * 1000;
const NEED_V13 = "Run supabase_update_v13.sql first (Supabase → SQL Editor).";
const META = "id,user_id,caption,created_at,expires_at";
const state = { cleanedAt: 0 };

function isMissing(e) { return L.missingTable(e, "gc_stories"); }
async function cleanup(nowIso) {
  if (Date.now() - state.cleanedAt < CLEAN_EVERY) return false;
  state.cleanedAt = Date.now();
  try { await L.sb("gc_stories?expires_at=lt." + L.enc(nowIso), { method: "DELETE", prefer: "return=minimal" }); return true; }
  catch (e) { if (!isMissing(e)) console.error("stories cleanup", e && e.message); return false; }
}
function shapeStory(r, users, me, admin, photo) {
  const uid = String(r.user_id), u = users[uid];
  const s = {
    id: Number(r.id), u: L.userHash(uid), name: L.displayName(u), photo: (u && u.photo_url) || "",
    caption: String(r.caption || ""), at: r.created_at, exp: r.expires_at, mine: uid === String(me)
  };
  if (u && u.pv) s.pv = u.pv;
  if (admin) s.uid = uid;
  if (photo !== undefined) s.image = photo;
  return s;
}

module.exports = async (req, res) => {
  try {
    if (!L.guard(req, res, ["GET", "POST"])) return;
    if (!L.configured()) return L.fail(res, 500, "My Day is not set up yet. Missing in Vercel: " + L.missingEnv().join(", "));
    const me = L.authUid(req);
    if (!me) return L.fail(res, 401, "Please log in with Telegram.");
    const admin = L.isAdmin(me);
    const nowIso = new Date().toISOString();

    if (req.method === "GET") {
      const q = L.query(req);
      if (q.id !== undefined) {
        const id = String(q.id || "");
        if (!/^\d{1,18}$/.test(id)) return L.fail(res, 400, "Bad story.");
        let rows;
        try { rows = await L.sb("gc_stories?select=" + META + ",photo&id=eq." + id + "&expires_at=gt." + L.enc(nowIso) + "&limit=1"); }
        catch (e) { if (isMissing(e)) return L.fail(res, 404, "This story is no longer available."); throw e; }
        const r = rows && rows[0];
        if (!r) return L.fail(res, 404, "This story is no longer available.");
        const users = await L.usersById([r.user_id]);
        const photo = typeof r.photo === "string" && /^data:image\/jpeg;base64,/.test(r.photo) ? r.photo : "";
        return L.json(res, 200, { ok: true, story: shapeStory(r, users, me, admin, photo) });
      }
      let rows;
      try {
        await cleanup(nowIso);
        rows = (await L.sb("gc_stories?select=" + META + "&expires_at=gt." + L.enc(nowIso) + "&order=created_at.desc,id.desc&limit=" + LIST_MAX)) || [];
      } catch (e) {
        if (!isMissing(e)) throw e;
        const o = { ok: true, stories: [], me: L.userHash(me) };
        if (admin) o.needSql = NEED_V13;
        return L.json(res, 200, o);
      }
      const users = await L.usersById(rows.map((r) => r.user_id));
      return L.json(res, 200, { ok: true, me: L.userHash(me), max: MAX_ACTIVE, stories: rows.map((r) => shapeStory(r, users, me, admin)) });
    }

    // POST
    let b;
    try { b = await L.body(req, 400000); } catch (e) { return L.fail(res, 413, "Photo is too big."); }
    const action = String(b.action || L.query(req).action || "");
    if (action === "post") {
      const photo = L.checkJpeg(b.photo, PHOTO_MAX);
      if (!photo) return L.fail(res, 400, "Photo must be a JPEG under 150 KB.");
      const caption = L.cleanText(b.caption).replace(/\n{3,}/g, "\n\n");
      if (caption.length > CAPTION_MAX) return L.fail(res, 400, "Caption is too long (max " + CAPTION_MAX + " characters).");
      if (!admin && caption && L.hasBanned(caption)) return L.fail(res, 400, "This caption has words that are not allowed here.");
      let mine;
      try {
        mine = await L.sb("gc_stories?select=id,created_at&user_id=eq." + me + "&expires_at=gt." + L.enc(nowIso) + "&order=id.desc&limit=" + (MAX_ACTIVE + 1));
      } catch (e) { if (isMissing(e)) return L.fail(res, 503, NEED_V13); throw e; }
      mine = mine || [];
      if (mine.length >= MAX_ACTIVE) return L.fail(res, 400, "You can have up to " + MAX_ACTIVE + " stories at a time. Delete one or wait until one ends.");
      const last = mine[0] ? Date.parse(mine[0].created_at) : 0;
      if (!admin && last && Date.now() - last < RATE_MS) return L.fail(res, 429, "Slow down a little — wait a few seconds.");
      const now = Date.now();
      let ins;
      try {
        ins = await L.sb("gc_stories", { method: "POST", prefer: "return=representation", body: [{ user_id: Number(me), photo: photo, caption: caption, created_at: new Date(now).toISOString(), expires_at: new Date(now + LIFE_MS).toISOString() }] });
      } catch (e) { if (isMissing(e)) return L.fail(res, 503, NEED_V13); throw e; }
      const r = ins && ins[0];
      if (!r) return L.fail(res, 500, "Story was not saved. Please try again.");
      const users = await L.usersById([me]);
      return L.json(res, 200, { ok: true, story: shapeStory(r, users, me, admin) });
    }
    if (action === "delete") {
      const id = String(b.id || "");
      if (!/^\d{1,18}$/.test(id)) return L.fail(res, 400, "Bad story.");
      let rows;
      try { rows = await L.sb("gc_stories?select=id,user_id&id=eq." + id + "&limit=1"); }
      catch (e) { if (isMissing(e)) return L.fail(res, 503, NEED_V13); throw e; }
      const r = rows && rows[0];
      if (!r) return L.fail(res, 404, "Story not found.");
      if (String(r.user_id) !== String(me) && !admin) return L.fail(res, 403, "You can only delete your own stories.");
      await L.sb("gc_stories?id=eq." + id, { method: "DELETE", prefer: "return=minimal" });
      return L.json(res, 200, { ok: true, id: Number(id) });
    }
    return L.fail(res, 400, "Unknown action.");
  } catch (e) {
    console.error("stories", e && e.message);
    L.fail(res, 500, "Server error. Please try again.");
  }
};

module.exports._test = { state, PHOTO_MAX, CAPTION_MAX, MAX_ACTIVE, LIFE_MS, NEED_V13 };
