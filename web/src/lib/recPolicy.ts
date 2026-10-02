// 녹화 보관 규칙 (스테이션 폰 안에서만 저장).
// - 녹화는 1분 단위 "조각(part)"으로 끊어 저장한다: 원하는 시각에서 바로 재생하기 위함
//   (MediaRecorder 파일은 처음부터만 재생되므로, 조각이 길면 앞부분을 다 받아야 한다).
// - 보관·삭제는 5분 "묶음(unit)" 단위: 묶음 안의 마지막 조각까지 전부 24시간이 지나야 지운다.
//   → 남는 영상은 항상 최소 24시간, 최대 24시간 + 5분.

export interface RecConfig {
  partMs: number; // 조각 길이
  unitMs: number; // 삭제 묶음 길이
  keepMs: number; // 보관 시간
  timesliceMs: number; // 녹화 중 저장 주기 (앱이 꺼져도 이만큼만 잃음)
  bitrate: number; // 영상 비트레이트(bps)
}

export const DEFAULT_REC: RecConfig = {
  partMs: 60_000,
  unitMs: 5 * 60_000,
  keepMs: 24 * 3600_000,
  timesliceMs: 5_000,
  bitrate: 300_000, // 360p 기준 약 0.3Mbps → 24시간 약 3.2GB
};

// 테스트용으로만 짧게 바꿀 수 있게 (localStorage "argus-rec-debug")
export function loadRecConfig(): RecConfig {
  try {
    const raw = localStorage.getItem("argus-rec-debug");
    if (raw) return { ...DEFAULT_REC, ...(JSON.parse(raw) as Partial<RecConfig>) };
  } catch {
    /* 무시 */
  }
  return DEFAULT_REC;
}

export interface PartMeta {
  start: number; // ms
  end: number; // ms (녹화 중이면 마지막 저장 시각)
  mime: string;
  bytes: number;
  done: boolean;
}

export const unitOf = (start: number, unitMs: number) => Math.floor(start / unitMs);

// 지울 조각: 묶음의 마지막 조각 끝 시각이 now - keepMs보다 이전인 묶음 전체
export function partsToDelete(parts: PartMeta[], now: number, cfg: Pick<RecConfig, "unitMs" | "keepMs">): number[] {
  const lastEnd = new Map<number, number>();
  for (const p of parts) {
    const u = unitOf(p.start, cfg.unitMs);
    lastEnd.set(u, Math.max(lastEnd.get(u) ?? 0, p.end));
  }
  const cutoff = now - cfg.keepMs;
  return parts.filter((p) => (lastEnd.get(unitOf(p.start, cfg.unitMs)) ?? 0) < cutoff).map((p) => p.start);
}

// 저장 공간 부족 시: 가장 오래된 묶음부터 지워 usage를 target 아래로
export function partsToFree(parts: PartMeta[], usage: number, target: number, unitMs: number): number[] {
  if (usage <= target) return [];
  const byUnit = new Map<number, PartMeta[]>();
  for (const p of parts) {
    const u = unitOf(p.start, unitMs);
    byUnit.set(u, [...(byUnit.get(u) ?? []), p]);
  }
  const out: number[] = [];
  let need = usage - target;
  for (const u of [...byUnit.keys()].sort((a, b) => a - b)) {
    if (need <= 0) break;
    const ps = byUnit.get(u)!;
    if (ps.some((p) => !p.done)) continue; // 녹화 중인 묶음은 건드리지 않음
    for (const p of ps) {
      out.push(p.start);
      need -= p.bytes;
    }
  }
  return out;
}

// 막대 표시용: 녹화된 구간을 이어 붙인 범위 (gapMs 이내 끊김은 하나로)
export function mergeRanges(parts: Pick<PartMeta, "start" | "end">[], gapMs = 5_000): Array<[number, number]> {
  const sorted = [...parts].sort((a, b) => a.start - b.start);
  const out: Array<[number, number]> = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.start - last[1] <= gapMs) last[1] = Math.max(last[1], p.end);
    else out.push([p.start, p.end]);
  }
  return out;
}

// 시각 t를 담은 조각 (없으면 t 이후 가장 가까운 조각)
export function findPart<T extends Pick<PartMeta, "start" | "end">>(parts: T[], t: number): T | null {
  const sorted = [...parts].sort((a, b) => a.start - b.start);
  return sorted.find((p) => p.start <= t && t < p.end) ?? sorted.find((p) => p.start >= t) ?? null;
}
