// 서버 E2E 테스트 — `npm run dev`(포트 8787)가 떠 있고, .dev.vars에
// TELEGRAM_API_BASE=http://127.0.0.1:8899, BOT_TOKEN=test, WEBHOOK_SECRET=s3cret 가 있어야 한다.
// Telegram 서버는 이 파일이 직접 모킹한다.
import http from "node:http";
import assert from "node:assert/strict";

const API = process.env.API ?? "http://127.0.0.1:8787";
const SECRET = "s3cret";

// ── Telegram 모킹 서버: 받은 호출을 기록 ──
const calls = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("latin1");
    const method = req.url.split("/").pop();
    let chat = null;
    try {
      chat = JSON.parse(raw).chat_id;
    } catch {
      const m = raw.match(/name="chat_id"\r\n\r\n([^\r]+)/);
      chat = m?.[1] ?? null;
    }
    calls.push({ method, chat: String(chat), raw });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});
await new Promise((r) => mock.listen(8899, r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (cond, ms = 4000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (cond()) return true;
    await sleep(100);
  }
  return false;
};

async function api(path, { method = "GET", body, user, station } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (user) {
    headers["x-user-id"] = user.userId;
    headers["x-user-token"] = user.userToken;
  }
  if (station) headers["x-station-token"] = station;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const tg = (update) =>
  api("/api/telegram/webhook", { method: "POST", body: update }).then(() => {});
const webhook = (update) =>
  fetch(API + "/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body: JSON.stringify(update),
  });

const JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

let pass = 0;
const ok = (name) => {
  pass++;
  console.log("  ✓", name);
};

try {
  // 1) 인증 / 기본
  assert.equal((await api("/api/me")).status, 401);
  ok("토큰 없이 /api/me → 401");

  const alice = (await api("/api/users", { method: "POST" })).data;
  const bob = (await api("/api/users", { method: "POST" })).data;
  const site = (await api("/api/sites", { method: "POST", user: alice, body: { name: "테스트 발전소" } })).data.site;
  assert.match(site.inviteCode, /^[A-Z2-9]{6}$/);
  ok("사용자·사이트 생성, 초대코드 발급");

  // 2) 스테이션 등록 (초대코드)
  assert.equal((await api("/api/stations", { method: "POST", body: { inviteCode: "ZZZZZZ", name: "x" } })).status, 404);
  const sA = (await api("/api/stations", { method: "POST", body: { inviteCode: site.inviteCode, name: "터빈동 1층" } })).data;
  const sB = (await api("/api/stations", { method: "POST", body: { inviteCode: site.inviteCode, name: "보일러동" } })).data;
  assert.ok(sA.stationId && sA.stationToken);
  ok("초대코드로 스테이션 2개 등록 (잘못된 코드는 404)");

  // 3) bob 참여 + 구독 범위 검증
  assert.equal((await api("/api/subscriptions", { method: "PUT", user: bob, body: { stationId: sA.stationId, on: true } })).status, 403);
  ok("사이트 미참여자는 구독 불가(403)");
  await api("/api/join", { method: "POST", user: bob, body: { inviteCode: site.inviteCode.toLowerCase() } });
  await api("/api/subscriptions", { method: "PUT", user: bob, body: { stationId: sA.stationId, on: true } });
  await api("/api/subscriptions", { method: "PUT", user: alice, body: { stationId: sA.stationId, on: true } });
  await api("/api/subscriptions", { method: "PUT", user: alice, body: { stationId: sB.stationId, on: true } });
  let me = (await api("/api/me", { user: bob })).data;
  assert.equal(me.sites[0].stations.find((s) => s.id === sA.stationId).subscribed, true);
  assert.equal(me.sites[0].stations.find((s) => s.id === sB.stationId).subscribed, false);
  ok("bob은 A만, alice는 A·B 구독");

  // 4) Telegram DM 연결
  const aliceLink = (await api("/api/me/telegram-link", { method: "POST", user: alice })).data;
  const bobLink = (await api("/api/me/telegram-link", { method: "POST", user: bob })).data;
  assert.equal((await webhook({ message: { chat: { id: 111, type: "private" }, text: "/start " + aliceLink.token } })).status, 200);
  await webhook({ message: { chat: { id: 222, type: "private" }, text: "/start " + bobLink.token } });
  await wait(() => calls.filter((c) => c.method === "sendMessage").length >= 2);
  me = (await api("/api/me", { user: alice })).data;
  assert.equal(me.telegramLinked, true);
  ok("/start 토큰으로 DM 연결");

  // 웹훅 시크릿 검증
  const bad = await fetch(API + "/api/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wrong" }, body: "{}" });
  assert.equal(bad.status, 403);
  ok("웹훅 시크릿 불일치 → 403");

  // 5) 스테이션 WebSocket 접속 → 온라인, 모니터링 소켓에 presence 수신
  const viewerMsgs = [];
  const viewer = new WebSocket(`${API.replace("http", "ws")}/ws?role=viewer&siteId=${site.id}&userId=${alice.userId}&token=${alice.userToken}`);
  await new Promise((r) => (viewer.onopen = r));
  viewer.onmessage = (e) => viewerMsgs.push(JSON.parse(e.data));
  await wait(() => viewerMsgs.some((m) => m.t === "hello"));
  const stationWs = new WebSocket(`${API.replace("http", "ws")}/ws?role=station&stationId=${sA.stationId}&token=${sA.stationToken}`);
  await new Promise((r) => (stationWs.onopen = r));
  assert.ok(await wait(() => viewerMsgs.some((m) => m.t === "presence" && m.online && m.stationId === sA.stationId)));
  me = (await api("/api/me", { user: alice })).data;
  assert.equal(me.sites[0].stations.find((s) => s.id === sA.stationId).online, true);
  ok("스테이션 접속 → 온라인 표시 + 모니터링에 실시간 전달");

  // 6) 이벤트 → 알림 (구독자에게만) + 중복 방지
  calls.length = 0;
  const ev = (label, st = sA) =>
    api(`/api/stations/${st.stationId}/events`, { method: "POST", station: st.stationToken, body: { label, score: 0.8, image: JPEG } });
  const e1 = (await ev("no_helmet")).data;
  assert.equal(e1.alerted, true);
  await wait(() => calls.filter((c) => c.method === "sendPhoto").length >= 2);
  const photoChats = calls.filter((c) => c.method === "sendPhoto").map((c) => c.chat).sort();
  assert.deepEqual(photoChats, ["111", "222"]);
  ok("첫 위반 → 구독자 2명에게 사진 알림");

  const e2 = (await ev("no_helmet")).data;
  assert.equal(e2.alerted, false);
  ok("같은 위반 연속 → 알림 억제(1분 간격)");

  calls.length = 0;
  await ev("no_helmet", sB); // B는 alice만 구독
  await wait(() => calls.length >= 1);
  await sleep(300);
  assert.deepEqual(calls.filter((c) => c.method === "sendPhoto").map((c) => c.chat), ["111"]);
  ok("스테이션 B 위반 → 구독한 alice에게만 알림");

  assert.ok(viewerMsgs.some((m) => m.t === "event" && m.stationId === sA.stationId && m.alerted === true));
  ok("모니터링 소켓에 event 실시간 수신");

  // 7) 사진 조회
  const snap = await fetch(`${API}/api/stations/${sA.stationId}/snapshot?v=1`);
  assert.equal(snap.status, 200);
  assert.equal(snap.headers.get("content-type"), "image/jpeg");
  ok("마지막 감지 사진 조회");

  // 8) 오탐 신고 → 음소거
  calls.length = 0;
  await webhook({ callback_query: { id: "cb1", data: `fp:${e1.eventId}`, message: { message_id: 9, chat: { id: 111 } } } });
  await wait(() => calls.some((c) => c.method === "answerCallbackQuery"));
  assert.ok(await wait(() => viewerMsgs.some((m) => m.t === "muted" && m.stationId === sA.stationId)));
  ok("오탐 신고 콜백 → 음소거 + 알림");

  // 9) 그룹 연결 + 분당 제한 묶음
  const groupSite = (await api("/api/sites", { method: "POST", user: alice, body: { name: "그룹 테스트" } })).data.site;
  const sG = (await api("/api/stations", { method: "POST", body: { inviteCode: groupSite.inviteCode, name: "G1" } })).data;
  await webhook({ message: { chat: { id: -900, type: "group" }, text: "/link@argus_bot " + groupSite.inviteCode } });
  await sleep(500);
  calls.length = 0;
  const labels = ["no_helmet", "no_vest", "no_mask", "no_safety_glasses", "no_harness", "short_sleeve", "short_pants", "fire_smoke", "man_down", "zone_intrusion"];
  // 서로 다른 유형 10종 × 2회 = 서로 다른 (유형) 첫 알림 10건 → 그룹 15건 이내라 모두 전송
  for (const l of labels) await ev(l, sG);
  // 알림 발송은 응답 후 비동기(waitUntil)라 도착을 기다린다
  await wait(() => calls.filter((c) => c.chat === "-900" && c.method === "sendPhoto").length >= 10, 8000);
  await sleep(500); // 초과 발송이 없는지 확인
  const groupSends = calls.filter((c) => c.chat === "-900" && c.method === "sendPhoto").length;
  assert.equal(groupSends, 10);
  ok("그룹 /link 연결, 10건 모두 전송 (15건 한도 이내)");

  // 10) 스테이션 접속 종료 → 오프라인
  stationWs.close();
  assert.ok(await wait(() => viewerMsgs.some((m) => m.t === "presence" && m.online === false && m.stationId === sA.stationId)));
  ok("스테이션 접속 종료 → 오프라인 전달");

  // 11) 스테이션 삭제
  assert.equal((await api(`/api/stations/${sB.stationId}`, { method: "DELETE", station: "wrong" })).status, 401);
  assert.equal((await api(`/api/stations/${sB.stationId}`, { method: "DELETE", station: sB.stationToken })).status, 200);
  ok("스테이션 등록 해제 (잘못된 토큰은 거부)");

  // 12) 사이트 이름 변경 / 스테이션 삭제 / 사이트 삭제 (소유자만)
  me = (await api("/api/me", { user: alice })).data;
  assert.equal(me.sites.find((x) => x.id === site.id).canManage, true);
  me = (await api("/api/me", { user: bob })).data;
  assert.equal(me.sites.find((x) => x.id === site.id).canManage, false);
  ok("소유자만 canManage=true");

  assert.equal((await api(`/api/sites/${site.id}`, { method: "PUT", user: bob, body: { name: "해킹" } })).status, 403);
  assert.equal((await api(`/api/sites/${site.id}`, { method: "PUT", user: alice, body: { name: "새 이름" } })).status, 200);
  me = (await api("/api/me", { user: bob })).data;
  assert.equal(me.sites.find((x) => x.id === site.id).name, "새 이름");
  ok("이름 변경: 소유자만 가능, 다른 참여자 화면에도 반영");

  // 모니터링에서 스테이션 삭제 → 해당 기기에 removed 전달
  const sC = (await api("/api/stations", { method: "POST", body: { inviteCode: site.inviteCode, name: "삭제 대상" } })).data;
  const cWs = new WebSocket(`${API.replace("http", "ws")}/ws?role=station&stationId=${sC.stationId}&token=${sC.stationToken}`);
  const cMsgs = [];
  await new Promise((r) => (cWs.onopen = r));
  cWs.onmessage = (e) => cMsgs.push(e.data);
  const outsider = (await api("/api/users", { method: "POST" })).data;
  assert.equal((await api(`/api/stations/${sC.stationId}`, { method: "DELETE", user: outsider })).status, 403);
  assert.equal((await api(`/api/stations/${sC.stationId}`, { method: "DELETE", user: bob })).status, 200);
  assert.ok(await wait(() => cMsgs.some((m) => m.includes('"removed"'))));
  ok("참여자가 스테이션 삭제 → 기기에 removed 전달 (외부인은 403)");

  // 사이트 삭제: 소유자만, 스테이션·구독 함께 정리
  assert.equal((await api(`/api/sites/${site.id}`, { method: "DELETE", user: bob })).status, 403);
  const del = await api(`/api/sites/${site.id}`, { method: "DELETE", user: alice });
  assert.equal(del.status, 200);
  me = (await api("/api/me", { user: alice })).data;
  assert.equal(me.sites.some((x) => x.id === site.id), false);
  assert.equal((await api("/api/stations", { method: "POST", body: { inviteCode: site.inviteCode, name: "x" } })).status, 404);
  ok("사이트 삭제: 소유자만, 초대코드 무효화·연관 스테이션 정리");

  viewer.close();
  console.log(`\n통과 ${pass}건`);
} catch (e) {
  console.error("\n✗ 실패:", e);
  process.exitCode = 1;
} finally {
  mock.close();
  // 열린 WebSocket이 남아 있어도 프로세스가 끝나도록
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
