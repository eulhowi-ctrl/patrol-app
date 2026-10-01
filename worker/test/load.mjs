// 부하 시뮬레이터: 가짜 스테이션 N대가 동시에 접속·보고할 때 서버가 버티는지 + 하루 요청량 추정.
// 사용: (빈 로컬 DB로 `npm run dev` 실행 후) node test/load.mjs [대수=30] [시간(초)=60]
// 주의: 서버가 MAX_STATIONS(기본 30)를 강제하므로, 31번째 등록은 거부되어야 한다.
const API = process.env.API ?? "http://127.0.0.1:8787";
const N = Number(process.argv[2] ?? 30);
const DURATION = Number(process.argv[3] ?? 60);
const JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const LABELS = ["no_helmet", "no_vest", "no_mask", "no_safety_glasses", "zone_intrusion"];

let requests = 0;
const lat = [];
let errors = 0;

async function req(path, { method = "GET", body, headers = {} } = {}) {
  const t = performance.now();
  requests++;
  try {
    const res = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    lat.push(performance.now() - t);
    if (!res.ok && res.status !== 403) errors++;
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    errors++;
    return { status: 0, data: null };
  }
}

const user = (await req("/api/users", { method: "POST" })).data;
const uh = { "x-user-id": user.userId, "x-user-token": user.userToken };
const { site } = (await req("/api/sites", { method: "POST", body: { name: "부하 테스트" }, headers: uh })).data;

// 1) 등록 — 30대까지 성공, 초과분은 403
const stations = [];
let rejected = 0;
for (let i = 0; i < N + 1; i++) {
  const r = await req("/api/stations", { method: "POST", body: { inviteCode: site.inviteCode, name: `S${i + 1}` } });
  if (r.status === 200) stations.push(r.data);
  else if (r.status === 403) rejected++;
}
console.log(`등록 성공 ${stations.length}대, 한도 초과 거부 ${rejected}건`);

// 2) 모니터링 3명이 사이트 소켓에 접속
const viewers = [];
let received = 0;
for (let i = 0; i < 3; i++) {
  const ws = new WebSocket(`${API.replace("http", "ws")}/ws?role=viewer&siteId=${site.id}&userId=${user.userId}&token=${user.userToken}`);
  ws.onmessage = () => received++;
  viewers.push(ws);
}

// 3) 스테이션 전원 접속
const sockets = stations.map((s) => {
  const ws = new WebSocket(`${API.replace("http", "ws")}/ws?role=station&stationId=${s.stationId}&token=${s.stationToken}`);
  return ws;
});
await new Promise((r) => setTimeout(r, 2000));
const opened = sockets.filter((s) => s.readyState === 1).length;
console.log(`WebSocket 동시 접속 ${opened}/${stations.length}`);

// 4) 시간 압축 시뮬레이션: 실제 스테이션은 하루 약 50건 위반 + 144건 사진 갱신.
//    여기서는 DURATION초 동안 스테이션마다 5초에 1건씩 위반 + 시작 시 사진 1장을 보낸다.
requests = 0;
lat.length = 0;
const start = Date.now();
await Promise.all(
  stations.map(async (s, idx) => {
    const h = { "x-station-token": s.stationToken };
    await req(`/api/stations/${s.stationId}/snapshot`, { method: "PUT", body: { image: JPEG }, headers: h });
    while (Date.now() - start < DURATION * 1000) {
      const label = LABELS[Math.floor(Math.random() * LABELS.length)];
      await req(`/api/stations/${s.stationId}/events`, { method: "POST", body: { label, score: 0.8, image: JPEG }, headers: h });
      await new Promise((r) => setTimeout(r, 5000 + idx * 20));
    }
  })
);

lat.sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))].toFixed(0);
console.log(`\n${DURATION}초 동안 요청 ${requests}건, 오류 ${errors}건, 지연 p50 ${p(0.5)}ms / p95 ${p(0.95)}ms / 최대 ${lat[lat.length - 1].toFixed(0)}ms`);
console.log(`모니터링 3명이 받은 실시간 메시지 ${received}건`);

// 5) 하루 요청량 추정 (실제 사용 패턴: 위반 50건 + 사진 갱신 144건 + 접속 재연결 소량)
const perStationPerDay = 50 + 144 + 10;
const total = perStationPerDay * stations.length;
console.log(`\n[추정] 스테이션 ${stations.length}대 하루 요청 약 ${total}건 (무료 한도 100,000건의 ${((total / 100000) * 100).toFixed(1)}%)`);
console.log(`[추정] D1 쓰기 약 ${total * 3}행 (무료 한도 100,000행의 ${(((total * 3) / 100000) * 100).toFixed(1)}%, 이벤트당 약 3행)`);

// 정리: 테스트용 스테이션 등록 해제 (운영 서버에서 실행해도 30개 한도를 차지하지 않도록)
await Promise.all(stations.map((s) => req(`/api/stations/${s.stationId}`, { method: "DELETE", headers: { "x-station-token": s.stationToken } })));

sockets.forEach((s) => s.close());
viewers.forEach((v) => v.close());
process.exit(errors ? 1 : 0);
