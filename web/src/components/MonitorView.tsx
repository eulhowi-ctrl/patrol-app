import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  createSite,
  deleteSite,
  ensureUser,
  getMe,
  getTelegramLink,
  joinSite,
  kickMember,
  leaveSite,
  listMembers,
  reissueViewCode,
  removeStationAsUser,
  renameSite,
  setSubscription,
  snapshotUrl,
  viewerSocketUrl,
  type Me,
  type Member,
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
        } else if (msg.t === "kicked") {
          window.alert("개설자가 이 모니터링에서 내보냈습니다.");
          void refresh(user);
        } else if (
          msg.t === "station-added" ||
          msg.t === "station-removed" ||
          msg.t === "site-renamed" ||
          msg.t === "site-removed"
        ) {
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
          아직 등록된 스테이션이 없습니다.{" "}
          {me.sites[0].inviteCode ? (
            <>
              현장 기기에서 '스테이션으로 쓰기'를 열고 초대코드 <b>{me.sites[0].inviteCode}</b>로 등록하세요.
            </>
          ) : (
            "사이트 관리자가 스테이션을 등록하면 여기에 보입니다."
          )}
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
  const [nickname, setNickname] = useState("");
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
      <label className="st-label">보안코드로 모니터링 참여</label>
      {/* 이름 필수: 개설자가 참여자 목록에서 알아볼 수 있게 (공백만은 안 됨) */}
      <input
        className="st-input"
        value={nickname}
        maxLength={20}
        placeholder="내 이름 (필수, 개설자에게 표시)"
        onChange={(e) => setNickname(e.target.value)}
      />
      <div className="st-row">
        <input
          className="st-input st-code"
          value={code}
          maxLength={8}
          placeholder="보안코드 8자리"
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s/g, ""))}
        />
        <button className="st-btn st-primary" disabled={busy || code.length < 8 || !nickname.trim()} onClick={() => run(() => joinSite(user, code, nickname.trim()))}>
          참여
        </button>
      </div>
      {code.length === 8 && !nickname.trim() && <p className="st-muted">이름을 입력해야 참여할 수 있습니다.</p>}
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

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청 실패");
    }
  };

  const rename = (site: Me["sites"][number]) => {
    const name = window.prompt("새 사이트 이름", site.name)?.trim();
    if (name && name !== site.name) void run(() => renameSite(user, site.id, name));
  };

  const removeSite = (site: Me["sites"][number]) => {
    const n = site.stations.length;
    if (
      window.confirm(
        `'${site.name}' 사이트를 삭제할까요?
등록된 스테이션 ${n}대도 함께 삭제되고, 해당 기기는 등록이 해제됩니다.`
      )
    ) {
      void run(() => deleteSite(user, site.id));
    }
  };

  const leave = (site: Me["sites"][number]) => {
    if (window.confirm(`'${site.name}'을(를) 내 모니터링에서 뺄까요? 다시 보려면 보안코드가 필요합니다.`)) {
      void run(() => leaveSite(user, site.id));
    }
  };

  const reissue = (site: Me["sites"][number]) => {
    if (window.confirm("보안코드를 새로 만들까요? 이전 코드로는 더 이상 참여할 수 없습니다. (이미 참여한 사람은 유지)")) {
      void run(() => reissueViewCode(user, site.id));
    }
  };

  const removeStation = (st: MeStation) => {
    if (window.confirm(`스테이션 '${st.name}'을(를) 삭제할까요? 해당 기기는 등록이 해제됩니다.`)) {
      void run(() => removeStationAsUser(user, st.id));
    }
  };

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
            <div className="st-row">
              <h4 style={{ margin: 0 }}>{site.name}</h4>
              <span className="mt-spacer" />
              {site.canManage ? (
                <>
                  <button className="st-chip" onClick={() => rename(site)}>이름 변경</button>
                  <button className="st-chip" onClick={() => removeSite(site)}>모니터링 삭제</button>
                </>
              ) : (
                <button className="st-chip" onClick={() => leave(site)}>목록에서 빼기</button>
              )}
            </div>
            {site.canManage ? (
              <p className="st-muted">
                🔒 보안코드 <b className="st-code-inline">{site.viewCode}</b>{" "}
                <button className="st-link" onClick={() => reissue(site)}>재발급</button>
                <br />— 이 코드를 받은 사람만 모니터링(사진·라이브)에 들어올 수 있습니다.
                <br />
                📷 초대코드 <b className="st-code-inline">{site.inviteCode}</b> — 스테이션 기기 등록 전용입니다.
                <br />
                Telegram 그룹으로도 받으려면 그룹에 봇을 초대하고 <code>/link {site.viewCode}</code> 를 보내세요.
              </p>
            ) : (
              <p className="st-muted">보안코드로 참여한 모니터링입니다. 코드는 관리자만 볼 수 있습니다.</p>
            )}
            {site.canManage && <Members user={user} siteId={site.id} />}
            {site.stations.length === 0 && <p className="st-muted">등록된 스테이션 없음</p>}
            {site.stations.map((st) => (
              <label key={st.id} className="st-check">
                <input type="checkbox" checked={st.subscribed} onChange={(e) => onToggle(st, e.target.checked)} />
                <span className={`mt-dot-inline ${st.online ? "on" : "off"}`} />
                <span style={{ flex: 1 }}>{st.name}</span>
                {site.canManage && (
                  <button
                    type="button"
                    className="st-chip"
                    onClick={(e) => {
                      e.preventDefault();
                      removeStation(st);
                    }}
                  >
                    삭제
                  </button>
                )}
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

// 개설자 전용: 보안코드로 들어온 참여자 목록 + 내보내기
function Members({ user, siteId }: { user: UserCreds; siteId: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setList((await listMembers(user, siteId)).members);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    }
  }, [user, siteId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const label = (m: Member, i: number) => m.nickname || `이름 없음 #${i + 1}`;
  const when = (sec: number) =>
    sec ? new Date(sec * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "이전 참여";

  const kick = async (m?: Member, i = 0) => {
    const msg = m
      ? `'${label(m, i)}'을(를) 내보낼까요? 바로 화면이 끊기고 알림도 해제됩니다.`
      : "개설자를 뺀 참여자 전원을 내보낼까요?\n코드가 유출됐다면 보안코드 재발급도 함께 하세요.";
    if (!window.confirm(msg)) return;
    try {
      await kickMember(user, siteId, m?.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "내보내기 실패");
    }
  };

  if (!open) {
    return (
      <button className="st-chip" onClick={() => setOpen(true)}>
        👥 참여자 관리
      </button>
    );
  }
  return (
    <div className="mt-members">
      <div className="st-row">
        <strong>👥 참여자 {list ? `${list.length}명` : ""}</strong>
        <span className="mt-spacer" />
        {list && list.length > 0 && (
          <button className="st-chip" onClick={() => kick()}>모두 내보내기</button>
        )}
        <button className="st-chip" onClick={() => setOpen(false)}>접기</button>
      </div>
      {error && <p className="st-error">{error}</p>}
      {list?.length === 0 && <p className="st-muted">보안코드로 들어온 참여자가 없습니다.</p>}
      {list?.map((m, i) => (
        <div key={m.id} className="st-row mt-member">
          <span style={{ flex: 1 }}>
            {label(m, i)}
            <span className="st-muted"> · {when(m.joinedAt)}{m.telegramLinked ? " · 알림 연결" : ""}</span>
          </span>
          <button className="st-chip" onClick={() => kick(m, i)}>내보내기</button>
        </div>
      ))}
    </div>
  );
}
