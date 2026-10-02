import {
  CLOTHING_VIOLATION_KO,
  LABEL_COLOR,
  LABEL_KO,
  type ClothingAttributes,
  type DetectionBox,
} from "./labels";

// 스테이션 감지 결과를 "박스 + 문구 + 확률"로 표시하기 위한 공통 형식.
// 직접 순찰(CameraView)과 같은 모양: 색 테두리 + 위쪽에 "안전모 미착용 87%" 배지.
// 좌표는 0~1 비율 → 사진(축소)·라이브 영상(WebRTC 위 SVG) 어디에 그려도 같은 위치.

export interface OverlayItem {
  text: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type Rect = { x: number; y: number; width: number; height: number };

const CLOTHING_COLOR = "#f6ad55";
const ZONE_COLOR = "#f56565";

const pct = (s: number) => `${Math.round(s * 100)}%`;

export function buildOverlay(
  frame: { width: number; height: number },
  boxes: DetectionBox[],
  clothing: ClothingAttributes | null,
  personBox: Rect | null,
  zonePersons: Rect[]
): OverlayItem[] {
  const norm = (b: Rect) => ({
    x: b.x / frame.width,
    y: b.y / frame.height,
    w: b.width / frame.width,
    h: b.height / frame.height,
  });
  const items: OverlayItem[] = boxes.map((b) => ({
    text: `${LABEL_KO[b.label] ?? b.label} ${pct(b.score)}`,
    color: LABEL_COLOR[b.label] ?? "#fff",
    ...norm(b),
  }));

  // 옷차림 판정은 화면 중앙 사람 1명 기준 — 그 사람 박스에 위반 문구를 붙인다
  if (clothing && personBox) {
    const parts: string[] = [];
    if (!clothing.harnessWorn) parts.push(`${CLOTHING_VIOLATION_KO.harness} ${pct(clothing.harnessScore)}`);
    if (clothing.sleeve === "short_sleeve") parts.push(`반팔 ${pct(clothing.sleeveScore)}`);
    if (clothing.pants === "short_pants") parts.push(`반바지 ${pct(clothing.pantsScore)}`);
    if (parts.length) items.push({ text: parts.join(" · "), color: CLOTHING_COLOR, ...norm(personBox) });
  }

  for (const p of zonePersons) items.push({ text: "위험구역 진입", color: ZONE_COLOR, ...norm(p) });
  return items;
}

// 캔버스(사진 캡처)용
export function drawOverlay(ctx: CanvasRenderingContext2D, items: OverlayItem[], w: number, h: number) {
  const lw = Math.max(2, Math.round(w / 240));
  const fs = Math.max(11, Math.round(w / 36));
  ctx.lineWidth = lw;
  ctx.font = `bold ${fs}px sans-serif`;
  ctx.textBaseline = "top";
  for (const it of items) {
    const x = it.x * w;
    const y = it.y * h;
    ctx.strokeStyle = it.color;
    ctx.strokeRect(x, y, it.w * w, it.h * h);

    const tw = ctx.measureText(it.text).width + fs * 0.6;
    const th = fs * 1.35;
    // 박스 위에 공간이 없으면 박스 안쪽 위에 붙인다
    const ty = y - th >= 0 ? y - th : y;
    const tx = Math.min(Math.max(0, x - lw / 2), Math.max(0, w - tw));
    ctx.fillStyle = it.color;
    ctx.fillRect(tx, ty, tw, th);
    ctx.fillStyle = "#fff";
    ctx.fillText(it.text, tx + fs * 0.3, ty + fs * 0.18);
  }
}
