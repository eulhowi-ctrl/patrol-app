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

export interface DetectionBox {
  label: DetectionLabel;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// 2단계 보조 분류기 — 1단계에서 찾은 person 영역을 잘라 옷차림 속성을 판정한다
// (소매/바지 길이는 물체가 아니라 옷 속성이라 YOLO 클래스로 넣지 않음).
export type SleeveLength = "long_sleeve" | "short_sleeve";
export type PantsLength = "long_pants" | "short_pants";

export interface ClothingAttributes {
  sleeve: SleeveLength;
  sleeveScore: number;
  pants: PantsLength;
  pantsScore: number;
}
