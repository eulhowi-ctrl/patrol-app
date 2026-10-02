// 브라우저 E2E: 스테이션 등록 → 온라인 표시 → 사진 → 테스트 알림(Telegram 모킹) → 라이브 → 오프라인
import http from "node:http";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const WEB = process.env.WEB ?? "http://localhost:3000";
const API = process.env.API ?? "http://127.0.0.1:8787";
const PROD = !!process.env.PROD; // 운영 서버 대상: Telegram 모킹/웹훅 단계 생략

const calls = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("latin1");
    calls.push({ method: req.url.split("/").pop(), raw });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});
if (!PROD) await new Promise((r) => mock.listen(8899, r));

const api = async (path, { method = "GET", body, user } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (user) {
    headers["x-user-id"] = user.userId;
    headers["x-user-token"] = user.userToken;
  }
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};
const log = (m) => console.log("  ✓", m);

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
let failed = false;
try {
  // 서버 준비: 사용자·사이트·텔레그램 연결·구독 (스테이션은 브라우저에서 등록)
  const user = await api("/api/users", { method: "POST" });
  const { site } = await api("/api/sites", { method: "POST", user, body: { name: "브라우저 테스트 발전소" } });
  const link = await api("/api/me/telegram-link", { method: "POST", user });
  if (!PROD) await fetch(API + "/api/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "s3cret" },
    body: JSON.stringify({ message: { chat: { id: 777, type: "private" }, text: "/start " + link.token } }),
  });

  // ── 스테이션 기기 ──
  const stCtx = await browser.newContext({ permissions: ["camera"], viewport: { width: 390, height: 780 } });
  const st = await stCtx.newPage();
  st.on("pageerror", (e) => console.log("  [station pageerror]", e.message));
  await st.goto(WEB);
  await st.getByText("스테이션으로 쓰기").click();
  await st.getByPlaceholder("예: K7M2QX").fill(site.inviteCode);
  await st.getByPlaceholder("예: 터빈동 1층 입구").fill("터빈동 1층");
  await st.getByRole("button", { name: "등록하고 시작" }).click();
  await st.waitForSelector(".st-top .st-dot.on", { timeout: 20000 });
  log("스테이션 등록 + 서버 WebSocket 연결(온라인)");

  // ── 모니터링 기기 ──
  const mCtx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await mCtx.addInitScript((u) => localStorage.setItem("argus-user-v1", JSON.stringify(u)), user);
  const mo = await mCtx.newPage();
  mo.on("pageerror", (e) => console.log("  [monitor pageerror]", e.message));
  await mo.goto(WEB);
  await mo.getByText("모니터링 보기").click();
  await mo.waitForSelector(".mt-tile", { timeout: 15000 });
  await mo.waitForSelector(".mt-tile .mt-dot.on", { timeout: 10000 });
  log("모니터링 분할화면에 스테이션 칸 + 초록 점");

  // 구독 설정 (설정 패널에서 체크)
  await mo.getByRole("button", { name: "설정", exact: true }).click();
  await mo.getByLabel("터빈동 1층").check();
  await mo.waitForTimeout(500);
  await mo.getByRole("button", { name: "닫기" }).click();
  log("설정 패널에서 스테이션 알림 구독");

  // 모델 로딩 후 사진 업로드(2.5초 뒤) → 칸에 사진
  await mo.waitForSelector(".mt-tile img", { timeout: 60000 });
  log("현재 모습 사진이 칸에 표시");

  // ── 테스트 알림 ──
  await st.getByRole("button", { name: "설정" }).click();
  calls.length = 0;
  await st.getByRole("button", { name: /테스트 알림/ }).click();
  await mo.waitForSelector(".mt-tile.alert", { timeout: 10000 });
  log("위반 보고 → 모니터링 칸이 실시간으로 빨간 경고");
  if (!PROD) {
    for (let i = 0; i < 40 && !calls.some((c) => c.method === "sendPhoto"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(calls.some((c) => c.method === "sendPhoto" && c.raw.includes("777")), "Telegram 사진 알림 미수신");
    log("구독자에게 Telegram 사진 알림 도착");
  }

  // ── 라이브 ──
  await mo.locator(".mt-tile").first().click();
  await mo.waitForSelector("img.lv-video", { timeout: 15000 });
  log("칸 탭 → 라이브(사진 프레임) 표시");
  await mo.screenshot({ path: "live.png" });
  await mo.getByRole("button", { name: "닫기" }).click();
  await mo.screenshot({ path: "monitor.png" });
  await st.screenshot({ path: "station.png" });

  // 확인 창(confirm/prompt)은 자동 수락
  mo.on("dialog", (d) => (d.type() === "prompt" ? d.accept("이름 바뀐 발전소") : d.accept()));

  // ── 모니터링에서 스테이션 삭제 → 그 기기는 등록 화면으로 돌아감 ──
  await mo.getByRole("button", { name: "설정", exact: true }).click();
  await mo.getByRole("button", { name: "삭제", exact: true }).click();
  await st.waitForSelector("text=스테이션 등록", { timeout: 15000 });
  log("모니터링에서 스테이션 삭제 → 해당 기기가 등록 화면으로 복귀");
  await mo.getByRole("button", { name: "닫기" }).click();
  await mo.waitForSelector("text=아직 등록된 스테이션이 없습니다", { timeout: 10000 });
  log("삭제된 스테이션 칸이 분할화면에서 사라짐");

  // ── 같은 기기로 다시 등록 → 온라인 ──
  await st.getByPlaceholder("예: K7M2QX").fill(site.inviteCode);
  await st.getByPlaceholder("예: 터빈동 1층 입구").fill("보일러동");
  await st.getByRole("button", { name: "등록하고 시작" }).click();
  await st.waitForSelector(".st-top .st-dot.on", { timeout: 20000 });
  await mo.waitForSelector(".mt-tile .mt-dot.on", { timeout: 15000 });
  log("같은 기기를 새 이름으로 재등록 → 다시 초록 점");

  // ── 스테이션 종료 → 오프라인 ──
  await stCtx.close();
  await mo.waitForSelector(".mt-tile .mt-dot.off", { timeout: 15000 });
  log("스테이션 종료 → 빨간 점");

  // ── 사이트 이름 변경 ──
  await mo.getByRole("button", { name: "설정", exact: true }).click();
  await mo.getByRole("button", { name: "이름 변경" }).click();
  await mo.waitForSelector("h4:has-text('이름 바뀐 발전소')", { timeout: 10000 });
  log("사이트 이름 변경");

  // ── 사이트 삭제 → 참여 사이트가 없으니 시작 화면 ──
  await mo.getByRole("button", { name: "모니터링 삭제" }).click();
  await mo.waitForSelector("text=모니터링 시작", { timeout: 10000 });
  log("모니터링 삭제 → 모니터링 시작 화면");
} catch (e) {
  failed = true;
  console.error("\n✗ 실패:", e.message);
} finally {
  await browser.close();
  if (!PROD) mock.close();
  if (failed) process.exitCode = 1;
  else console.log("\n브라우저 E2E 통과");
}
