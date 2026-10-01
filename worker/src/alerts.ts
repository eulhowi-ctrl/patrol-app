// 중복 알림 방지 — 순수 함수라 단독 테스트 가능.
// 같은 (스테이션, 위반유형)이 이어지는 동안은 알림 간격을 단계적으로 늘린다.
// 일반: 즉시 → 1분 → 5분 → 30분 / 고위험: 즉시 → 30초 → 1분 → 2분.
export const NORMAL_STEPS = [0, 60, 300, 1800];
export const HIGH_STEPS = [0, 30, 60, 120];
// 이 시간 이상 이벤트가 끊기면 위반이 해소된 것으로 보고 새 알림으로 취급
export const RESET_GAP_SEC = 120;
export const FP_MUTE_SEC = 3600; // 오탐 신고 시 음소거 시간

export interface AlertState {
  lastEventAt: number;
  lastSentAt: number;
  level: number; // 이번 연속 구간에서 보낸 알림 수
  mutedUntil: number;
}

export interface AlertDecision {
  send: boolean;
  next: AlertState;
}

export function decideAlert(
  prev: AlertState | null,
  now: number,
  high: boolean
): AlertDecision {
  const steps = high ? HIGH_STEPS : NORMAL_STEPS;
  const base: AlertState = prev ?? {
    lastEventAt: 0,
    lastSentAt: 0,
    level: 0,
    mutedUntil: 0,
  };

  // 연속 구간이 끊겼으면 단계 초기화
  let level = base.level;
  if (now - base.lastEventAt > RESET_GAP_SEC) level = 0;

  const muted = now < base.mutedUntil;
  const waitSec = steps[Math.min(level, steps.length - 1)];
  const due = level === 0 || now - base.lastSentAt >= waitSec;
  const send = !muted && due;

  return {
    send,
    next: {
      lastEventAt: now,
      lastSentAt: send ? now : base.lastSentAt,
      level: send ? level + 1 : level,
      mutedUntil: base.mutedUntil,
    },
  };
}

// 그룹 채팅 분당 20건 제한 대응 — 15건까지만 보내고 나머지는 요약 1건으로 묶는다.
export const GROUP_WINDOW_SEC = 60;
export const GROUP_MAX_PER_WINDOW = 15;

export interface GroupWindow {
  windowStart: number;
  windowCount: number;
  suppressed: number;
}

export interface GroupDecision {
  send: boolean;
  summarize: number; // 이전 창에서 묶인 건수 (>0이면 요약 메시지 먼저 발송)
  next: GroupWindow;
}

export function decideGroup(w: GroupWindow, now: number): GroupDecision {
  let { windowStart, windowCount, suppressed } = w;
  let summarize = 0;
  if (now - windowStart >= GROUP_WINDOW_SEC) {
    summarize = suppressed;
    windowStart = now;
    windowCount = 0;
    suppressed = 0;
  }
  if (windowCount >= GROUP_MAX_PER_WINDOW) {
    return {
      send: false,
      summarize,
      next: { windowStart, windowCount, suppressed: suppressed + 1 },
    };
  }
  // 요약 메시지도 1건으로 센다
  return {
    send: true,
    summarize,
    next: {
      windowStart,
      windowCount: windowCount + 1 + (summarize > 0 ? 1 : 0),
      suppressed,
    },
  };
}
