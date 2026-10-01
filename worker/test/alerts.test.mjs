// 중복 방지 단계 로직 단위 테스트 (esbuild로 TS를 즉석 변환해서 import)
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const out = path.resolve(".wrangler/alerts.test.mjs");
execSync(`npx esbuild src/alerts.ts --format=esm --outfile="${out}" --log-level=error`, { stdio: "inherit" });
const { decideAlert, decideGroup, RESET_GAP_SEC } = await import(pathToFileURL(out).href);

// 일반 위반: 연속 구간 동안 이벤트가 10초마다 계속 온다고 가정
let st = null;
const sent = [];
for (let t = 0; t <= 4000; t += 10) {
  const d = decideAlert(st, t, false);
  st = d.next;
  if (d.send) sent.push(t);
}
// 즉시(0) → +60 → +300 → +1800 (이후 1800 간격 유지)
assert.deepEqual(sent.slice(0, 4), [0, 60, 360, 2160]);
console.log("  ✓ 일반 위반 알림 시점", sent.slice(0, 4).join(", "), "초");

// 고위험은 더 촘촘
st = null;
const hi = [];
for (let t = 0; t <= 300; t += 10) {
  const d = decideAlert(st, t, true);
  st = d.next;
  if (d.send) hi.push(t);
}
assert.deepEqual(hi.slice(0, 4), [0, 30, 90, 210]);
console.log("  ✓ 고위험 알림 시점", hi.slice(0, 4).join(", "), "초");

// 이벤트가 끊겼다가(해소) 재발하면 새 알림
let d = decideAlert(null, 0, false);
d = decideAlert(d.next, 10, false);
assert.equal(d.send, false);
d = decideAlert(d.next, 10 + RESET_GAP_SEC + 1, false);
assert.equal(d.send, true);
console.log("  ✓ 해소 후 재발 → 즉시 알림");

// 음소거 중에는 보내지 않는다
d = decideAlert({ lastEventAt: 0, lastSentAt: 0, level: 0, mutedUntil: 3600 }, 100, true);
assert.equal(d.send, false);
d = decideAlert({ ...d.next, mutedUntil: 3600 }, 3700, true);
assert.equal(d.send, true);
console.log("  ✓ 오탐 음소거 1시간 동안 억제, 이후 재개");

// 그룹: 한 창에 15건까지, 이후 묶음 → 다음 창 첫 알림 때 요약
let w = { windowStart: 0, windowCount: 0, suppressed: 0 };
let sentG = 0;
for (let i = 0; i < 20; i++) {
  const g = decideGroup(w, 5);
  w = g.next;
  if (g.send) sentG++;
}
assert.equal(sentG, 15);
assert.equal(w.suppressed, 5);
const nxt = decideGroup(w, 70);
assert.equal(nxt.summarize, 5);
assert.equal(nxt.send, true);
console.log("  ✓ 그룹 분당 15건 제한 + 다음 창에서 5건 요약");
