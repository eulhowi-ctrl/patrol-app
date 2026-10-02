import { useEffect, useState } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";
import Dashboard from "../src/components/Dashboard";
import { loadStation, removeStation, saveStation, type StationCreds } from "../src/lib/api";
import { saveZone } from "../src/lib/zone";

// getUserMedia/Canvas/WebSocket은 브라우저 전용 API이므로 SSR을 비활성화한다.
const CameraView = dynamic(() => import("../src/components/CameraView"), { ssr: false });
const StationView = dynamic(() => import("../src/components/StationView"), { ssr: false });
const MonitorView = dynamic(() => import("../src/components/MonitorView"), { ssr: false });

type View = "home" | "station" | "monitor" | "dashboard" | "patrol";

const ROLE_KEY = "argus-role-v1";

function rememberRole(role: "station" | "monitor" | null) {
  try {
    if (role) localStorage.setItem(ROLE_KEY, role);
    else localStorage.removeItem(ROLE_KEY);
  } catch {
    /* 저장 불가 환경은 무시 */
  }
}

export default function Home() {
  const [view, setView] = useState<View>("home");
  const [ready, setReady] = useState(false);
  const [station, setStation] = useState<StationCreds | null>(null);

  // 현장 기기가 재부팅·새로고침되어도 마지막 역할(스테이션/모니터링)로 바로 복귀
  useEffect(() => {
    try {
      const role = localStorage.getItem(ROLE_KEY);
      if (role === "station" || role === "monitor") setView(role);
    } catch {
      /* 무시 */
    }
    setStation(loadStation());
    setReady(true);
  }, []);

  // 이 기기에 등록된 스테이션 정보를 지워 새로 등록할 수 있게 한다
  const unregisterStation = async () => {
    if (!station) return;
    if (!confirm(`이 기기의 스테이션 '${station.siteName} / ${station.name}' 등록을 해제할까요?`)) return;
    try {
      await removeStation(station);
    } catch {
      /* 서버에 이미 없거나 오프라인이어도 이 기기의 등록 정보는 지운다 */
    }
    saveStation(null);
    saveZone(null);
    setStation(null);
  };

  const go = (v: View) => {
    rememberRole(v === "station" || v === "monitor" ? v : null);
    setView(v);
  };

  return (
    <>
      <Head>
        <title>ARGUS - AI Safety Patrol System</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0b1220" />
      </Head>
      <main className={view === "station" ? "main-full" : undefined}>
        {!ready ? null : view === "home" ? (
          <div className="st-page">
            <h1 className="home-title">ARGUS</h1>
            <p className="st-muted">
              폐휴대폰·태블릿이 현장을 상시 지켜보다가, 보호구 미착용·위험구역 진입을 감지하면 Telegram으로 알려줍니다.
            </p>
            <button className="home-card" onClick={() => go("station")}>
              <strong>스테이션으로 쓰기</strong>
              <span>
                {station
                  ? `현재 등록: ${station.siteName} / ${station.name}`
                  : "이 기기를 현장에 거치해 상시 감시합니다"}
              </span>
            </button>
            {station && (
              <button className="st-link" onClick={unregisterStation}>
                이 기기의 스테이션 등록 해제 (다른 사이트·이름으로 다시 등록)
              </button>
            )}
            <button className="home-card" onClick={() => go("monitor")}>
              <strong>모니터링 보기</strong>
              <span>여러 스테이션을 한 화면에서 확인하고 알림을 설정합니다</span>
            </button>
            <button className="home-card" onClick={() => go("dashboard")}>
              <strong>직접 순찰 (기존 방식)</strong>
              <span>폰으로 현장을 비추며 바로 점검합니다</span>
            </button>
          </div>
        ) : view === "station" ? (
          <StationView onBack={() => go("home")} />
        ) : view === "monitor" ? (
          <MonitorView onBack={() => go("home")} />
        ) : view === "dashboard" ? (
          <Dashboard onEnterPatrol={() => go("patrol")} onBack={() => go("home")} />
        ) : (
          <CameraView onBack={() => go("dashboard")} />
        )}
      </main>
    </>
  );
}
