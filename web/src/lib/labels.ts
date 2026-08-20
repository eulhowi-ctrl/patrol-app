// 1단계 YOLO 탐지기 클래스 — 순서가 학습된 detector.onnx의 클래스 인덱스와
// 정확히 일치해야 한다 (detection.worker.ts가 argmax 인덱스로 이 배열을 조회).
// training/merge_datasets.py의 TARGET_CLASSES와 반드시 같은 순서로 유지할 것.
//
// 제외된 항목:
// - danger_zone_intrusion: 위험구역은 현장마다 달라 시각적으로 학습 불가능한
//   속성이라 클래스에서 제외 (필요 시 person 탐지 + 앱에서 그린 구역 좌표
//   겹침 판정으로 별도 구현해야 함, 이 리포에는 미포함)
// - no_harness, no_safety_shoes: 공개 학습 데이터셋을 찾지 못해 미포함
export const DETECTION_LABELS = [
  "no_helmet",
  "no_vest",
  "no_safety_glasses",
  "no_mask",
  "fire_smoke",
  "man_down",
] as const;

export type DetectionLabel = (typeof DETECTION_LABELS)[number];

// man_down / fire_smoke는 즉시 알림이 필요한 고위험 이벤트로 분류한다.
export const HIGH_PRIORITY_LABELS: DetectionLabel[] = ["fire_smoke", "man_down"];

// 사람이 읽는 배너/기록 화면용 한글 표시명 (기술적 클래스명 그대로 노출하지 않기 위함).
export const LABEL_KO: Record<DetectionLabel, string> = {
  no_helmet: "안전모 미착용",
  no_vest: "안전조끼 미착용",
  no_safety_glasses: "보안경 미착용",
  no_mask: "마스크 미착용",
  fire_smoke: "화재/연기",
  man_down: "쓰러짐 의심",
};

export interface DetectionBox {
  label: DetectionLabel;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// 2단계 보조 분류기 — 옷차림/착용 속성 판정 (물체가 아니라 사람의 상태라
// YOLO 클래스로 넣지 않고 별도 이진 분류기 3개로 분리: harness.onnx,
// sleeve.onnx, pants.onnx). 우리 6클래스 탐지기에는 person 클래스가 없어서,
// COCO 사전학습 YOLOv8n(person.onnx, 재학습 없이 그대로 사용)으로 사람 박스만
// 따로 찾아 크롭한 뒤 분류기에 넣는다(detection.worker.ts의 classifyClothing).
// 화면에 여러 명이 있으면 화면 정중앙에 가장 가까운 사람 한 명만 판정 — 다인원 개별
// 판정은 아직 미구현.
export type SleeveLength = "long_sleeve" | "short_sleeve";
export type PantsLength = "long_pants" | "short_pants";

export interface ClothingAttributes {
  harnessWorn: boolean;
  harnessScore: number;
  sleeve: SleeveLength;
  sleeveScore: number;
  pants: PantsLength;
  pantsScore: number;
}

// clothingViolations()가 반환하는 배지 문구 — 대시보드 색상 매핑 등 다른 모듈에서
// 문자열을 다시 타이핑하지 않고 이 상수를 참조하도록 export.
export const CLOTHING_VIOLATION_KO = {
  harness: "안전그네 미착용",
  sleeve: "반팔 착용(긴팔 규정)",
  pants: "반바지 착용(긴바지 규정)",
} as const;

// ClothingAttributes를 "위반 여부" 관점의 배지 목록으로 변환 — 배너/기록에 표시.
export function clothingViolations(c: ClothingAttributes | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (!c.harnessWorn) out.push(CLOTHING_VIOLATION_KO.harness);
  if (c.sleeve === "short_sleeve") out.push(CLOTHING_VIOLATION_KO.sleeve);
  if (c.pants === "short_pants") out.push(CLOTHING_VIOLATION_KO.pants);
  return out;
}
