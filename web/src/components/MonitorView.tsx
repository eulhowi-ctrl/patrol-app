import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  createSite,
  ensureUser,
  getMe,
  getTelegramLink,
  joinSite,
  setSubscription,
  snapshotUrl,
  viewerSocketUrl,
  type Me,
  type MeStation,
  type UserCreds,
} from "../lib/api";
import LiveView, { type SiteMessage } from "./LiveView";

// 모니터링 화면: 내가 참여한 사이트의 스테이션들을 분할화면으로 본다.
// 각 칸 = 마지막 감지 사진 + 좌측 상단 아주 작은 접속 표시(초록/빨강 점).
// 칸을 누르면 그 스테이션을 실시간으로 본다. 알림은 Telegram으로 받는다.

const FLASH_MS = 6000;
const PING_MS = 25000;

function beep() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const c = new AC();
    const o = c.createOscillator();
    const g = c.createGain();
    o.connect(g);
    g.connect(c.destination);
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.start();
    setTimeout(() => {
      o.stop();
      void c.close();
    }, 250);
  } catch {
    /* 오디오 불가 환경은 무시 */
  }
}

export default function MonitorView({ onBack }: { onBack?: () => void }) {
  const [user, setUser] = useState<UserCreds | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState(2);
  const [live, setLive] = useState<{ siteId: string; station: MeStation } | null>(null);
  const [panel, setPanel] = useState(false);
  const [sound, setSound] = useState(true);
  const [flash, setFlash] = useState<Record<string, number>>({});
  const [, setTick] = useState(0);

  const listenersRef = useRef(new Set<(siteId: string, msg: SiteMessage) => void>());
  const socketsRef = useRef(new Map<string, WebSocket>());
  const soundRef = useRef(true);
  soundRef.current = sound;

  const refresh = useCallback(async (u: UserCreds) => {
    try {
      setMe(await getMe(u));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // 서버 DB가 초기화되는 등 신원이 무효해진 경우 — 새 신원으로 다시 시작
        try {
          localStorage.removeItem("argus-user-v1");
        } catch {
          /* 무시 */
        }
        const fresh = await ensureUser();
        setUser(fresh);
        setMe(await getMe(fresh));
        return;
      }
      setError(e instanceof Error ? e.message : "불러오기 실패");
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const u = await ensureUser();
        setUser(u);
        await refresh(u);
      } catch (e) {
        setError(e instanceof Error ? e.message : "서버에 연결할 수 없습니다.");
      }
    })();
  }, [refresh]);

  // 앱으로 돌아왔을 때(예: Telegram 연결 후) 상태 갱신
  useEffect(() => {
    if (!user) return;
    const onVis = () => document.visibilityState === "visible" && void refresh(user);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [user, refresh]);

  const patchStation = useCallback((stationId: string, patch: Partial<MeStation>) => {
    setMe((prev) =>
      prev
        ? {
            ...prev,
            sites: prev.sites.map((s) => ({
              ...s,
              stations: s.stations.map((st) => (st.id === stationId ? { ...st, ...patch } : st)),
            })),
          }
        : prev
    );
  }, []);

  // ── 사이트별 WebSocket (접속 상태·이벤트 실시간 수신) ──
  const siteKey = me?.sites.map((s) => s.id).join(",") ?? "";
  useEffect(() => {
    if (!user || !siteKey) return;
    const ids = siteKey.split(",");
    let closed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const pings: ReturnType<typeof setInterval>[] = [];

    const connect = (siteId: string, retry = 0) => {
      if (closed) return;
      const ws = new WebSocket(viewerSocketUrl(user, siteId));
      socketsRef.current.set(siteId, ws);
      ws.onopen = () => {
        const p = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), PING_MS);
        pings.push(p);
        ws.addEventListener("close", () => clearInterval(p));
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        let msg: SiteMessage;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        listenersRef.current.forEach((fn) => fn(siteId, msg));
        if (msg.t === "hello") {
          const online = new Set(msg.online as string[]);
          setMe((prev) =>
            prev
              ? {
                  ...prev,
                  sites: prev.sites.map((s) =>
                    s.id !== siteId ? s : { ...s, stations: s.stations.map((st) => ({ ...st, online: online.has(st.id) })) }
                  ),
                }
              : prev
          );
        } else if (msg.t === "presence") {
          patchStation(msg.stationId as string, { online: !!msg.online });
        } else if (msg.t === "snapshot") {
          patchStation(msg.stationId as string, { snapshotAt: msg.snapshotAt as number });
        } else if (msg.t === "event") {
          const patch: Partial<MeStation> = { lastEventAt: msg.at as number };
          if (msg.snapshotAt) patch.snapshotAt = msg.snapshotAt as number;
          patchStation(msg.stationId as string, patch);
          if (msg.alerted) {
            setFlash((f) => ({ ...f, [msg.stationId as string]: Date.now() + FLASH_MS }));
            if (soundRef.current) beep();
          }
        } else if (msg.t === "station-added" || msg.t === "station-removed") {
          void refresh(user);
        }
      };
      ws.onclose = () => {
        if (closed) return;
        timers.push(setTimeout(() => connect(siteId, retry + 1), Math.min(30000, 1000 * 2 ** retry)));
      };
      ws.onerror = () => ws.close();
    };
    ids.forEach((id) => connect(id));

    return () => {
      closed = true;
      timers.forEach(clearTimeout);
      pings.forEach(clearInterval);
      socketsRef.current.forEach((ws) => ws.close());
      socketsRef.current.clear();
    };
  }, [user, siteKey, patchStation, refresh]);

  // 깜빡임 만료 처리용 틱
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const sendToSite = useCallback((siteId: string, msg: unknown) => {
    const ws = socketsRef.current.get(siteId);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const subscribeSite = useCallback((fn: (siteId: string, msg: SiteMessage) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const toggleSub = async (st: MeStation, on: boolean) => {
    if (!user) return;
    patchStation(st.id, { subscribed: on });
    try {
      await setSubscription(user, st.id, on);
    } catch {
      patchStation(st.id, { subscribed: !on });
    }
  };

  if (error && !me) {
    return (
      <div className="st-page">
        <button className="st-link" onClick={onBack}>← 처음으로</button>
        <p className="st-error">{error}</p>
        <button className="st-btn" onClick={() => user && void refresh(user)}>다시 시도</button>
      </div>
    );
  }
  if (!me || !user) return <div className="st-page st-muted">불러오는 중…</div>;

  if (me.sites.length === 0) {
    return (
      <div className="st-page">
        <button className="st-link" onClick={onBack}>← 처음으로</button>
        <h2>모니터링 시작</h2>
        <SiteJoin user={user} onDone={() => refresh(user)} />
      </div>
    );
  }

  const tiles = me.sites.flatMap((s) => s.stations.map((st) => ({ site: s, st })));
  const multiSite = me.sites.length > 1;
  const nowMs = Date.now();

  return (
    <div className="mt-root">
      <div className="mt-head">
        <button className="st-link" onClick={onBack}>←</button>
        <strong>모니터링</strong>
        <span className="st-muted">
          {tiles.filter((t) => t.st.online).length}/{tiles.length} 온라인
        </span>
        <span className="mt-spacer" />
        {[1, 2, 3, 4].map((n) => (
          <button key={n} className={`st-chip ${columns === n ? "on" : ""}`} onClick={() => setColumns(n)} aria-label={`${n}열`}>
            {n}
          </button>
        ))}
        <button className={`st-chip ${sound ? "on" : ""}`} onClick={() => setSound((v) => !v)} aria-label="경고음">
          {sound ? "🔔" : "🔕"}
        </button>
        <button className="st-chip" onClick={() => setPanel(true)}>설정</button>
      </div>

      {!me.telegramLinked && (
        <div className="mt-notice">
          Telegram이 연결되지 않아 알림을 받을 수 없습니다.{" "}
          <button className="st-link" onClick={() => setPanel(true)}>알림 연결하기</button>
        </div>
      )}

      {tiles.length === 0 ? (
        <div className="st-page st-muted">
          아직 등록된 스테이션이 없습니다. 현장 기기에서 '스테이션으로 쓰기'를 열고 초대코드{" "}
          <b>{me.sites[0].inviteCode}</b>로 등록하세요.
        </div>
      ) : (
        <div className="mt-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {tiles.map(({ site, st }) => (
            <button
              key={st.id}
              className={`mt-tile ${(flash[st.id] ?? 0) > nowMs ? "alert" : ""}`}
              onClick={() => setLive({ siteId: site.id, station: st })}
            >
              <div className="mt-img">
                {st.snapshotAt ? (
                  <img src={snapshotUrl(st.id, st.snapshotAt)} alt="" loading="lazy" />
                ) : (
                  <div className="mt-empty" />
                )}
                {/* 화면을 가리지 않도록 색만 보이는 아주 작은 점 */}
                <span className={`mt-dot ${st.online ? "on" : "off"}`} />
              </div>
              <div className="mt-cap">
                {multiSite ? `${site.name} · ` : ""}
                {st.name}
              </div>
            </button>
          ))}
        </div>
      )}

      {live && (
        <LiveView
          siteId={live.siteId}
          station={me.sites.find((s) => s.id === live.siteId)?.stations.find((s) => s.id === live.station.id) ?? live.station}
          send={sendToSite}
          subscribe={subscribeSite}
          onClose={() => setLive(null)}
        />
      )}

      {panel && (
        <SettingsPanel
          user={user}
          me={me}
          onClose={() => setPanel(false)}
          onToggle={toggleSub}
          onChanged={() => refresh(user)}
        />
      )}
    </div>
  );
}

function SiteJoin({ user, onDone }: { user: UserCreds; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [siteName, setSiteName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setCode("");
      setSiteName("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className="st-label">초대코드로 사이트 참여</label>
      <div className="st-row">
        <input
          className="st-input st-code"
          value={code}
          maxLength={6}
          placeholder="초대코드 6자리"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <button className="st-btn st-primary" disabled={busy || code.length < 6} onClick={() => run(() => joinSite(user, code))}>
          참여
        </button>
      </div>
      <label className="st-label">새 사이트 만들기</label>
      <div className="st-row">
        <input
          className="st-input"
          value={siteName}
          maxLength={40}
          placeholder="예: ○○발전소 1호기"
          onChange={(e) => setSiteName(e.target.value)}
        />
        <button className="st-btn" disabled={busy || !siteName.trim()} onClick={() => run(() => createSite(user, siteName.trim()))}>
          만들기
        </button>
      </div>
      {error && <p className="st-error">{error}</p>}
    </>
  );
}

function SettingsPanel({
  user,
  me,
  onClose,
  onToggle,
  onChanged,
}: {
  user: UserCreds;
  me: Me;
  onClose: () => void;
  onToggle: (st: MeStation, on: boolean) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const connectTelegram = async () => {
    setError(null);
    try {
      const { url } = await getTelegramLink(user);
      if (!url) setError("서버에 봇 이름(BOT_USERNAME)이 설정되지 않았습니다.");
      else window.open(url, "_blank");
    } catch (e) {
      setError(e instanceof Error ? e.message : "연결 링크 생성 실패");
    }
  };

  return (
    <div className="mt-sheet" onClick={onClose}>
      <div className="mt-sheet-body" onClick={(e) => e.stopPropagation()}>
        <div className="st-row">
          <h3 style={{ margin: 0 }}>설정</h3>
          <span className="mt-spacer" />
          <button className="st-btn" onClick={onClose}>닫기</button>
        </div>

        <h4>알림 (Telegram)</h4>
        {me.telegramLinked ? (
          <p>✅ 연결됨 — 아래에서 알림 받을 스테이션을 고르세요.</p>
        ) : (
          <>
            <p className="st-muted">버튼을 눌러 Telegram에서 <b>시작(Start)</b>을 누르면 연결됩니다.</p>
            <button className="st-btn st-primary" onClick={connectTelegram}>알림 연결</button>
          </>
        )}
        {error && <p className="st-error">{error}</p>}

        {me.sites.map((site) => (
          <div key={site.id} className="mt-site">
            <h4>{site.name}</h4>
            <p className="st-muted">
              초대코드 <b className="st-code-inline">{site.inviteCode}</b> — 동료는 이 코드로 참여하고, 스테이션 기기도 이 코드로 등록합니다.
              <br />
              Telegram 그룹으로도 받으려면 그룹에 봇을 초대하고 <code>/link {site.inviteCode}</code> 를 보내세요.
            </p>
            {site.stations.length === 0 && <p className="st-muted">등록된 스테이션 없음</p>}
            {site.stations.map((st) => (
              <label key={st.id} className="st-check">
                <input type="checkbox" checked={st.subscribed} onChange={(e) => onToggle(st, e.target.checked)} />
                <span className={`mt-dot-inline ${st.online ? "on" : "off"}`} />
                {st.name}
              </label>
            ))}
          </div>
        ))}

        <h4>사이트 추가·참여</h4>
        <SiteJoin user={user} onDone={onChanged} />
        <p className="st-muted">
          스테이션 {me.limits.stationCount}/{me.limits.maxStations}개 사용 중
        </p>
      </div>
    </div>
  );
}
