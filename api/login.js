// POST /api/login  body: {initData}  (inside Telegram)  or the Telegram Login Widget fields (browser).
// Answers {ok, token, exp, user, isAdmin}. The token is our own session: uid.exp.hmac(SESSION_SECRET), 30 days.
"use strict";
const L = require("./_lib");

module.exports = async (req, res) => {
  try {
    if (!L.guard(req, res, ["POST"])) return;
    if (!L.configured()) return L.fail(res, 500, "Chat is not set up yet. Missing in Vercel: " + L.missingEnv().join(", "));
    const b = await L.body(req);
    const bot = L.env("BOT_TOKEN");
    const user = typeof b.initData === "string" ? L.verifyInitData(b.initData, bot) : L.verifyWidget(b, bot);
    if (!user) return L.fail(res, 401, "Telegram login could not be checked. Please log in again.");

    await L.sb("gc_users?on_conflict=id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [{ id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username, photo_url: user.photo_url, updated_at: new Date().toISOString() }]
    });

    const t = L.makeToken(user.id);
    L.json(res, 200, {
      ok: true, token: t.token, exp: t.exp, isAdmin: L.isAdmin(user.id),
      user: { id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username, photo_url: user.photo_url }
    });
  } catch (e) {
    console.error("login", e && e.message);
    L.fail(res, 500, "Server error. Please try again.");
  }
};
