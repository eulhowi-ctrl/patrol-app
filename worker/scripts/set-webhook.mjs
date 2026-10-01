// Telegram 웹훅 등록: BOT_TOKEN=... WEBHOOK_SECRET=... API_URL=https://... node scripts/set-webhook.mjs
const { BOT_TOKEN, WEBHOOK_SECRET, API_URL } = process.env;
if (!BOT_TOKEN || !WEBHOOK_SECRET || !API_URL) {
  console.error("BOT_TOKEN, WEBHOOK_SECRET, API_URL 환경변수가 필요합니다.");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: `${API_URL.replace(/\/$/, "")}/api/telegram/webhook`,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  }),
});
console.log(await res.json());
