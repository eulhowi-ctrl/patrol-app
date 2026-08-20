import { HIGH_PRIORITY_LABELS } from "./labels";
import type { DetectionRecord } from "./db";
import { kstHour } from "./kstDate";

// 시간대(1시간 단위) 그룹핑 — "오늘의 기록" 아코디언과 대시보드 추이 차트가 공유한다.
// records가 capturedAt 내림차순으로 이미 정렬돼 있으면(db.ts의 getAllDetections),
// 같은 시간대 레코드는 항상 연속된 블록이 되어 startIndex를 안전하게 계산할 수 있다.
export interface HourGroup {
  hourKey: string;
  hourLabel: string;
  records: DetectionRecord[];
  startIndex: number; // 전달받은 배열 기준 시작 인덱스 — 라이트박스 전역 인덱스 계산용
  highPriorityCount: number;
}

export function formatHourLabel(hour: number): string {
  const period = hour < 12 ? "오전" : "오후";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${period} ${displayHour}시`;
}

export function groupRecordsByHour(records: DetectionRecord[]): HourGroup[] {
  const groups: HourGroup[] = [];
  records.forEach((r, idx) => {
    const hour = kstHour(r.capturedAt);
    const hourKey = String(hour);
    const isHighPriority = r.labels.some((b) => HIGH_PRIORITY_LABELS.includes(b.label));
    const last = groups[groups.length - 1];
    if (last && last.hourKey === hourKey) {
      last.records.push(r);
      if (isHighPriority) last.highPriorityCount += 1;
    } else {
      groups.push({
        hourKey,
        hourLabel: formatHourLabel(hour),
        records: [r],
        startIndex: idx,
        highPriorityCount: isHighPriority ? 1 : 0,
      });
    }
  });
  return groups;
}
