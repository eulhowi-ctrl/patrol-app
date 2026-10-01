// 시간적 평활화(temporal smoothing) — 매 프레임 독립적으로 판정하면 단 한 프레임의
// 오탐/누락만으로도 배너·기록·외부알림이 바로 튄다(특히 fire_smoke처럼 오탐이 잦은
// 클래스). 최근 N프레임 중 과반수 이상 나온 라벨만 "확정"으로 통과시켜 깜빡임과
// 순간적인 오탐을 줄인다. 실제 위반이 지속되면 다음 몇 프레임 안에 바로 확정되므로
// 탐지가 눈에 띄게 느려지지는 않는다.
import type { DetectionBox, DetectionLabel } from "./labels";

export interface TemporalSmoothingOptions {
  windowSize: number; // 몇 개의 최근 프레임을 볼지
  minVotes: number; // 그 중 몇 번 이상 나와야 "확정"으로 볼지 (windowSize 이하여야 함)
}

export interface DetectionSmoother {
  // 이번 프레임의 원본 탐지 결과를 넣고, 평활화를 거친 확정 결과를 받는다.
  update(frameBoxes: DetectionBox[]): DetectionBox[];
  // 카메라 전환 등 화면 내용이 완전히 바뀌는 시점에 과거 프레임 기록을 비운다.
  reset(): void;
}

export function createDetectionSmoother(options: TemporalSmoothingOptions): DetectionSmoother {
  const { windowSize, minVotes } = options;
  if (windowSize < 1 || minVotes < 1 || minVotes > windowSize) {
    throw new Error(`유효하지 않은 평활화 설정입니다: ${JSON.stringify(options)}`);
  }

  let history: DetectionBox[][] = [];

  function update(frameBoxes: DetectionBox[]): DetectionBox[] {
    history.push(frameBoxes);
    if (history.length > windowSize) history.shift();

    // 라벨별로 최근 윈도우 안에서 몇 개의 프레임에 등장했는지 집계 (한 프레임에 같은
    // 라벨이 여러 박스로 잡혀도 "그 프레임에 등장했다"는 1표로만 센다).
    const votes = new Map<DetectionLabel, number>();
    for (const frame of history) {
      const labelsInFrame = new Set(frame.map((b) => b.label));
      for (const label of labelsInFrame) {
        votes.set(label, (votes.get(label) ?? 0) + 1);
      }
    }

    // 확정된 라벨만 통과시키고, 박스 좌표/신뢰도는 그 라벨이 가장 최근에 등장했던
    // 프레임 값을 사용한다 — 바로 이번 프레임엔 없어도 최근 프레임 값을 잠깐
    // 유지해서(최대 windowSize프레임) 박스가 깜빡이지 않게 한다.
    const confirmed: DetectionBox[] = [];
    for (const [label, count] of votes) {
      if (count < minVotes) continue;
      for (let i = history.length - 1; i >= 0; i--) {
        const match = history[i].find((b) => b.label === label);
        if (match) {
          confirmed.push(match);
          break;
        }
      }
    }
    return confirmed;
  }

  function reset(): void {
    history = [];
  }

  return { update, reset };
}
