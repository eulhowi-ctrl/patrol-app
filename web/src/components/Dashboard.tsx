import { useCallback, useEffect, useMemo, useState } from "react";
import { getAllDetections, countPending, type DetectionRecord } from "../lib/db";
import { kstDateKey } from "../lib/kstDate";
import {
  tallyByType,
  toDonutData,
  isHighPriorityRecord,
  filterByKstDay,
  buildDailyTrend,
} from "../lib/dashboardStats";
import {
  isPushSupported,
  getPushSubscription,
  subscribeToHighPriorityAlerts,
  unsubscribeFromHighPriorityAlerts,
} from "../lib/pushClient";
import BarChart from "./charts/BarChart";
import DonutChart from "./charts/DonutChart";

interface DashboardProps {
  onEnterPatrol: () => void;
}

export default function Dashboard({ onEnterPatrol }: DashboardProps) {
  const [allRecords, setAllRecords] = useState<DetectionRecord[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // 화재/쓰러짐 등 고위험 이벤트를 이 기기로 외부 알림(웹 푸시) 받을지 여부 —
  // 관리자가 순찰에 들어가지 않고 대시보드 화면에 머무는 기기에서 켜두는 용도.
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getAllDetections(), countPending()]).then(([records, pending]) => {
      if (cancelled) return;
      setAllRecords(records);
      setPendingCount(pending);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isPushSupported()) return;
    setPushSupported(true);
    void getPushSubscription().then((sub) => setPushEnabled(sub !== null));
  }, []);

  const togglePushAlerts = useCallback(async () => {
    setPushBusy(true);
    try {
      if (pushEnabled) {
        await unsubscribeFromHighPriorityAlerts();
        setPushEnabled(false);
      } else {
        const ok = await subscribeToHighPriorityAlerts();
        setPushEnabled(ok);
        if (!ok) {
          alert("알림 권한이 거부되었거나 설정이 완료되지 않았습니다. 브라우저 알림 권한을 확인해주세요.");
        }
      }
    } finally {
      setPushBusy(false);
    }
  }, [pushEnabled]);

  const todayRecords = useMemo(
    () => filterByKstDay(allRecords, kstDateKey()),
    [allRecords]
  );

  const todayHighPriority = useMemo(
    () => todayRecords.filter(isHighPriorityRecord).length,
    [todayRecords]
  );

  const barData = useMemo(() => tallyByType(todayRecords), [todayRecords]);
  const donutData = useMemo(() => toDonutData(barData), [barData]);
  const trendData = useMemo(() => buildDailyTrend(allRecords), [allRecords]);

  const hasAnyHistory = loaded && allRecords.length > 0;

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1 className="dashboard-title">ARGUS</h1>
        <p className="dashboard-subtitle">AI Safety Patrol System</p>
      </div>

      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-card-value">{todayRecords.length}</div>
          <div className="stat-card-label">오늘 위반 건수</div>
        </div>
        <div className="stat-card stat-card-danger">
          <div className="stat-card-value">{todayHighPriority}</div>
          <div className="stat-card-label">고위험 이벤트</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value">{pendingCount}</div>
          <div className="stat-card-label">동기화 대기</div>
        </div>
      </div>

      <button className="cta-button" onClick={onEnterPatrol}>
        ▶ 순찰 시작하기
      </button>

      {pushSupported ? (
        <button className="push-toggle-btn" onClick={() => void togglePushAlerts()} disabled={pushBusy}>
          {pushEnabled ? "🔕 이 기기 위험 알림 끄기" : "🔔 이 기기로 위험 알림 받기"}
        </button>
      ) : (
        <div className="push-unsupported-hint">
          이 브라우저는 외부 알림을 지원하지 않습니다. (iOS는 홈 화면에 추가한 뒤 사용 가능)
        </div>
      )}
      <p className="push-hint-text">
        화재/연기·쓰러짐 같은 고위험 상황이 감지되면, 켜둔 기기로 순찰 여부와 무관하게 즉시 알림을 보냅니다.
      </p>

      {!hasAnyHistory ? (
        <div className="dashboard-empty">
          {loaded ? "표시할 기록이 없습니다. 순찰을 시작해 첫 기록을 남겨보세요." : "불러오는 중..."}
        </div>
      ) : (
        <>
          <div className="chart-panel">
            <div className="chart-panel-title">최근 7일 위반 추이</div>
            <BarChart data={trendData} orientation="vertical" />
          </div>

          {barData.length > 0 && (
            <div className="chart-panel">
              <div className="chart-panel-title">오늘 위반 유형별 건수</div>
              <BarChart data={barData} orientation="horizontal" />
            </div>
          )}

          {donutData.length > 0 && (
            <div className="chart-panel">
              <div className="chart-panel-title">오늘 위반 유형 비율</div>
              <DonutChart data={donutData} centerValue={todayRecords.length} centerLabel="오늘 전체" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
