// 위반 유형 — web/src/lib/labels.ts의 DETECTION_LABELS + 2단계 분류기 + 위험구역
export const LABEL_KO: Record<string, string> = {
  no_helmet: "안전모 미착용",
  no_vest: "안전조끼 미착용",
  no_safety_glasses: "보안경 미착용",
  no_mask: "마스크 미착용",
  fire_smoke: "화재/연기",
  man_down: "쓰러짐 의심",
  no_harness: "안전그네 미착용",
  short_sleeve: "반팔 착용(긴팔 규정)",
  short_pants: "반바지 착용(긴바지 규정)",
  zone_intrusion: "위험구역 진입",
};

// 고위험 — 중복 방지 간격을 짧게 둔다
const HIGH = new Set(["fire_smoke", "man_down", "zone_intrusion"]);
export const isHigh = (label: string) => HIGH.has(label);
export const isKnownLabel = (label: string) => label in LABEL_KO;
