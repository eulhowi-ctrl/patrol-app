import type { DetectionRecord } from "./db";
import { HIGH_PRIORITY_LABELS, LABEL_KO, CLOTHING_VIOLATION_KO } from "./labels";
import { kstDateKey } from "./kstDate";
import type { BarDatum, DonutDatum } from "./chartTypes";

const HIGH_PRIORITY_COLOR = "#f56565";
const OTHER_COLOR = "#7a869a";

// 위반 유형별 고정 색상 — "오늘 처음 등장한 순서"가 아니라 라벨 자체에 색을 고정한다.
// 이렇게 해야 날짜가 바뀌어도(오늘은 파랑이던 유형이 내일은 다른 색이 되는 일 없이)
// 같은 위반 유형은 항상 같은 색으로 보인다.
const VIOLATION_COLORS: Record<string, string> = {
  [LABEL_KO.no_helmet]: "#1f6feb",
  [LABEL_KO.no_vest]: "#63b3ed",
  [LABEL_KO.no_safety_glasses]: "#4fd1c5",
  [LABEL_KO.no_mask]: "#68d391",
  [LABEL_KO.fire_smoke]: HIGH_PRIORITY_COLOR,
  [LABEL_KO.man_down]: "#e53e3e",
  [CLOTHING_VIOLATION_KO.harness]: "#b794f4",
  [CLOTHING_VIOLATION_KO.sleeve]: "#f6ad55",
  [CLOTHING_VIOLATION_KO.pants]: "#f687b3",
};

function colorForType(label: string): string {
  return VIOLATION_COLORS[label] ?? OTHER_COLOR;
}

// 위반 유형별 발생 건수 집계 — 1단계 탐지 라벨 + 2단계 옷차림 위반 배지를 하나의 목록으로 합친다.
export function tallyByType(records: DetectionRecord[]): BarDatum[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    for (const b of r.labels) {
      const ko = LABEL_KO[b.label] ?? b.label;
      counts.set(ko, (counts.get(ko) ?? 0) + 1);
    }
    for (const v of r.clothingViolations ?? []) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([label, value]) => ({ label, value, color: colorForType(label) }))
    .sort((a, b) => b.value - a.value);
}

const DONUT_TOP_N = 5;

// 범례가 너무 많아지지 않도록 상위 5개 외에는 "기타"로 묶는다 (묶은 사실은 라벨로 그대로 노출).
export function toDonutData(bars: BarDatum[]): DonutDatum[] {
  const top = bars
    .slice(0, DONUT_TOP_N)
    .map((b) => ({ label: b.label, value: b.value, color: b.color ?? OTHER_COLOR }));
  const restTotal = bars.slice(DONUT_TOP_N).reduce((sum, b) => sum + b.value, 0);
  if (restTotal > 0) top.push({ label: "기타", value: restTotal, color: OTHER_COLOR });
  return top;
}

export function isHighPriorityRecord(r: DetectionRecord): boolean {
  return r.labels.some((b) => HIGH_PRIORITY_LABELS.includes(b.label));
}

export function filterByKstDay(records: DetectionRecord[], dayKey: string): DetectionRecord[] {
  return records.filter((r) => kstDateKey(r.capturedAt) === dayKey);
}

// 최근 N일(오늘 포함, 오래된 순) 위반 건수 추이. 라벨("8/20")과 집계 키를 항상 같은
// kstDateKey() 문자열에서 파생시켜, 라벨과 실제로 세는 범위가 어긋나지 않게 한다.
export function buildDailyTrend(records: DetectionRecord[], days = 7): BarDatum[] {
  const todayKey = kstDateKey();
  const out: BarDatum[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = kstDateKey(d);
    const [, month, day] = key.split("-");
    out.push({
      label: `${parseInt(month, 10)}/${parseInt(day, 10)}`,
      value: filterByKstDay(records, key).length,
      color: key === todayKey ? "#1f6feb" : "#2a3550",
    });
  }
  return out;
}
