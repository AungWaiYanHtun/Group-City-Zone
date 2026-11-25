// Group City website settings. Change these only if you move the bot to another worker or rename the bot.
// Chat/support settings (Supabase keys, bot token) live ONLY in Vercel Environment Variables — never here.
window.GC_CONFIG = {
  API_URL: "https://fetishsocial-telegram-bot.aungwaiyanhtun786.workers.dev", // Cloudflare worker (no / at the end)
  BOT: "GroupCity_Bot",                                                     // bot username, without @
  // Group categories (chips on the Groups page + the picker in Promote). To add one, add it here AND to the
  // worker (CATEGORIES in server.ts, or the Cloudflare variable CATEGORIES = comma list). Names must match exactly.
  CATEGORIES: ["Chatting Group", "Dating Group", "Videos Group"],
  // Airdrop (Adsgram Reward ads). Paste the Reward blockId (digits) from partner.adsgram.ai for THIS Mini App's
  // platform (Web app url = this site). Empty = Airdrop shows "coming soon".
  ADSGRAM_BLOCK_ID: "61688"
};
