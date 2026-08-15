export const DETECTION_LABELS = [
  "no_helmet",
  "no_vest",
  "danger_zone_intrusion",
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
