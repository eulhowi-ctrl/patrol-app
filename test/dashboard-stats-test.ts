/**
 * dashboard-stats-test.ts
 *
 * 대시보드 집계 로직(web/src/lib/dashboardStats.ts, kstDate.ts)에 대한 순수 함수 테스트.
 * IndexedDB를 거치지 않고 DetectionRecord 배열을 직접 만들어 검증한다.
 *
 * 특히 다음 두 가지 과거 버그의 회귀를 막는 데 집중한다:
 *   1) "오늘" 날짜 경계가 UTC 기준이라 KST 자정과 어긋나던 문제 (kstDateKey/kstHour)
 *   2) 위반 유형 색상이 등장 순서로 배정돼 날짜마다 바뀌던 문제 (tallyByType 색상 고정)
 */
import { kstDateKey, kstHour } from "../web/src/lib/kstDate";
import {
  tallyByType,
  toDonutData,
  isHighPriorityRecord,
  filterByKstDay,
  buildDailyTrend,
} from "../web/src/lib/dashboardStats";
import type { DetectionRecord } from "../web/src/lib/db";
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

function mkBox(label: DetectionBox["label"]): DetectionBox {
  return { label, score: 0.9, x: 0, y: 0, width: 10, height: 10 };
}

function mkRecord(
  capturedAt: string,
  labels: DetectionBox["label"][],
  clothingViolations: string[] = []
): DetectionRecord {
  return {
    capturedAt,
    labels: labels.map(mkBox),
    snapshotBase64: "",
    synced: false,
    clothingViolations,
  };
}

function main() {
  console.log("=== KST 날짜/시간 경계 ===");
  // UTC 16:30 = KST(UTC+9) 다음날 01:30 — UTC 기준 slice(0,10)이었다면 하루 전 날짜로 잘못 계산됐다.
  assert(kstDateKey("2026-08-20T16:30:00.000Z") === "2026-08-21", "UTC 심야 시각이 KST로는 다음날 날짜로 계산됨");
  assert(kstHour("2026-08-20T16:30:00.000Z") === 1, "같은 시각의 KST 시(hour)는 새벽 1시");
  // UTC 03:00 = KST 정오 — 같은 UTC 날짜 안에서도 KST 기준 시각으로 정확히 변환되는지 확인.
  assert(kstDateKey("2026-08-20T03:00:00.000Z") === "2026-08-20", "UTC 낮 시각은 KST로도 같은 날짜");
  assert(kstHour("2026-08-20T03:00:00.000Z") === 12, "같은 시각의 KST 시(hour)는 낮 12시");

  console.log("\n=== filterByKstDay — 자정 근처 레코드가 올바른 KST 날짜로 분류되는지 ===");
  const midnightRecords = [
    mkRecord("2026-08-20T14:59:00.000Z", ["no_helmet"]), // KST 23:59 (8/20)
    mkRecord("2026-08-20T15:00:00.000Z", ["no_vest"]), // KST 00:00 (8/21) — UTC 날짜는 아직 8/20
  ];
  assert(
    filterByKstDay(midnightRecords, "2026-08-20").length === 1,
    "KST 8/20 23:59 레코드만 8/20 버킷에 포함됨"
  );
  assert(
    filterByKstDay(midnightRecords, "2026-08-21").length === 1,
    "UTC 날짜로는 아직 8/20이지만 KST로는 8/21인 레코드가 8/21 버킷에 포함됨"
  );

  console.log("\n=== isHighPriorityRecord ===");
  assert(isHighPriorityRecord(mkRecord("2026-08-20T03:00:00.000Z", ["fire_smoke"])), "화재/연기는 고위험으로 분류됨");
  assert(isHighPriorityRecord(mkRecord("2026-08-20T03:00:00.000Z", ["man_down"])), "쓰러짐 의심은 고위험으로 분류됨");
  assert(!isHighPriorityRecord(mkRecord("2026-08-20T03:00:00.000Z", ["no_mask"])), "마스크 미착용은 고위험이 아님");

  console.log("\n=== tallyByType — 집계 및 색상 고정 ===");
  const recordsOrderA = [
    mkRecord("2026-08-20T01:00:00.000Z", ["no_helmet"]),
    mkRecord("2026-08-20T02:00:00.000Z", ["no_vest"]),
    mkRecord("2026-08-20T03:00:00.000Z", ["no_helmet"]),
  ];
  const recordsOrderB = [
    mkRecord("2026-08-20T02:00:00.000Z", ["no_vest"]),
    mkRecord("2026-08-20T01:00:00.000Z", ["no_helmet"]),
    mkRecord("2026-08-20T03:00:00.000Z", ["no_helmet"]),
  ];
  const barA = tallyByType(recordsOrderA);
  const barB = tallyByType(recordsOrderB);
  const helmetA = barA.find((b) => b.label === "안전모 미착용");
  const helmetB = barB.find((b) => b.label === "안전모 미착용");
  const vestA = barA.find((b) => b.label === "안전조끼 미착용");
  const vestB = barB.find((b) => b.label === "안전조끼 미착용");
  assert(helmetA?.value === 2, "안전모 미착용 2건 집계");
  assert(vestA?.value === 1, "안전조끼 미착용 1건 집계");
  assert(
    !!helmetA?.color && helmetA.color === helmetB?.color,
    "레코드 등장 순서가 달라도 같은 위반 유형은 같은 색상 (등장 순서 기반 배정 버그 회귀 테스트)"
  );
  assert(
    !!vestA?.color && vestA.color === vestB?.color,
    "두 번째 유형도 순서 무관하게 색상 고정"
  );
  assert(helmetA?.color !== vestA?.color, "서로 다른 위반 유형은 서로 다른 색상");

  const highPriorityBar = tallyByType([mkRecord("2026-08-20T01:00:00.000Z", ["fire_smoke"])]);
  assert(
    highPriorityBar[0]?.color === "#f56565",
    "고위험 유형(화재/연기)은 지정된 위험색으로 고정됨"
  );

  console.log("\n=== toDonutData — 상위 5개 + 기타 롤업 ===");
  const manyTypes = tallyByType([
    mkRecord("2026-08-20T01:00:00.000Z", ["no_helmet"]),
    mkRecord("2026-08-20T01:00:00.000Z", ["no_helmet"]),
    mkRecord("2026-08-20T01:00:00.000Z", ["no_helmet"]),
    mkRecord("2026-08-20T01:00:00.000Z", ["no_vest"]),
    mkRecord("2026-08-20T01:00:00.000Z", ["no_vest"]),
    mkRecord("2026-08-20T01:00:00.000Z", ["no_safety_glasses"]),
    mkRecord("2026-08-20T01:00:00.000Z", ["no_mask"]),
    mkRecord("2026-08-20T01:00:00.000Z", ["fire_smoke"]),
    mkRecord("2026-08-20T01:00:00.000Z", ["man_down"]),
    mkRecord("2026-08-20T01:00:00.000Z", [], ["안전그네 미착용"]),
  ]);
  assert(manyTypes.length === 7, "7가지 위반 유형이 집계됨(사전 조건 확인)");
  const donut = toDonutData(manyTypes);
  assert(donut.length === 6, "도넛 데이터는 상위 5개 + 기타 1개 = 6개");
  assert(donut[donut.length - 1].label === "기타", "마지막 항목은 '기타'로 라벨링됨");
  const expectedOtherTotal = manyTypes.slice(5).reduce((s, b) => s + b.value, 0);
  assert(donut[donut.length - 1].value === expectedOtherTotal, "'기타' 값은 6위 이하 항목들의 합");

  console.log("\n=== buildDailyTrend — 최근 7일, KST 기준 라벨/집계 일치 ===");
  const todayKey = kstDateKey();
  const [ty, tm, td] = todayKey.split("-");
  const expectedTodayLabel = `${parseInt(tm, 10)}/${parseInt(td, 10)}`;
  const trend = buildDailyTrend([mkRecord(new Date().toISOString(), ["no_helmet"])], 7);
  assert(trend.length === 7, "7일치 데이터 반환");
  assert(trend[trend.length - 1].label === expectedTodayLabel, "마지막(오늘) 항목의 라벨이 KST 기준 오늘 날짜와 일치");
  assert(trend[trend.length - 1].value === 1, "방금 만든 레코드가 오늘 버킷에 정확히 집계됨");
  assert(trend[trend.length - 1].color === "#1f6feb", "오늘 막대는 강조색으로 표시됨");
  assert(trend[0].color === "#2a3550", "오늘이 아닌 막대는 기본색으로 표시됨");
  void ty;

  console.log(`\n=== 결과: ${passCount}건 통과 / ${failCount}건 실패 ===`);
  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main();
