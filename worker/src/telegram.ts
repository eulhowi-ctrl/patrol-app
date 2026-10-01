import type { Env } from "./types";

const base = (env: Env) => env.TELEGRAM_API_BASE ?? "https://api.telegram.org";

async function call(env: Env, method: string, body: BodyInit, json = false) {
  if (!env.BOT_TOKEN) return null;
  try {
    const res = await fetch(`${base(env)}/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: json ? { "Content-Type": "application/json" } : undefined,
      body,
    });
    if (!res.ok) console.warn("[telegram]", method, res.status);
    return res;
  } catch (err) {
    console.warn("[telegram] 호출 실패", method, err);
    return null;
  }
}

export function sendMessage(
  env: Env,
  chatId: string,
  text: string,
  replyMarkup?: unknown
) {
  return call(
    env,
    "sendMessage",
    JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }),
    true
  );
}

/** 스냅샷(JPEG base64 data URL)이 있으면 사진으로, 없으면 텍스트로 보낸다 */
export async function sendAlert(
  env: Env,
  chatId: string,
  text: string,
  imageDataUrl: string | null,
  replyMarkup?: unknown
) {
  if (!imageDataUrl) return sendMessage(env, chatId, text, replyMarkup);
  const bytes = dataUrlToBytes(imageDataUrl);
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", text);
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  form.append("photo", new Blob([bytes], { type: "image/jpeg" }), "snap.jpg");
  return call(env, "sendPhoto", form);
}

export function answerCallback(env: Env, id: string, text: string) {
  return call(
    env,
    "answerCallbackQuery",
    JSON.stringify({ callback_query_id: id, text }),
    true
  );
}

export function editMarkup(
  env: Env,
  chatId: string | number,
  messageId: number,
  replyMarkup: unknown
) {
  return call(
    env,
    "editMessageReplyMarkup",
    JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    }),
    true
  );
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
