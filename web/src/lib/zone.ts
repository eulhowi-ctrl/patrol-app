// 위험구역 — 작업(크레인 하역, 화기작업 등) 때만 켜는 임시 구역.
// 좌표는 프레임 크기 대비 0~1로 정규화해서 저장한다 (해상도가 바뀌어도 유지).

export interface Point {
  x: number;
  y: number;
}

export interface DangerZone {
  points: Point[]; // 3개 이상
  expiresAt: number; // epoch ms — 지나면 자동 해제
}

const ZONE_KEY = "argus-zone-v1";

export function loadZone(): DangerZone | null {
  try {
    const raw = localStorage.getItem(ZONE_KEY);
    if (!raw) return null;
    const z = JSON.parse(raw) as DangerZone;
    return isZoneActive(z) ? z : null;
  } catch {
    return null;
  }
}

export function saveZone(z: DangerZone | null) {
  try {
    if (z) localStorage.setItem(ZONE_KEY, JSON.stringify(z));
    else localStorage.removeItem(ZONE_KEY);
  } catch {
    /* 저장 불가 환경은 무시 */
  }
}

export function isZoneActive(z: DangerZone | null, now = Date.now()): z is DangerZone {
  return !!z && z.points.length >= 3 && z.expiresAt > now;
}

/** 점이 다각형 안에 있는지 (ray casting) */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const crosses = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** 사람 박스(프레임 픽셀)의 발 위치 또는 중심이 구역 안이면 진입으로 본다 */
export function personInZone(
  box: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
  zone: DangerZone
): boolean {
  const feet = { x: (box.x + box.width / 2) / frame.width, y: (box.y + box.height) / frame.height };
  const center = {
    x: (box.x + box.width / 2) / frame.width,
    y: (box.y + box.height / 2) / frame.height,
  };
  return pointInPolygon(feet, zone.points) || pointInPolygon(center, zone.points);
}

/** 컨테이너 안에 영상을 object-fit: contain으로 넣었을 때 실제 영상이 차지하는 영역 */
export function fitRect(cw: number, ch: number, vw: number, vh: number) {
  if (!vw || !vh) return { x: 0, y: 0, w: cw, h: ch };
  const scale = Math.min(cw / vw, ch / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}
