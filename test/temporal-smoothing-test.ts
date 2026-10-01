/**
 * temporal-smoothing-test.ts
 *
 * 시간적 평활화(web/src/lib/temporalSmoothing.ts)에 대한 순수 함수 테스트.
 * 한 프레임짜리 순간 오탐/누락이 걸러지는지, 실제로 지속되는 위반은 확정되는지,
 * reset() 이후 과거 이력이 비워지는지를 검증한다.
 */
import { createDetectionSmoother } from "../web/src/lib/temporalSmoothing";
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

function mkBox(label: DetectionBox["label"], score = 0.9): DetectionBox {
  return { label, score, x: 0, y: 0, width: 10, height: 10 };
}

function labelsOf(boxes: DetectionBox[]): string[] {
  return boxes.map((b) => b.label).sort();
}

function main() {
  console.log("=== createDetectionSmoother — 기본 과반수 투표 (window=3, minVotes=2) ===");
  {
    const smoother = createDetectionSmoother({ windowSize: 3, minVotes: 2 });
    assert(labelsOf(smoother.update([mkBox("fire_smoke")])).length === 0, "1번째 프레임만으로는 확정 안 됨 (1표 < 2표)");
    assert(labelsOf(smoother.update([mkBox("fire_smoke")])).join(",") === "fire_smoke", "2번째 연속 등장으로 확정됨 (2표)");
    assert(labelsOf(smoother.update([])).join(",") === "fire_smoke", "현재 프레임에 없어도 최근 윈도우 내 과반수면 유지됨(깜빡임 방지)");
  }

  console.log("=== 순간 오탐 한 프레임은 걸러진다 ===");
  {
    const smoother = createDetectionSmoother({ windowSize: 3, minVotes: 2 });
    assert(labelsOf(smoother.update([mkBox("fire_smoke")])).length === 0, "1프레임 오탐은 미확정");
    assert(labelsOf(smoother.update([])).length === 0, "오탐이 다음 프레임에 사라지면 끝까지 확정되지 않음");
    assert(labelsOf(smoother.update([])).length === 0, "윈도우가 다 비워진 뒤에도 확정 없음");
  }

  console.log("=== 윈도우를 벗어난 과거 등장은 투표에서 빠진다 ===");
  {
    const smoother = createDetectionSmoother({ windowSize: 3, minVotes: 2 });
    smoother.update([mkBox("no_helmet")]); // [1프레임 전] 등장
    smoother.update([]); // 사라짐
    smoother.update([]); // 사라짐 — 이 시점 윈도우: [등장, 없음, 없음] = 1표
    assert(labelsOf(smoother.update([])).length === 0, "윈도우(3프레임)를 벗어나면 과거 등장은 더 이상 표로 집계되지 않음");
  }

  console.log("=== 서로 다른 라벨이 동시에 섞여도 라벨별로 독립 집계된다 ===");
  {
    const smoother = createDetectionSmoother({ windowSize: 3, minVotes: 2 });
    smoother.update([mkBox("no_helmet"), mkBox("no_vest")]);
    const result = smoother.update([mkBox("no_helmet")]); // no_vest는 이번 프레임에 없음(1표), no_helmet은 2표
    assert(labelsOf(result).join(",") === "no_helmet", "2표 모인 라벨만 확정되고, 1표인 라벨은 제외됨");
  }

  console.log("=== 확정된 라벨의 박스는 가장 최근 등장 프레임의 값을 사용한다 ===");
  {
    const smoother = createDetectionSmoother({ windowSize: 3, minVotes: 2 });
    smoother.update([mkBox("no_vest", 0.5)]);
    const result = smoother.update([mkBox("no_vest", 0.9)]);
    assert(result.length === 1 && result[0].score === 0.9, "최신 프레임의 score/좌표가 사용됨");
  }

  console.log("=== 같은 라벨이 여러 명에게 잡히면 박스를 모두 유지한다 ===");
  {
    const smoother = createDetectionSmoother({ windowSize: 3, minVotes: 2 });
    smoother.update([mkBox("no_helmet"), mkBox("no_helmet")]);
    const result = smoother.update([mkBox("no_helmet"), mkBox("no_helmet")]);
    assert(result.length === 2, "두 명 모두 미착용이면 박스 2개가 그대로 나옴");
  }

  console.log("=== reset()은 과거 이력을 비운다 ===");
  {
    const smoother = createDetectionSmoother({ windowSize: 3, minVotes: 2 });
    smoother.update([mkBox("man_down")]);
    smoother.update([mkBox("man_down")]); // 확정 상태
    smoother.reset();
    assert(labelsOf(smoother.update([])).length === 0, "reset 이후에는 이전 확정 상태가 남아있지 않음");
  }

  console.log("=== 유효하지 않은 설정은 생성 시점에 에러를 던진다 ===");
  {
    let threw = false;
    try {
      createDetectionSmoother({ windowSize: 3, minVotes: 4 });
    } catch {
      threw = true;
    }
    assert(threw, "minVotes가 windowSize보다 크면 에러");
  }

  console.log(`\n=== 결과: ${passCount}건 통과 / ${failCount}건 실패 ===`);
  if (failCount > 0) process.exit(1);
}

main();
