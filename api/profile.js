// Group City profiles (Telegram-style "Edit Info"): custom name, bio and photo. Every call needs
// "Authorization: Bearer <token from /api/login>". Data: Supabase table gc_profiles (supabase_update_v13.sql).
//
// GET  /api/profile                 own profile {first_name, last_name, bio, photo, v, username, tg_photo, custom}
//                                   (no saved profile yet = the Telegram name, empty bio, no photo)
// GET  /api/profile?u=<user hash>   another user's public profile {u, name, first_name, last_name, bio, photo, v}
//                                   (`u` is the opaque hash chat messages carry; profile null when they never saved one)
// GET  /api/profile?uid=<user id>   admins only: the same by Telegram id
// POST /api/profile {first_name, last_name, bio, photo?}
//      first_name 1-64, last_name 0-64, bio 0-70 characters;
//      photo: omitted = keep, "" = remove, "data:image/jpeg;base64,..." (real JPEG, ≤ 120 KB) = new photo
//
// Chat lists never carry the photos: messages / members / threads carry `pv` (profile version, ms) and the custom
// name only; clients fetch ?u= once per version and cache it. Never shows a phone number (Telegram never gives one).
"use strict";
const L = require("./_lib");

const FIRST_MAX = 64, LAST_MAX = 64, BIO_MAX = 70, PHOTO_MAX = 120 * 1024;
const NEED_V13 = "Run supabase_update_v13.sql first (Supabase → SQL Editor).";
const COLS = "user_id,u,first_name,last_name,bio,photo,updated_at";

function out(p, extra) {
  return Object.assign({
    first_name: String((p && p.first_name) || ""),
    last_name: String((p && p.last_name) || ""),
    bio: String((p && p.bio) || ""),
    photo: p && typeof p.photo === "string" && /^data:image\/jpeg;base64,/.test(p.photo) ? p.photo : "",
    v: L.profV(p)
  }, extra || {});
}
// one gc_profiles row by a filter; {missing:true} when the table is not there yet
async function readOne(filter) {
  if (L.profilesMissing()) return { missing: true, row: null };
  try {
    const rows = await L.sb("gc_profiles?select=" + COLS + "&" + filter + "&limit=1");
    return { row: (rows && rows[0]) || null };
  } catch (e) {
    if (L.missingTable(e, "gc_profiles")) { L.markProfiles(true); return { missing: true, row: null }; }
    throw e;
  }
}
async function tgUser(uid) {
  const rows = await L.sb("gc_users?select=id,first_name,last_name,username,photo_url&id=eq." + uid + "&limit=1");
  return (rows && rows[0]) || { id: uid };
}
function validate(b) {
  const first = L.cleanName(b.first_name), last = L.cleanName(b.last_name);
  const bio = L.cleanText(b.bio).replace(/\n{3,}/g, "\n\n");
  if (!first) return { err: "Enter your first name." };
  if (first.length > FIRST_MAX) return { err: "First name is too long (max " + FIRST_MAX + " characters)." };
  if (last.length > LAST_MAX) return { err: "Last name is too long (max " + LAST_MAX + " characters)." };
  if (bio.length > BIO_MAX) return { err: "Bio is too long (max " + BIO_MAX + " characters)." };
  const row = { first_name: first, last_name: last, bio: bio };
  if (b.photo !== undefined && b.photo !== null) {
    if (b.photo === "") row.photo = "";
    else {
      const ph = L.checkJpeg(b.photo, PHOTO_MAX);
      if (!ph) return { err: "Photo must be a JPEG under 120 KB." };
      row.photo = ph;
    }
  }
  return { row: row };
}

module.exports = async (req, res) => {
  try {
    if (!L.guard(req, res, ["GET", "POST"])) return;
    if (!L.configured()) return L.fail(res, 500, "Profiles are not set up yet. Missing in Vercel: " + L.missingEnv().join(", "));
    const me = L.authUid(req);
    if (!me) return L.fail(res, 401, "Please log in with Telegram.");
    const admin = L.isAdmin(me);

    if (req.method === "GET") {
      const q = L.query(req);
      if (q.u !== undefined || q.uid !== undefined) {
        let filter, uid = "";
        if (q.uid !== undefined) {
          if (!admin) return L.fail(res, 403, "Admins only.");
          uid = String(q.uid || "");
          if (!/^\d{1,20}$/.test(uid)) return L.fail(res, 400, "Bad user.");
          filter = "user_id=eq." + uid;
        } else {
          const u = String(q.u || "");
          if (!/^[0-9a-f]{12}$/.test(u)) return L.fail(res, 400, "Bad user.");
          filter = "u=eq." + u;
        }
        const got = await readOne(filter);
        const r = got.row;
        // the hash is tied to SESSION_SECRET: a row saved under an old secret is not returned for the new hash
        if (r && q.uid === undefined && String(r.u) !== L.userHash(String(r.user_id))) return L.json(res, 200, { ok: true, profile: null });
        if (!r) return L.json(res, 200, { ok: true, profile: null });
        const id = String(r.user_id);
        const p = out(r, { u: L.userHash(id), name: L.displayName(r) });
        if (admin) p.uid = id;
        return L.json(res, 200, { ok: true, profile: p });
      }
      // own profile
      const [got, tu] = await Promise.all([readOne("user_id=eq." + me), tgUser(me)]);
      const base = got.row && String(got.row.first_name || "").trim() ? got.row : { first_name: tu.first_name || "", last_name: tu.last_name || "" };
      const p = out(Object.assign({}, base, { bio: got.row ? got.row.bio : "", photo: got.row ? got.row.photo : "", updated_at: got.row ? got.row.updated_at : "" }), {
        u: L.userHash(me), username: tu.username || "", tg_photo: tu.photo_url || "", custom: !!got.row
      });
      const o = { ok: true, isAdmin: admin, profile: p };
      if (got.missing) o.needSql = NEED_V13;
      return L.json(res, 200, o);
    }

    // POST: save own profile
    let b;
    try { b = await L.body(req, 200000); } catch (e) { return L.fail(res, 413, "Request is too big."); }
    const v = validate(b);
    if (v.err) return L.fail(res, 400, v.err);
    if (!admin && (L.hasBanned(v.row.first_name + " " + v.row.last_name) || L.hasBanned(v.row.bio))) return L.fail(res, 400, "Your name or bio has words that are not allowed here.");
    const row = Object.assign({ user_id: Number(me), u: L.userHash(me), updated_at: new Date().toISOString() }, v.row);
    let saved;
    try {
      saved = await L.sb("gc_profiles?on_conflict=user_id", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: [row] });
    } catch (e) {
      if (L.missingTable(e, "gc_profiles")) { L.markProfiles(true); return L.fail(res, 503, NEED_V13); }
      throw e;
    }
    L.markProfiles(false);
    const s = (saved && saved[0]) || row;
    const tu = await tgUser(me);
    return L.json(res, 200, { ok: true, profile: out(s, { u: L.userHash(me), username: tu.username || "", tg_photo: tu.photo_url || "", custom: true }) });
  } catch (e) {
    console.error("profile", e && e.message);
    L.fail(res, 500, "Server error. Please try again.");
  }
};

module.exports._test = { validate, FIRST_MAX, LAST_MAX, BIO_MAX, PHOTO_MAX, NEED_V13 };
