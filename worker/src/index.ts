import type { Env } from "./types";
import { SiteHub } from "./hub";
import { LABEL_KO, isHigh, isKnownLabel } from "./labels";
import {
  FP_MUTE_SEC,
  decideAlert,
  decideGroup,
  type AlertState,
} from "./alerts";
import {
  answerCallback,
  dataUrlToBytes,
  editMarkup,
  sendAlert,
  sendMessage,
} from "./telegram";

export { SiteHub };

// ───────── 공통 유틸 ─────────

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,X-User-Id,X-User-Token,X-Station-Token",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
const err = (status: number, message: string) => json({ error: message }, status);

const nowSec = () => Math.floor(Date.now() / 1000);

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 24): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 헷갈리는 글자(0/O, 1/I) 제외
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function inviteCode(): string {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return [...a].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

const cleanName = (v: unknown, max = 30) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function kst(sec: number): string {
  return new Date((sec + 9 * 3600) * 1000).toISOString().slice(11, 19);
}

async function authUser(req: Request, env: Env): Promise<string | null> {
  const id = req.headers.get("x-user-id");
  const token = req.headers.get("x-user-token");
  if (!id || !token) return null;
  const row = await env.DB.prepare("SELECT token_hash FROM users WHERE id = ?")
    .bind(id)
    .first<{ token_hash: string }>();
  if (!row || row.token_hash !== (await sha256(token))) return null;
  return id;
}

async function authStation(
  env: Env,
  stationId: string,
  token: string | null
): Promise<{ id: string; site_id: string; name: string } | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT id, site_id, name, token_hash FROM stations WHERE id = ?"
  )
    .bind(stationId)
    .first<{ id: string; site_id: string; name: string; token_hash: string }>();
  if (!row || row.token_hash !== (await sha256(token))) return null;
  return row;
}

function hubFor(env: Env, siteId: string) {
  return env.HUB.get(env.HUB.idFromName(siteId));
}

async function broadcast(env: Env, siteId: string, msg: unknown) {
  try {
    await hubFor(env, siteId).fetch("https://hub/broadcast", {
      method: "POST",
      body: JSON.stringify(msg),
    });
  } catch (e) {
    console.warn("[hub] broadcast 실패", e);
  }
}

// ───────── 라우터 ─────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname;
    const m = req.method;

    try {
      if (path === "/ws") return await handleWs(req, env, url);
      if (path === "/api/health") return await handleHealth(env);
      if (path === "/api/users" && m === "POST") return await createUser(env);
      if (path === "/api/telegram/webhook" && m === "POST")
        return await handleTelegram(req, env, ctx);

      // 스테이션 전용 (스테이션 토큰)
      let mm = path.match(/^\/api\/stations\/([\w-]+)\/events$/);
      if (mm && m === "POST") return await postEvent(req, env, ctx, mm[1]);
      mm = path.match(/^\/api\/stations\/([\w-]+)\/snapshot$/);
      if (mm && m === "GET") return await getSnapshot(env, mm[1], url);
      if (mm && m === "PUT") return await putSnapshot(req, env, ctx, mm[1]);
      mm = path.match(/^\/api\/stations\/([\w-]+)$/);
      if (mm && m === "DELETE") return await deleteStation(req, env, mm[1]);
      if (path === "/api/stations" && m === "POST") return await createStation(req, env);

      // 사용자 전용 (사용자 토큰)
      const uid = await authUser(req, env);
      if (!uid) return err(401, "인증이 필요합니다.");
      if (path === "/api/me" && m === "GET") return await getMe(env, uid);
      if (path === "/api/me/telegram-link" && m === "POST") return await telegramLink(env, uid);
      if (path === "/api/sites" && m === "POST") return await createSite(req, env, uid);
      if (path === "/api/join" && m === "POST") return await joinSite(req, env, uid);
      if (path === "/api/subscriptions" && m === "PUT") return await setSubscription(req, env, uid);

      return err(404, "없는 경로입니다.");
    } catch (e) {
      console.error("[api] 처리 오류", e);
      return err(500, "서버 오류");
    }
  },

  // 매시간: 3일 지난 이벤트 삭제 (스토리지 관리)
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    const cutoff = nowSec() - 3 * 24 * 3600;
    ctx.waitUntil(env.DB.prepare("DELETE FROM events WHERE at < ?").bind(cutoff).run());
  },
};

// ───────── 핸들러 ─────────

async function handleHealth(env: Env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM stations").first<{ n: number }>();
  return json({ ok: true, stations: r?.n ?? 0, maxStations: Number(env.MAX_STATIONS) });
}

async function createUser(env: Env) {
  const id = crypto.randomUUID();
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO users (id, token_hash, created_at) VALUES (?, ?, ?)"
  )
    .bind(id, await sha256(token), nowSec())
    .run();
  return json({ userId: id, userToken: token });
}

async function createSite(req: Request, env: Env, uid: string) {
  const body = await readJson<{ name?: string }>(req);
  const name = cleanName(body?.name, 40);
  if (!name) return err(400, "사이트 이름이 필요합니다.");

  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites").first<{ n: number }>();
  if ((cnt?.n ?? 0) >= Number(env.MAX_SITES)) return err(403, "사이트 개수 한도에 도달했습니다.");

  const id = crypto.randomUUID().slice(0, 12);
  for (let i = 0; i < 5; i++) {
    const code = inviteCode();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO sites (id, name, invite_code, created_at) VALUES (?, ?, ?, ?)"
        ).bind(id, name, code, nowSec()),
        env.DB.prepare("INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)").bind(uid, id),
      ]);
      return json({ site: { id, name, inviteCode: code } });
    } catch {
      // 초대코드 충돌 시 재시도
    }
  }
  return err(500, "초대코드 생성 실패");
}

async function joinSite(req: Request, env: Env, uid: string) {
  const body = await readJson<{ inviteCode?: string }>(req);
  const code = (body?.inviteCode ?? "").trim().toUpperCase();
  const site = await env.DB.prepare("SELECT id, name FROM sites WHERE invite_code = ?")
    .bind(code)
    .first<{ id: string; name: string }>();
  if (!site) return err(404, "초대코드를 찾을 수 없습니다.");
  await env.DB.prepare("INSERT OR IGNORE INTO user_sites (user_id, site_id) VALUES (?, ?)")
    .bind(uid, site.id)
    .run();
  return json({ site });
}

async function getMe(env: Env, uid: string) {
  const user = await env.DB.prepare("SELECT telegram_chat_id FROM users WHERE id = ?")
    .bind(uid)
    .first<{ telegram_chat_id: string | null }>();

  const sites = (
    await env.DB.prepare(
      "SELECT s.id, s.name, s.invite_code FROM sites s JOIN user_sites u ON u.site_id = s.id WHERE u.user_id = ?"
    )
      .bind(uid)
      .all<{ id: string; name: string; invite_code: string }>()
  ).results;

  const stations = (
    await env.DB.prepare(
      `SELECT st.id, st.site_id, st.name, st.online, st.last_seen, st.last_event_at, sl.at AS snap_at
       FROM stations st
       JOIN user_sites u ON u.site_id = st.site_id AND u.user_id = ?
       LEFT JOIN station_last sl ON sl.station_id = st.id
       ORDER BY st.created_at`
    )
      .bind(uid)
      .all<{
        id: string;
        site_id: string;
        name: string;
        online: number;
        last_seen: number;
        last_event_at: number;
        snap_at: number | null;
      }>()
  ).results;

  const subs = new Set(
    (
      await env.DB.prepare("SELECT station_id FROM subscriptions WHERE user_id = ?")
        .bind(uid)
        .all<{ station_id: string }>()
    ).results.map((r) => r.station_id)
  );

  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM stations").first<{ n: number }>();

  return json({
    telegramLinked: !!user?.telegram_chat_id,
    limits: { maxStations: Number(env.MAX_STATIONS), stationCount: total?.n ?? 0 },
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      inviteCode: s.invite_code,
      stations: stations
        .filter((st) => st.site_id === s.id)
        .map((st) => ({
          id: st.id,
          name: st.name,
          online: st.online === 1,
          lastSeen: st.last_seen,
          lastEventAt: st.last_event_at,
          snapshotAt: st.snap_at ?? 0,
          subscribed: subs.has(st.id),
        })),
    })),
  });
}

async function telegramLink(env: Env, uid: string) {
  const token = randomToken(12);
  await env.DB.prepare("UPDATE users SET link_token = ? WHERE id = ?").bind(token, uid).run();
  return json({
    url: env.BOT_USERNAME ? `https://t.me/${env.BOT_USERNAME}?start=${token}` : null,
    token,
  });
}

async function setSubscription(req: Request, env: Env, uid: string) {
  const body = await readJson<{ stationId?: string; on?: boolean }>(req);
  if (!body?.stationId) return err(400, "stationId가 필요합니다.");
  const ok = await env.DB.prepare(
    `SELECT 1 AS ok FROM stations st JOIN user_sites u ON u.site_id = st.site_id
     WHERE st.id = ? AND u.user_id = ?`
  )
    .bind(body.stationId, uid)
    .first();
  if (!ok) return err(403, "참여하지 않은 사이트의 스테이션입니다.");
  if (body.on) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO subscriptions (user_id, station_id) VALUES (?, ?)"
    )
      .bind(uid, body.stationId)
      .run();
  } else {
    await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ? AND station_id = ?")
      .bind(uid, body.stationId)
      .run();
  }
  return json({ ok: true });
}

async function createStation(req: Request, env: Env) {
  const body = await readJson<{ inviteCode?: string; name?: string }>(req);
  const name = cleanName(body?.name);
  const code = (body?.inviteCode ?? "").trim().toUpperCase();
  if (!name) return err(400, "스테이션 이름이 필요합니다.");

  const site = await env.DB.prepare("SELECT id, name FROM sites WHERE invite_code = ?")
    .bind(code)
    .first<{ id: string; name: string }>();
  if (!site) return err(404, "초대코드를 찾을 수 없습니다.");

  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM stations").first<{ n: number }>();
  if ((cnt?.n ?? 0) >= Number(env.MAX_STATIONS)) {
    return err(403, `스테이션은 최대 ${env.MAX_STATIONS}개까지 등록할 수 있습니다.`);
  }

  const id = crypto.randomUUID().slice(0, 12);
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO stations (id, site_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, site.id, name, await sha256(token), nowSec())
    .run();
  await broadcast(env, site.id, { t: "station-added", stationId: id, name });
  return json({ stationId: id, stationToken: token, siteId: site.id, siteName: site.name, name });
}

async function deleteStation(req: Request, env: Env, stationId: string) {
  const st = await authStation(env, stationId, req.headers.get("x-station-token"));
  if (!st) return err(401, "인증 실패");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM subscriptions WHERE station_id = ?").bind(stationId),
    env.DB.prepare("DELETE FROM alert_state WHERE station_id = ?").bind(stationId),
    env.DB.prepare("DELETE FROM station_last WHERE station_id = ?").bind(stationId),
    env.DB.prepare("DELETE FROM events WHERE station_id = ?").bind(stationId),
    env.DB.prepare("DELETE FROM stations WHERE id = ?").bind(stationId),
  ]);
  await broadcast(env, st.site_id, { t: "station-removed", stationId });
  return json({ ok: true });
}

async function getSnapshot(env: Env, stationId: string, url: URL) {
  const row = await env.DB.prepare("SELECT image FROM station_last WHERE station_id = ?")
    .bind(stationId)
    .first<{ image: string }>();
  if (!row) return new Response("사진 없음", { status: 404, headers: CORS });
  // ?v=snapshotAt 버전이 붙은 요청은 내용이 바뀌지 않으므로 오래 캐시 (대역폭·읽기 절약)
  const cache = url.searchParams.has("v")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  return new Response(dataUrlToBytes(row.image), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": cache, ...CORS },
  });
}

// 위반이 없어도 분할화면에 보여줄 "현재 모습" 한 장 (스테이션 시작 시, 이후 주기적으로)
async function putSnapshot(req: Request, env: Env, ctx: ExecutionContext, stationId: string) {
  const st = await authStation(env, stationId, req.headers.get("x-station-token"));
  if (!st) return err(401, "인증 실패");
  const body = await readJson<{ image?: string }>(req);
  if (typeof body?.image !== "string" || body.image.length === 0) return err(400, "image가 필요합니다.");
  if (body.image.length > 250_000) return err(413, "사진이 너무 큽니다.");
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO station_last (station_id, image, at) VALUES (?, ?, ?)
     ON CONFLICT(station_id) DO UPDATE SET image = excluded.image, at = excluded.at`
  )
    .bind(stationId, body.image.replace(/^data:image\/jpeg;base64,/, ""), now)
    .run();
  ctx.waitUntil(broadcast(env, st.site_id, { t: "snapshot", stationId, snapshotAt: now }));
  return json({ ok: true, snapshotAt: now });
}

// ───────── 이벤트 → 중복 방지 → Telegram ─────────

async function postEvent(req: Request, env: Env, ctx: ExecutionContext, stationId: string) {
  const st = await authStation(env, stationId, req.headers.get("x-station-token"));
  if (!st) return err(401, "인증 실패");

  const body = await readJson<{ label?: string; score?: number; image?: string }>(req);
  const label = body?.label ?? "";
  if (!isKnownLabel(label)) return err(400, "알 수 없는 위반 유형");

  let image: string | null = null;
  if (typeof body?.image === "string" && body.image.length > 0) {
    if (body.image.length > 250_000) return err(413, "사진이 너무 큽니다.");
    image = body.image.replace(/^data:image\/jpeg;base64,/, "");
  }

  const now = nowSec();
  const prevRow = await env.DB.prepare(
    "SELECT last_event_at, last_sent_at, level, muted_until FROM alert_state WHERE station_id = ? AND label = ?"
  )
    .bind(stationId, label)
    .first<{ last_event_at: number; last_sent_at: number; level: number; muted_until: number }>();
  const prev: AlertState | null = prevRow
    ? {
        lastEventAt: prevRow.last_event_at,
        lastSentAt: prevRow.last_sent_at,
        level: prevRow.level,
        mutedUntil: prevRow.muted_until,
      }
    : null;
  const d = decideAlert(prev, now, isHigh(label));

  const ins = await env.DB.prepare(
    "INSERT INTO events (station_id, label, score, at, alerted) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(stationId, label, Number(body?.score) || 0, now, d.send ? 1 : 0)
    .run();
  const eventId = Number(ins.meta.last_row_id);

  const stmts = [
    env.DB.prepare(
      `INSERT INTO alert_state (station_id, label, last_event_at, last_sent_at, level, muted_until)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(station_id, label) DO UPDATE SET
         last_event_at = excluded.last_event_at,
         last_sent_at = excluded.last_sent_at,
         level = excluded.level`
    ).bind(stationId, label, d.next.lastEventAt, d.next.lastSentAt, d.next.level, d.next.mutedUntil),
    env.DB.prepare("UPDATE stations SET last_event_at = ? WHERE id = ?").bind(now, stationId),
  ];
  if (image) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO station_last (station_id, image, at) VALUES (?, ?, ?)
         ON CONFLICT(station_id) DO UPDATE SET image = excluded.image, at = excluded.at`
      ).bind(stationId, image, now)
    );
  }
  await env.DB.batch(stmts);

  ctx.waitUntil(
    broadcast(env, st.site_id, {
      t: "event",
      stationId,
      label,
      at: now,
      alerted: d.send,
      eventId,
      snapshotAt: image ? now : undefined,
    })
  );

  if (d.send) {
    ctx.waitUntil(notify(env, st, label, eventId, now, image));
  }
  return json({ ok: true, alerted: d.send, eventId });
}

async function notify(
  env: Env,
  st: { id: string; site_id: string; name: string },
  label: string,
  eventId: number,
  at: number,
  image: string | null
) {
  const site = await env.DB.prepare("SELECT name FROM sites WHERE id = ?")
    .bind(st.site_id)
    .first<{ name: string }>();
  const text = `🚨 ${LABEL_KO[label]}\n📍 ${site?.name ?? ""} / ${st.name}\n🕒 ${kst(at)}`;
  const markup = {
    inline_keyboard: [[{ text: "오탐 신고", callback_data: `fp:${eventId}` }]],
  };

  // 개인 DM — 이 스테이션을 구독한 사람만
  const dms = (
    await env.DB.prepare(
      `SELECT u.telegram_chat_id AS chat FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.station_id = ? AND u.telegram_chat_id IS NOT NULL LIMIT 40`
    )
      .bind(st.id)
      .all<{ chat: string }>()
  ).results;
  await Promise.all(dms.map((r) => sendAlert(env, r.chat, text, image, markup)));

  // 사이트 그룹 — 분당 20건 제한 때문에 창 단위로 묶음 처리
  const groups = (
    await env.DB.prepare(
      "SELECT chat_id, window_start, window_count, suppressed FROM group_links WHERE site_id = ?"
    )
      .bind(st.site_id)
      .all<{ chat_id: string; window_start: number; window_count: number; suppressed: number }>()
  ).results;
  for (const g of groups) {
    const gd = decideGroup(
      { windowStart: g.window_start, windowCount: g.window_count, suppressed: g.suppressed },
      at
    );
    await env.DB.prepare(
      "UPDATE group_links SET window_start = ?, window_count = ?, suppressed = ? WHERE chat_id = ?"
    )
      .bind(gd.next.windowStart, gd.next.windowCount, gd.next.suppressed, g.chat_id)
      .run();
    if (gd.summarize > 0) {
      await sendMessage(env, g.chat_id, `⚠️ 직전 1분 동안 알림 ${gd.summarize}건이 더 있었습니다. 앱에서 확인하세요.`);
    }
    if (gd.send) await sendAlert(env, g.chat_id, text, image, markup);
  }
}

// ───────── Telegram 웹훅 ─────────

interface TgUpdate {
  message?: {
    chat: { id: number; type: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

async function handleTelegram(req: Request, env: Env, ctx: ExecutionContext) {
  if (env.WEBHOOK_SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
    return err(403, "forbidden");
  }
  const update = await readJson<TgUpdate>(req);
  // 텔레그램은 non-200이면 재시도하므로 처리 실패해도 200을 돌려준다
  if (update) ctx.waitUntil(processTelegram(env, update).catch((e) => console.error("[tg]", e)));
  return json({ ok: true });
}

async function processTelegram(env: Env, update: TgUpdate) {
  if (update.callback_query) return processCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const [rawCmd, arg] = msg.text.trim().split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const isPrivate = msg.chat.type === "private";

  if (isPrivate) {
    if (cmd === "/start" && arg) {
      const u = await env.DB.prepare("SELECT id FROM users WHERE link_token = ?")
        .bind(arg)
        .first<{ id: string }>();
      if (!u) return void (await sendMessage(env, chatId, "연결 링크가 만료되었습니다. 앱에서 '알림 연결'을 다시 눌러주세요."));
      await env.DB.prepare("UPDATE users SET telegram_chat_id = ?, link_token = NULL WHERE id = ?")
        .bind(chatId, u.id)
        .run();
      return void (await sendMessage(env, chatId, "✅ 연결되었습니다. 앱에서 알림 받을 스테이션을 선택하세요."));
    }
    if (cmd === "/stop") {
      await env.DB.prepare("UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ?")
        .bind(chatId)
        .run();
      return void (await sendMessage(env, chatId, "알림 연결을 해제했습니다."));
    }
    return void (await sendMessage(env, chatId, "ARGUS 안전 알림 봇입니다. 앱의 '알림 연결' 버튼으로 연결하세요."));
  }

  // 그룹: /link 초대코드 → 사이트 전체 알림 수신
  if (cmd === "/link" && arg) {
    const site = await env.DB.prepare("SELECT id, name FROM sites WHERE invite_code = ?")
      .bind(arg.toUpperCase())
      .first<{ id: string; name: string }>();
    if (!site) return void (await sendMessage(env, chatId, "초대코드를 찾을 수 없습니다."));
    await env.DB.prepare(
      `INSERT INTO group_links (chat_id, site_id) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET site_id = excluded.site_id`
    )
      .bind(chatId, site.id)
      .run();
    return void (await sendMessage(env, chatId, `✅ '${site.name}' 사이트의 모든 스테이션 알림을 이 그룹으로 보냅니다.`));
  }
  if (cmd === "/unlink") {
    await env.DB.prepare("DELETE FROM group_links WHERE chat_id = ?").bind(chatId).run();
    return void (await sendMessage(env, chatId, "그룹 알림 연결을 해제했습니다."));
  }
}

async function processCallback(env: Env, cb: NonNullable<TgUpdate["callback_query"]>) {
  const m = (cb.data ?? "").match(/^fp:(\d+)$/);
  if (!m) return void (await answerCallback(env, cb.id, ""));

  const ev = await env.DB.prepare(
    `SELECT e.station_id, e.label, st.site_id FROM events e
     JOIN stations st ON st.id = e.station_id WHERE e.id = ?`
  )
    .bind(Number(m[1]))
    .first<{ station_id: string; label: string; site_id: string }>();
  if (!ev) return void (await answerCallback(env, cb.id, "이미 삭제된 기록입니다."));

  const until = nowSec() + FP_MUTE_SEC;
  await env.DB.batch([
    env.DB.prepare("UPDATE events SET false_positive = 1 WHERE id = ?").bind(Number(m[1])),
    env.DB.prepare(
      `INSERT INTO alert_state (station_id, label, muted_until) VALUES (?, ?, ?)
       ON CONFLICT(station_id, label) DO UPDATE SET muted_until = excluded.muted_until`
    ).bind(ev.station_id, ev.label, until),
  ]);
  await answerCallback(env, cb.id, "오탐으로 기록했습니다. 이 스테이션의 같은 유형 알림을 1시간 끕니다.");
  if (cb.message) {
    await editMarkup(env, cb.message.chat.id, cb.message.message_id, {
      inline_keyboard: [[{ text: "✓ 오탐 신고됨 (1시간 음소거)", callback_data: "noop" }]],
    });
  }
  await broadcast(env, ev.site_id, { t: "muted", stationId: ev.station_id, label: ev.label, until });
}

// ───────── WebSocket ─────────

async function handleWs(req: Request, env: Env, url: URL) {
  if (req.headers.get("Upgrade") !== "websocket") return err(426, "WebSocket 필요");
  const role = url.searchParams.get("role");

  if (role === "station") {
    const sid = url.searchParams.get("stationId") ?? "";
    const st = await authStation(env, sid, url.searchParams.get("token"));
    if (!st) return err(401, "인증 실패");
    return hubFor(env, st.site_id).fetch(
      new Request(`https://hub/ws?role=station&id=${st.id}`, req)
    );
  }

  if (role === "viewer") {
    const userId = url.searchParams.get("userId") ?? "";
    const siteId = url.searchParams.get("siteId") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const u = await env.DB.prepare("SELECT token_hash FROM users WHERE id = ?")
      .bind(userId)
      .first<{ token_hash: string }>();
    if (!u || u.token_hash !== (await sha256(token))) return err(401, "인증 실패");
    const member = await env.DB.prepare(
      "SELECT 1 AS ok FROM user_sites WHERE user_id = ? AND site_id = ?"
    )
      .bind(userId, siteId)
      .first();
    if (!member) return err(403, "참여하지 않은 사이트입니다.");
    return hubFor(env, siteId).fetch(
      new Request(`https://hub/ws?role=viewer&id=${userId}`, req)
    );
  }
  return err(400, "role이 필요합니다.");
}
