/**
 * test-harness.ts
 *
 * 브라우저를 띄우지 않고 CLI(ts-node)에서 다음 파이프라인을 검증한다.
 *   [가상 카메라 프레임 주입 → 온디바이스 감지(Mock) → IndexedDB 저장
 *    → 오프라인 상태에서 동기화 실패 → 온라인 전환 → Bulk Sync 성공]
 *
 * 실제 브라우저 전용 API(getUserMedia, Web Worker, ONNX Runtime Web)는
 * Node 환경에 존재하지 않으므로, "카메라+모델 추론" 단계만 모의(mock) 감지 결과로
 * 대체하고, 그 이후의 실제 프로덕션 코드(IndexedDB 저장/동기화 로직)는
 * web/src/lib 의 실제 모듈을 그대로 import해 검증한다.
 */

// IndexedDB가 없는 Node 환경에 폴리필을 주입한다. 반드시 db.ts import 이전에 실행되어야 한다.
import "fake-indexeddb/auto";

import {
  saveDetection,
  getUnsyncedDetections,
  countPending,
} from "../web/src/lib/db";
import { bulkSync } from "../web/src/lib/sync";
import type { DetectionBox } from "../web/src/lib/labels";

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passCount++;
    console.log(`  [PASS] ${message}`);
  } else {
    failCount++;
    console.error(`  [FAIL] ${message}`);
  }
}

function mockSnapshot(label: string): string {
  return `data:image/jpeg;base64,MOCK_${label}_SNAPSHOT`;
}

/** 가상 카메라 스트림이 특정 위험 상황을 포착했다고 가정한 감지 결과 */
const VIRTUAL_CAMERA_SCENARIOS: { name: string; boxes: DetectionBox[] }[] = [
  {
    name: "보호구 미착용 인원 포착",
    boxes: [
      { label: "no_helmet", score: 0.91, x: 10, y: 20, width: 80, height: 160 },
    ],
  },
  {
    name: "화재/불꽃 징후 포착",
    boxes: [
      { label: "fire_smoke", score: 0.87, x: 50, y: 40, width: 200, height: 150 },
    ],
  },
  {
    name: "작업자 쓰러짐(Man-Down) 포착",
    boxes: [
      { label: "man_down", score: 0.95, x: 30, y: 200, width: 220, height: 90 },
    ],
  },
];

interface FetchCall {
  url: string;
  body: unknown;
}

function installFetchMock(shouldSucceed: boolean, calls: FetchCall[]) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string,
    opts?: RequestInit
  ) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body as string) : null });
    if (!shouldSucceed) {
      return { ok: false, status: 503 } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ received: calls.length }),
    } as unknown as Response;
  }) as typeof fetch;
}

async function main() {
  console.log("=== 1단계: 가상 카메라 감지 → IndexedDB 저장 ===");
  for (const scenario of VIRTUAL_CAMERA_SCENARIOS) {
    const id = await saveDetection({
      capturedAt: new Date().toISOString(),
      labels: scenario.boxes,
      snapshotBase64: mockSnapshot(scenario.boxes[0].label),
    });
    assert(typeof id === "number", `"${scenario.name}" 저장 성공 (id=${id})`);
  }

  const pendingAfterCapture = await countPending();
  assert(
    pendingAfterCapture === VIRTUAL_CAMERA_SCENARIOS.length,
    `저장된 미동기화 레코드 수가 ${VIRTUAL_CAMERA_SCENARIOS.length}건과 일치 (실제 ${pendingAfterCapture}건)`
  );

  console.log("\n=== 2단계: 오프라인(지하/터널) 상태 - 동기화 시도 실패 ===");
  const offlineCalls: FetchCall[] = [];
  installFetchMock(false, offlineCalls);
  const offlineResult = await bulkSync();
  assert(offlineCalls.length > 0, "오프라인 상태에서도 동기화 시도는 발생함");
  assert(
    offlineResult.succeeded === 0 && offlineResult.attempted === VIRTUAL_CAMERA_SCENARIOS.length,
    `오프라인 동기화 실패 확인 (attempted=${offlineResult.attempted}, succeeded=${offlineResult.succeeded})`
  );

  const pendingAfterOffline = await countPending();
  assert(
    pendingAfterOffline === VIRTUAL_CAMERA_SCENARIOS.length,
    "오프라인 실패 후에도 레코드가 유실되지 않고 큐에 남아있음"
  );

  console.log("\n=== 3단계: 온라인 복귀 - Bulk Sync 성공 ===");
  const onlineCalls: FetchCall[] = [];
  installFetchMock(true, onlineCalls);
  const onlineResult = await bulkSync();
  assert(onlineCalls.length === 1, "온라인 전환 시 단일 요청으로 일괄(Bulk) 전송됨");
  assert(
    Array.isArray((onlineCalls[0].body as { detections: unknown[] }).detections) &&
      (onlineCalls[0].body as { detections: unknown[] }).detections.length ===
        VIRTUAL_CAMERA_SCENARIOS.length,
    "전송된 payload에 대기 중이던 모든 감지 레코드가 포함됨"
  );
  assert(
    onlineResult.succeeded === VIRTUAL_CAMERA_SCENARIOS.length,
    `온라인 동기화 성공 (succeeded=${onlineResult.succeeded})`
  );

  const pendingAfterSync = await countPending();
  assert(pendingAfterSync === 0, "동기화 완료 후 미동기화 큐가 비워짐");

  const remaining = await getUnsyncedDetections();
  assert(remaining.length === 0, "getUnsyncedDetections()가 빈 배열을 반환함");

  console.log(`\n=== 결과: ${passCount}건 통과 / ${failCount}건 실패 ===`);
  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[test-harness] 처리되지 않은 예외 발생:", err);
  process.exitCode = 1;
});
