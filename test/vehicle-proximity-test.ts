/**
 * vehicle-proximity-test.ts
 *
 * 사람-차량 근접 판정(web/src/lib/vehicleProximity.ts)에 대한 순수 함수 테스트.
 * 기준 차량: x=400~600, y=300~400 (폭 200, 높이 100, 바닥 y=400)
 * → 수평 허용 범위: 발 x 300~700, 깊이 허용 범위: 발 y 365~435
 */
import { isNearVehicle, findPersonsNearVehicles, type Rect } from "../web/src/lib/vehicleProximity";

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

const vehicle: Rect = { x: 400, y: 300, width: 200, height: 100 };

// 발 위치(박스 하단 중앙)를 (footX, footY)에 두는 사람 박스
function personAt(footX: number, footY: number, height = 120): Rect {
  const width = 40;
  return { x: footX - width / 2, y: footY - height, width, height };
}

function main() {
  console.log("=== isNearVehicle — 근접으로 판정되어야 하는 경우 ===");
  assert(isNearVehicle(personAt(380, 400), vehicle), "차량 바로 옆, 같은 지면 깊이에 서 있음");
  assert(isNearVehicle(personAt(500, 420), vehicle), "차량 바로 앞(카메라 쪽으로 살짝 앞)에 서 있음");
  assert(isNearVehicle(personAt(690, 395), vehicle), "수평 허용 범위 끝(차량 폭 절반 거리)에 서 있음");

  console.log("=== isNearVehicle — 근접이 아니어야 하는 경우 ===");
  assert(!isNearVehicle(personAt(800, 400), vehicle), "같은 깊이지만 수평으로 멀리 떨어져 있음");
  assert(
    !isNearVehicle(personAt(500, 700, 400), vehicle),
    "화면상 겹치지만 카메라 바로 앞에 있는 사람(발이 차량 바닥보다 훨씬 아래) — 먼 차량과 무관"
  );
  assert(
    !isNearVehicle(personAt(450, 340, 40), vehicle),
    "운전석에 앉은 운전자(발 위치가 차량 바닥보다 한참 위)"
  );

  console.log("=== findPersonsNearVehicles ===");
  const near = personAt(380, 400);
  const far = personAt(900, 400);
  const result = findPersonsNearVehicles([near, far], [vehicle]);
  assert(result.length === 1 && result[0] === near, "여러 사람 중 근접한 사람만 반환");
  assert(findPersonsNearVehicles([near], []).length === 0, "차량이 없으면 아무도 반환하지 않음");

  console.log(`\n=== 결과: ${passCount}건 통과 / ${failCount}건 실패 ===`);
  if (failCount > 0) process.exit(1);
}

main();
