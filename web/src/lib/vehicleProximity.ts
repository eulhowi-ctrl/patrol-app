// 사람-차량 근접 판정 — 카메라 한 대(단안)로는 실제 거리를 잴 수 없으므로, 2D 박스
// 위치 관계로 근사한다:
//  1) 수평: 사람의 발 위치(박스 하단 중앙)가 차량 박스 좌우로 차량 폭의 절반만큼
//     넓힌 범위 안에 있어야 한다.
//  2) 깊이: 사람 발의 y좌표가 차량 바닥(박스 하단) y좌표와 비슷해야 한다 — 같은
//     지면 깊이에 서 있다는 뜻이다. 화면상으로만 겹치는 경우(카메라 바로 앞 사람 뒤로
//     먼 차량이 보이는 경우)나 운전석에 앉은 운전자(발이 차량 바닥보다 한참 위)는
//     이 조건에서 걸러진다.
// 굴착기·지게차 같은 건설장비는 COCO 클래스가 아니라서 truck으로 잡힐 때만 감지된다.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const HORIZONTAL_MARGIN_RATIO = 0.5; // 차량 폭 대비 좌우 확장 비율
const DEPTH_BAND_RATIO = 0.35; // 차량 높이 대비 "같은 지면 깊이"로 보는 발 y좌표 허용 오차

export function isNearVehicle(person: Rect, vehicle: Rect): boolean {
  const footX = person.x + person.width / 2;
  const footY = person.y + person.height;

  const margin = vehicle.width * HORIZONTAL_MARGIN_RATIO;
  const withinHorizontal = footX >= vehicle.x - margin && footX <= vehicle.x + vehicle.width + margin;

  const vehicleBottom = vehicle.y + vehicle.height;
  const withinDepth = Math.abs(footY - vehicleBottom) <= vehicle.height * DEPTH_BAND_RATIO;

  return withinHorizontal && withinDepth;
}

export function findPersonsNearVehicles<T extends Rect>(persons: T[], vehicles: Rect[]): T[] {
  return persons.filter((p) => vehicles.some((v) => isNearVehicle(p, v)));
}
