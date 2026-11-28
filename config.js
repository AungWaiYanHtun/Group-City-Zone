// Group City website settings. Change these only if you move the bot to another worker or rename the bot.
// Chat/support settings (Supabase keys, bot token) live ONLY in Vercel Environment Variables — never here.
window.GC_CONFIG = {
  API_URL: "https://fetishsocial-telegram-bot.aungwaiyanhtun786.workers.dev", // Cloudflare worker (no / at the end)
  BOT: "GroupCity_Bot",                                                     // bot username, without @
  // Group categories (chips on the Groups page + the picker in Promote). To add one, add it here AND to the
  // worker (CATEGORIES in server.ts, or the Cloudflare variable CATEGORIES = comma list). Names must match exactly.
  CATEGORIES: ["Chatting Group", "Dating Group", "Videos Group"],
  // Reward ads (CleanAds, cleanads.ai). Paste the Rewarded placement id ("pl_...") from your CleanAds app page.
  // Empty = the Reward screen shows "coming soon".
  CLEANADS_PLACEMENT_ID: "pl_Q1kvznHjPi47",
  // true = CleanAds free sample ads (for testing, never paid). Set to false after CleanAds approves the app.
  CLEANADS_TEST: false,
  // Second ad network (Adexium, adexium.io): shown only when CleanAds has no ad for this user.
  // Paste the Placement ID (WID) from your Adexium Telegram Mini App placement. Empty = Adexium off.
  ADEXIUM_WID: "",
  // true = Adexium test ads on every request (never paid). Keep false for real ads.
  ADEXIUM_DEBUG: false
};
