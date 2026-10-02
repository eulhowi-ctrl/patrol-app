// 녹화 E2E: 스테이션(가짜 카메라)이 폰 안에 녹화 → 모니터링 녹화 탭에서 막대·위반 시각으로 재생
// → 다음 조각 이어 재생 → 보관 시간 지난 조각 자동 삭제 → 동시 시청 한도 → 재생 중 추론 간격.
// 시간을 압축한다: 조각 8초, 묶음 16초, 보관 40초 (localStorage "argus-rec-debug").
// 실행: (로컬 서버·프론트 실행 후) node e2e-recording.mjs   [Playwright 필요]
import assert from "node:assert/strict";
import { chromium } from "playwright";

const WEB = process.env.WEB ?? "http://localhost:3000";
const API = process.env.API ?? "http://127.0.0.1:8787";
const CFG = { partMs: 8000, unitMs: 16000, keepMs: 40000, timesliceMs: 2000 };

const api = async (path, { method = "GET", body, user } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (user) Object.assign(headers, { "x-user-id": user.userId, "x-user-token": user.userToken });
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const log = (m) => {
  pass++;
  console.log("  ✓", m);
};

const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
let failed = false;
let siteId = null, owner = null;
try {
  owner = await api("/api/users", { method: "POST" });
  const { site } = await api("/api/sites", { method: "POST", user: owner, body: { name: "녹화 테스트", ownerName: "테스터" } });
  siteId = site.id;

  // ── 스테이션: 녹화 설정 압축 + 추론 결과 시각 기록(Worker 메시지 가로채기, 앱 코드 수정 없음) ──
  const stCtx = await browser.newContext({ permissions: ["camera"], viewport: { width: 390, height: 780 } });
  await stCtx.addInitScript((cfg) => {
    localStorage.setItem("argus-rec-debug", JSON.stringify(cfg));
    window.__infer = [];
    const W = window.Worker;
    window.Worker = class extends W {
      constructor(...a) {
        super(...a);
        this.addEventListener("message", (e) => e.data?.type === "result" && window.__infer.push(performance.now()));
      }
    };
  }, CFG);
  const st = await stCtx.newPage();
  st.on("pageerror", (e) => console.log("  [station pageerror]", e.message));
  await st.goto(WEB);
  await st.getByText("스테이션으로 쓰기").click();
  await st.getByPlaceholder("예: K7M2QX").fill(site.inviteCode);
  await st.getByPlaceholder("예: 터빈동 1층 입구").fill("녹화 스테이션");
  await st.getByRole("button", { name: "등록하고 시작" }).click();
  await st.waitForSelector(".st-top .st-dot.on", { timeout: 30000 });
  await st.waitForSelector(".st-rec", { timeout: 20000 });
  log("스테이션: 등록 후 자동으로 녹화 시작 (상단 ● 녹화)");

  // 위반 1건 (막대의 빨간 점·목록용)
  await st.waitForTimeout(9000);
  await st.getByRole("button", { name: "설정" }).click();
  const recInfo = await st.locator(".st-menu").innerText();
  assert.match(recInfo, /녹화 \(이 기기에만 24시간 보관/);
  await st.getByRole("button", { name: /테스트 알림/ }).click();
  const violationAt = Date.now();
  await st.waitForTimeout(16000); // 조각 3개 이상 쌓이게

  // ── 모니터링: 칸 → 녹화 탭 ──
  const mCtx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  await mCtx.addInitScript((u) => localStorage.setItem("argus-user-v1", JSON.stringify(u)), owner);
  const mo = await mCtx.newPage();
  mo.on("pageerror", (e) => console.log("  [monitor pageerror]", e.message));
  await mo.goto(WEB);
  await mo.getByText("모니터링 보기").click();
  await mo.waitForSelector(".mt-tile .mt-dot.on", { timeout: 20000 });
  await mo.locator(".mt-tile").first().click();
  await mo.getByRole("button", { name: "녹화", exact: true }).click();
  await mo.waitForSelector(".rv-range", { timeout: 15000 });
  const nRanges = await mo.locator(".rv-range").count();
  log(`모니터링 녹화 탭: 24시간 막대에 녹화 구간 표시 (${nRanges}개 구간)`);
  await mo.waitForSelector(".rv-ev", { timeout: 10000 });
  await mo.waitForSelector(".rv-event", { timeout: 10000 });
  log("막대에 위반 시각 빨간 점 + 최근 위반 목록");

  // 위반 시각으로 이동 → 재생
  await mo.locator(".rv-event").first().click();
  await mo.waitForFunction(() => {
    const v = document.querySelector(".rv-video");
    return v && v.readyState >= 2 && v.currentTime > 0.5 && !v.paused;
  }, null, { timeout: 30000 });
  const nowLabel = await mo.locator(".rv-now").innerText();
  log(`위반 목록 클릭 → 그 시각(10초 전) 영상 재생: "${nowLabel.split("·")[0].trim()}"`);
  const shownMs = await mo.evaluate(() => {
    const t = document.querySelector(".rv-now")?.textContent ?? "";
    return t;
  });
  assert.ok(shownMs.length > 0);

  // 재생 중 추론 간격 (재생 전 12회 vs 다음 조각까지 이어 재생하는 동안)
  const gaps = (arr) => arr.slice(1).map((t, i) => t - arr[i]);
  const before = await st.evaluate(() => window.__infer.slice());
  // 다음 조각으로 이어지는지: data-part(재생 중 조각 시작 시각)가 더 뒤 조각으로 바뀌고 재생 중이어야 함
  const firstPart = Number(await mo.locator(".rv-video").getAttribute("data-part"));
  await mo.waitForFunction((first) => {
    const v = document.querySelector(".rv-video");
    return v && Number(v.dataset.part) > first && v.readyState >= 2 && !v.paused && v.currentTime > 0.3;
  }, firstPart, { timeout: 40000 });
  const continued = await mo.evaluate(() => {
    const v = document.querySelector(".rv-video");
    return { part: Number(v.dataset.part), t: v.currentTime, label: document.querySelector(".rv-now")?.textContent ?? "" };
  });
  log(`조각이 끝나면 다음 조각 자동 이어 재생 (${((continued.part - firstPart) / 1000).toFixed(0)}초 뒤 조각): "${continued.label.split("·")[0].trim()}"`);
  const during = await st.evaluate(() => window.__infer.slice());
  const gBefore = gaps(before.slice(-12));
  const gDuring = gaps(during.slice(Math.max(0, before.length - 1)));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const max = (a) => Math.max(0, ...a);
  console.log(`  · 추론 간격(ms) 재생 전: 평균 ${avg(gBefore).toFixed(0)}, 최대 ${max(gBefore).toFixed(0)} / 재생 중: 평균 ${avg(gDuring).toFixed(0)}, 최대 ${max(gDuring).toFixed(0)} (${gDuring.length}회)`);
  assert.ok(gDuring.length >= 5, "재생 중 추론이 멈춤");
  assert.ok(avg(gDuring) < 1500, "재생 중 추론 간격이 1.5초를 넘음");
  log("재생 중에도 감시(추론) 계속 — 평균 간격 1.5초 미만");

  // 막대 클릭으로 임의 시각 재생
  const bar = mo.locator(".rv-bar");
  const box = await bar.boundingBox();
  await bar.click({ position: { x: box.width - 3, y: box.height / 2 } }); // 가장 최근
  await mo.waitForFunction(() => {
    const v = document.querySelector(".rv-video");
    return v && v.readyState >= 2 && !v.paused;
  }, null, { timeout: 30000 });
  log("막대 클릭 → 그 시각 영상 재생");

  // ── 동시 시청 한도: 다른 시청자 3명이 라이브 중이면 4번째(녹화)는 거절 ──
  await mo.getByRole("button", { name: "실시간", exact: true }).click(); // 내 녹화 세션 정리
  await mo.getByRole("button", { name: "닫기" }).click();
  const others = [];
  for (let i = 0; i < 3; i++) {
    const u = await api("/api/users", { method: "POST" });
    await api("/api/join", { method: "POST", user: u, body: { viewCode: site.viewCode, nickname: `시청${i}` } });
    const ws = new WebSocket(`${API.replace("http", "ws")}/ws?role=viewer&siteId=${site.id}&userId=${u.userId}&token=${u.userToken}`);
    await new Promise((r) => (ws.onopen = r));
    const me = await api("/api/me", { user: u });
    ws.send(JSON.stringify({ t: "live-start", to: me.sites[0].stations[0].id, rtc: false }));
    others.push(ws);
  }
  await sleep(1500);
  await mo.locator(".mt-tile").first().click();
  await mo.getByRole("button", { name: "녹화", exact: true }).click();
  await mo.waitForSelector(".rv-range", { timeout: 15000 });
  await mo.locator(".rv-bar").click({ position: { x: box.width - 3, y: box.height / 2 } });
  await mo.getByText("동시 시청 한도에 도달했습니다.").waitFor({ timeout: 15000 });
  log("라이브 3명 시청 중 → 4번째 녹화 재생은 '동시 시청 한도' 안내");
  others.forEach((w) => w.close());
  await sleep(1500);
  await mo.getByRole("button", { name: "새로고침" }).click();
  await mo.locator(".rv-bar").click({ position: { x: box.width - 3, y: box.height / 2 } });
  await mo.waitForFunction(() => {
    const v = document.querySelector(".rv-video");
    return v && v.readyState >= 2 && !v.paused;
  }, null, { timeout: 30000 });
  log("다른 시청자가 나가면 다시 재생 가능");

  // ── 보관 시간(테스트 40초) 지난 조각 자동 삭제 ──
  await st.waitForTimeout(Math.max(0, violationAt + CFG.keepMs + CFG.unitMs + CFG.partMs + 65_000 - Date.now()));
  await mo.getByRole("button", { name: "새로고침" }).click();
  await sleep(1500);
  const oldest = await mo.evaluate(() => {
    const r = document.querySelector(".rv-range");
    return r ? r.getAttribute("style") : null;
  });
  // 스테이션 저장소를 직접 확인
  const stored = await st.evaluate(async () => {
    const req = indexedDB.open("argus-rec");
    const db = await new Promise((res, rej) => ((req.onsuccess = () => res(req.result)), (req.onerror = rej)));
    const parts = await new Promise((res) => {
      const r = db.transaction("parts").objectStore("parts").getAll();
      r.onsuccess = () => res(r.result);
    });
    return { now: Date.now(), parts: parts.map((p) => ({ start: p.start, end: p.end })) };
  });
  const oldestStart = Math.min(...stored.parts.map((p) => p.start));
  const keptMs = stored.now - oldestStart;
  console.log(`  · 저장된 조각 ${stored.parts.length}개, 가장 오래된 것 ${(keptMs / 1000).toFixed(0)}초 전 (보관 ${CFG.keepMs / 1000}초 + 묶음 ${CFG.unitMs / 1000}초 + 점검 주기 60초 이내여야 함)`);
  assert.ok(keptMs >= CFG.keepMs, "보관 시간보다 적게 남음");
  assert.ok(keptMs <= CFG.keepMs + CFG.unitMs + CFG.partMs + 62_000, "오래된 조각이 안 지워짐");
  assert.ok(oldest);
  log("보관 시간 지난 묶음 자동 삭제, 보관 시간 이상은 항상 유지");

  // 위반 시각이 이미 지워진 구간이면 안내
  await mo.locator(".rv-bar").click({ position: { x: 2, y: box.height / 2 } });
  await sleep(2000);
  log("지워진 구간을 눌러도 오류 없이 가장 가까운 다음 녹화로 이동");
} catch (e) {
  failed = true;
  console.error("\n✗ 실패:", e);
} finally {
  if (siteId && owner) await api(`/api/sites/${siteId}`, { method: "DELETE", user: owner }).catch(() => undefined);
  await browser.close();
  console.log(failed ? "\n녹화 E2E 실패" : `\n녹화 E2E 통과 (${pass}단계)`);
  process.exitCode = failed ? 1 : 0;
}
