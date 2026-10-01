// 스테이션 클라이언트 로직 단위 테스트: 오탐 방지(연속 감지) + 위험구역 판정
// 실행: cd web && npx esbuild ... 를 쓰므로 web/ 에서 `node ../test/station-logic-test.mjs`
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const tmp = path.resolve(".next-test-tmp");
fs.mkdirSync(tmp, { recursive: true });
for (const f of ["violationTracker", "zone"]) {
  execSync(`npx esbuild src/lib/${f}.ts --format=esm --outfile="${tmp}/${f}.mjs" --log-level=error`, { stdio: "inherit" });
}
const { ViolationTracker, PERSIST_MS, REPORT_INTERVAL_MS } = await import(pathToFileURL(`${tmp}/violationTracker.mjs`).href);
const { pointInPolygon, personInZone, isZoneActive } = await import(pathToFileURL(`${tmp}/zone.mjs`).href);

// 1) 한두 프레임 스치는 감지는 보고하지 않는다
let t = new ViolationTracker();
assert.deepEqual(t.update(["no_helmet"], 0), []);
assert.deepEqual(t.update([], 1000), []);
assert.deepEqual(t.update([], 3500), []); // 공백이 GRACE(2s) 초과 → 해소
assert.deepEqual(t.update(["no_helmet"], 4000), []);
console.log("  ✓ 순간 오탐은 보고하지 않음");

// 2) 3초 이상 연속이면 보고, 이후 15초 간격
t = new ViolationTracker();
const reported = [];
for (let ms = 0; ms <= 40000; ms += 1000) {
  if (t.update(["no_vest"], ms).length) reported.push(ms);
}
assert.deepEqual(reported.slice(0, 3), [PERSIST_MS, PERSIST_MS + REPORT_INTERVAL_MS, PERSIST_MS + 2 * REPORT_INTERVAL_MS]);
console.log("  ✓ 3초 연속 후 보고, 이후 15초 간격:", reported.join(", "), "ms");

// 3) 추론이 1~2프레임 놓쳐도(공백 ≤2초) 같은 위반으로 이어진다
t = new ViolationTracker();
t.update(["no_mask"], 0);
t.update(["no_mask"], 1000);
t.update([], 2000);
assert.deepEqual(t.update(["no_mask"], 3000), ["no_mask"]);
console.log("  ✓ 짧은 감지 공백은 연속으로 처리");

// 4) 위험구역
const square = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }];
assert.equal(pointInPolygon({ x: 0.5, y: 0.5 }, square), true);
assert.equal(pointInPolygon({ x: 0.9, y: 0.5 }, square), false);
const zone = { points: square, expiresAt: Date.now() + 60000 };
const frame = { width: 1000, height: 1000 };
assert.equal(personInZone({ x: 400, y: 300, width: 100, height: 300 }, frame, zone), true); // 구역 안
assert.equal(personInZone({ x: 850, y: 300, width: 100, height: 300 }, frame, zone), false); // 구역 밖
// 발은 구역 밖이지만 몸 중심이 걸친 경우
assert.equal(personInZone({ x: 400, y: 600, width: 100, height: 300 }, frame, zone), true);
console.log("  ✓ 위험구역 진입 판정 (구역 안/밖/걸침)");

// 5) 자동 만료
assert.equal(isZoneActive({ points: square, expiresAt: Date.now() - 1 }), false);
assert.equal(isZoneActive({ points: square.slice(0, 2), expiresAt: Date.now() + 1000 }), false);
console.log("  ✓ 구역 자동 만료 · 꼭짓점 3개 미만은 무효");

fs.rmSync(tmp, { recursive: true, force: true });
