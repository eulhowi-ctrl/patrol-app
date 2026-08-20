import { useEffect, useMemo, useState } from "react";
import { getAllDetections, countPending, type DetectionRecord } from "../lib/db";
import { kstDateKey } from "../lib/kstDate";
import {
  tallyByType,
  toDonutData,
  isHighPriorityRecord,
  filterByKstDay,
  buildDailyTrend,
} from "../lib/dashboardStats";
import BarChart from "./charts/BarChart";
import DonutChart from "./charts/DonutChart";

interface DashboardProps {
  onEnterPatrol: () => void;
}

export default function Dashboard({ onEnterPatrol }: DashboardProps) {
  const [allRecords, setAllRecords] = useState<DetectionRecord[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loaded, setLoaded] = useState(false);

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
