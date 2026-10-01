// 오탐 방지 1단계: 같은 위반이 일정 시간 "연속" 감지될 때만 서버에 보고한다.
//  - 한두 프레임 스치는 오탐은 걸러진다.
//  - 감지가 잠깐(GRACE) 끊겨도 같은 위반으로 이어서 본다 (추론이 가끔 놓치는 경우).
//  - 계속 이어지는 위반은 REPORT_INTERVAL마다 한 번씩만 보고한다 (서버가 추가로 단계적 완화).

export const PERSIST_MS = 3000; // 이 시간 이상 연속 감지되어야 보고
export const GRACE_MS = 2000; // 이 시간까지의 감지 공백은 연속으로 본다
export const REPORT_INTERVAL_MS = 15000; // 지속 중인 위반의 재보고 간격

interface Track {
  firstSeen: number;
  lastSeen: number;
  lastReported: number;
}

export class ViolationTracker {
  private tracks = new Map<string, Track>();

  /** 이번 추론에서 보인 위반 유형들을 넣으면, 지금 보고해야 할 유형을 돌려준다. */
  update(present: Iterable<string>, now: number): string[] {
    const seen = new Set(present);

    // 공백이 GRACE를 넘은 트랙은 종료(해소)
    for (const [label, t] of this.tracks) {
      if (!seen.has(label) && now - t.lastSeen > GRACE_MS) this.tracks.delete(label);
    }

    const due: string[] = [];
    for (const label of seen) {
      const t = this.tracks.get(label);
      if (!t) {
        this.tracks.set(label, { firstSeen: now, lastSeen: now, lastReported: -Infinity });
        continue;
      }
      t.lastSeen = now;
      if (now - t.firstSeen >= PERSIST_MS && now - t.lastReported >= REPORT_INTERVAL_MS) {
        t.lastReported = now;
        due.push(label);
      }
    }
    return due;
  }

  reset() {
    this.tracks.clear();
  }
}
