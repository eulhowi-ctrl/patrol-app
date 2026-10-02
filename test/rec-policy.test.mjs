// 녹화 보관 규칙 테스트 (web/src/lib/recPolicy.ts) — 실행: node test/rec-policy.test.mjs (web/node_modules 필요)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const ts = createRequire(join(here, "../web/package.json"))("typescript");
const out = join(mkdtempSync(join(tmpdir(), "recpolicy-")), "recPolicy.mjs");
writeFileSync(out, ts.transpileModule(readFileSync(join(here, "../web/src/lib/recPolicy.ts"), "utf8"), { compilerOptions: { target: "es2020", module: "esnext" } }).outputText);
const { partsToDelete, partsToFree, mergeRanges, findPart, DEFAULT_REC } = await import(pathToFileURL(out).href);
const M = 60_000, H = 3600_000;
const cfg = { unitMs: 5 * M, keepMs: 24 * H, partMs: M };
let pass = 0; const ok = (m) => { pass++; console.log("  ✓", m); };

// 1) 30시간 연속 녹화 시뮬레이션: 1분마다 조각 추가 + 정리. 매 순간 보존량 확인
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0) + 37_000; // 묶음 경계와 어긋난 시작
let parts = [];
let minKept = Infinity, maxKept = 0;
for (let t = T0; t <= T0 + 30 * H; t += M) {
  // 직전 1분 조각 완성
  if (t > T0) parts.push({ start: t - M, end: t - 200, mime: "video/webm", bytes: 2_250_000, done: true });
  const del = new Set(partsToDelete(parts, t, cfg));
  parts = parts.filter((p) => !del.has(p.start));
  if (t - T0 >= 24 * H + 10 * M && parts.length) {
    const kept = t - parts[0].start;
    minKept = Math.min(minKept, kept); maxKept = Math.max(maxKept, kept);
  }
}
assert.ok(minKept >= 24 * H, `최소 보존 ${minKept / M}분`);
assert.ok(maxKept <= 24 * H + 5 * M + 2 * M, `최대 보존 ${maxKept / M}분`);
ok(`30시간 연속 녹화: 항상 ${(minKept / H).toFixed(2)}~${(maxKept / H).toFixed(2)}시간 보존 (24h 이상, 24h+7분 이하)`);
const units = new Set(parts.map((p) => Math.floor(p.start / cfg.unitMs)));
assert.ok(parts.length <= 24 * 60 + 7 && parts.length >= 24 * 60 - 1, `조각 수 ${parts.length}`);
ok(`남은 조각 ${parts.length}개(1분), 묶음 ${units.size}개(5분) ≈ 24시간치`);

// 2) 경계: 묶음 마지막 조각이 cutoff보다 1ms 늦게 끝나면 묶음 전체 유지
const now = 100 * H;
const u = Math.floor((now - 24 * H) / cfg.unitMs) * cfg.unitMs; // cutoff가 속한 묶음
const sameUnit = [
  { start: u, end: u + M, bytes: 1, done: true },
  { start: u + M, end: now - 24 * H + 1, bytes: 1, done: true },
];
assert.deepEqual(partsToDelete(sameUnit, now, cfg), []);
ok("묶음 안 마지막 조각이 아직 24시간 안이면 앞 조각도 같이 유지");
const u2 = u - cfg.unitMs; // cutoff 이전 묶음
const oldUnit = [
  { start: u2, end: u2 + M, bytes: 1, done: true },
  { start: u2 + M, end: now - 24 * H - 1, bytes: 1, done: true },
];
assert.equal(partsToDelete(oldUnit, now, cfg).length, 2);
ok("묶음 전체가 24시간을 넘기면 함께 삭제");

// 3) 저장 공간 부족: 오래된 묶음부터, 녹화 중 묶음은 제외
const ps = [0, 1, 2, 3, 4, 5].map((i) => ({ start: i * 5 * M, end: i * 5 * M + 4 * M, bytes: 100, done: i < 5 }));
const freed = partsToFree(ps, 600, 350, cfg.unitMs);
assert.deepEqual(freed, [0, 5 * M, 10 * M]);
assert.deepEqual(partsToFree(ps, 600, 0, cfg.unitMs).includes(25 * M), false);
ok("공간 부족 시 가장 오래된 묶음부터 삭제, 녹화 중인 묶음은 보호");

// 4) 막대 구간 합치기 / 시각 찾기
assert.deepEqual(mergeRanges([{ start: 0, end: 59_800 }, { start: 60_000, end: 119_800 }, { start: 300_000, end: 360_000 }]), [[0, 119_800], [300_000, 360_000]]);
ok("이어진 조각은 한 구간, 끊긴 곳은 따로 표시");
const fp = [{ start: 0, end: 60_000 }, { start: 60_000, end: 120_000 }, { start: 300_000, end: 360_000 }];
assert.equal(findPart(fp, 90_000).start, 60_000);
assert.equal(findPart(fp, 200_000).start, 300_000);
assert.equal(findPart(fp, 400_000), null);
ok("시각으로 조각 찾기: 안에 있으면 그 조각, 빈 구간이면 다음 조각, 끝 이후면 없음");

// 5) 숫자 재계산: 360p 0.3Mbps
const perMin = DEFAULT_REC.bitrate / 8 * 60, perDay = perMin * 60 * 24;
console.log(`  · 1분 조각 ≈ ${(perMin / 1e6).toFixed(2)}MB, 5분 묶음 ≈ ${(perMin * 5 / 1e6).toFixed(1)}MB, 24시간 ≈ ${(perDay / 1e9).toFixed(2)}GB, 3배속 전송 ≈ ${(DEFAULT_REC.bitrate * 3 / 1e6).toFixed(1)}Mbps`);
console.log(`\n통과 ${pass}건`);
