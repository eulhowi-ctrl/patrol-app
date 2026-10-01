import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  API_BASE,
  loadStation,
  postEvent,
  putSnapshot,
  registerStation,
  removeStation,
  saveStation,
  stationSocketUrl,
  type StationCreds,
} from "../lib/api";
import { LABEL_COLOR, type ClothingAttributes, type DetectionBox } from "../lib/labels";
import { ViolationTracker } from "../lib/violationTracker";
import {
  fitRect,
  isZoneActive,
  loadZone,
  personInZone,
  saveZone,
  type DangerZone,
  type Point,
} from "../lib/zone";

// 스테이션 모드: 현장에 거치해 두는 감시 기기.
// 카메라 → 온디바이스 추론 → (3초 이상 연속 감지) → 서버 보고 → Telegram 알림.
// 영상은 서버로 보내지 않는다. 서버에는 위반 시점의 사진 1장과 접속 상태만 간다.

const INFER_INTERVAL_MS = 1000; // 상시 감시는 0.5초가 필요 없다 — 발열·배터리 절감
const SNAPSHOT_REFRESH_MS = 10 * 60 * 1000; // 위반이 없어도 10분마다 "현재 모습" 갱신
const MAX_LIVE_SESSIONS = 3;
const PING_MS = 25000;

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// 위험구역 유지 시간 선택지(시간)
const ZONE_HOURS = [1, 2, 4, 8];

interface LiveSession {
  timer?: ReturnType<typeof setInterval>;
  pc?: RTCPeerConnection;
}

type WsState = "off" | "on";

function SetupForm({ onDone, onBack }: { onDone: (c: StationCreds) => void; onBack?: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const creds = await registerStation(code.trim().toUpperCase(), name.trim());
      saveStation(creds);
      onDone(creds);
    } catch (e) {
      setError(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-page">
      <button className="st-link" onClick={onBack}>← 처음으로</button>
      <h2>스테이션 등록</h2>
      <p className="st-muted">
        이 기기를 현장에 거치해 상시 감시하는 스테이션으로 등록합니다. 사이트 관리자에게 받은 초대코드를 입력하세요.
      </p>
      {!API_BASE && <p className="st-error">서버 주소가 설정되지 않았습니다.</p>}
      <label className="st-label">초대코드</label>
      <input
        className="st-input st-code"
        value={code}
        maxLength={6}
        autoCapitalize="characters"
        placeholder="예: K7M2QX"
        onChange={(e) => setCode(e.target.value.toUpperCase())}
      />
      <label className="st-label">스테이션 이름</label>
      <input
        className="st-input"
        value={name}
        maxLength={30}
        placeholder="예: 터빈동 1층 입구"
        onChange={(e) => setName(e.target.value)}
      />
      {error && <p className="st-error">{error}</p>}
      <button className="st-btn st-primary" disabled={busy || code.length < 6 || !name.trim()} onClick={submit}>
        {busy ? "등록 중…" : "등록하고 시작"}
      </button>
    </div>
  );
}

export default function StationView({ onBack }: { onBack?: () => void }) {
  const [creds, setCreds] = useState<StationCreds | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setCreds(loadStation());
    setLoaded(true);
  }, []);

  if (!loaded) return null;
  if (!creds) return <SetupForm onDone={setCreds} onBack={onBack} />;
  return (
    <StationRunner
      creds={creds}
      onBack={onBack}
      onRemoved={() => {
        saveStation(null);
        saveZone(null);
        setCreds(null);
      }}
    />
  );
}

function StationRunner({
  creds,
  onBack,
  onRemoved,
}: {
  creds: StationCreds;
  onBack?: () => void;
  onRemoved: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null); // 추론 입력용
  const snapRef = useRef<HTMLCanvasElement | null>(null); // 사진 인코딩용(축소)
  const stageRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const trackerRef = useRef(new ViolationTracker());
  const liveRef = useRef(new Map<string, LiveSession>());
  const requestIdRef = useRef(0);
  const inflightRef = useRef(false);
  const queueRef = useRef<Array<{ label: string; score: number; image: string }>>([]);
  const lastSnapshotRef = useRef(0);

  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [modelReady, setModelReady] = useState(false);
  const [wsState, setWsState] = useState<WsState>("off");
  const [error, setError] = useState<string | null>(null);
  const [saver, setSaver] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clothingOn, setClothingOn] = useState(false);
  const [zone, setZone] = useState<DangerZone | null>(null);
  const [zoneEditing, setZoneEditing] = useState(false);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0, vw: 0, vh: 0 });
  const [lastReport, setLastReport] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // 콜백 안에서 최신 값을 읽기 위한 ref
  const clothingRef = useRef(false);
  const zoneRef = useRef<DangerZone | null>(null);
  clothingRef.current = clothingOn;
  zoneRef.current = zone;

  useEffect(() => {
    setZone(loadZone());
    try {
      setClothingOn(localStorage.getItem("argus-clothing-v1") === "1");
    } catch {
      /* 무시 */
    }
  }, []);

  // 1초 시계 — 구역 남은 시간 표시 + 자동 만료
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (zoneRef.current && !isZoneActive(zoneRef.current)) {
        setZone(null);
        saveZone(null);
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ── 사진 캡처 (추론 프레임 + 감지 박스 + 구역을 그려 축소) ──
  const capture = useCallback(
    (maxW: number, quality: number, boxes: DetectionBox[] = []): string | null => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return null;
      const c = (snapRef.current ??= document.createElement("canvas"));
      const scale = Math.min(1, maxW / video.videoWidth);
      c.width = Math.round(video.videoWidth * scale);
      c.height = Math.round(video.videoHeight * scale);
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, c.width, c.height);

      const z = zoneRef.current;
      if (isZoneActive(z)) {
        ctx.beginPath();
        z.points.forEach((p, i) => (i ? ctx.lineTo(p.x * c.width, p.y * c.height) : ctx.moveTo(p.x * c.width, p.y * c.height)));
        ctx.closePath();
        ctx.fillStyle = "rgba(245,101,101,0.22)";
        ctx.fill();
        ctx.strokeStyle = "#f56565";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.lineWidth = Math.max(2, Math.round(c.width / 240));
      for (const b of boxes) {
        ctx.strokeStyle = LABEL_COLOR[b.label] ?? "#fff";
        ctx.strokeRect(b.x * scale, b.y * scale, b.width * scale, b.height * scale);
      }
      return c.toDataURL("image/jpeg", quality).replace("data:image/jpeg;base64,", "");
    },
    []
  );

  // ── 서버 보고 (실패하면 큐에 보관했다가 재연결 시 재전송) ──
  const sendReport = useCallback(
    async (label: string, score: number, image: string) => {
      try {
        const r = await postEvent(creds, label, score, image);
        lastSnapshotRef.current = Date.now();
        setLastReport(`${new Date().toLocaleTimeString("ko-KR")} ${label}${r.alerted ? "" : " (알림 억제)"}`);
      } catch (e) {
        if (queueRef.current.length < 10) queueRef.current.push({ label, score, image });
        console.warn("[station] 보고 실패, 큐에 보관", e);
      }
    },
    [creds]
  );

  const flushQueue = useCallback(() => {
    const items = queueRef.current.splice(0);
    items.forEach((it) => void sendReport(it.label, it.score, it.image));
  }, [sendReport]);

  // ── 추론 결과 처리 ──
  const handleResult = useCallback(
    (data: {
      boxes: DetectionBox[];
      clothing: ClothingAttributes | null;
      persons?: Array<{ x: number; y: number; width: number; height: number }>;
    }) => {
      const present = new Map<string, number>(); // label → 최고 점수
      for (const b of data.boxes) present.set(b.label, Math.max(present.get(b.label) ?? 0, b.score));

      if (clothingRef.current && data.clothing) {
        const c = data.clothing;
        if (!c.harnessWorn) present.set("no_harness", c.harnessScore);
        if (c.sleeve === "short_sleeve") present.set("short_sleeve", c.sleeveScore);
        if (c.pants === "short_pants") present.set("short_pants", c.pantsScore);
      }

      const video = videoRef.current;
      const z = zoneRef.current;
      if (isZoneActive(z) && data.persons && video?.videoWidth) {
        const frame = { width: video.videoWidth, height: video.videoHeight };
        if (data.persons.some((p) => personInZone(p, frame, z))) present.set("zone_intrusion", 1);
      }

      const due = trackerRef.current.update(present.keys(), Date.now());
      if (due.length === 0) return;
      const image = capture(640, 0.6, data.boxes);
      if (!image) return;
      for (const label of due) void sendReport(label, present.get(label) ?? 0, image);
    },
    [capture, sendReport]
  );

  // ── 추론 워커 ──
  const handleResultRef = useRef(handleResult);
  handleResultRef.current = handleResult;
  useEffect(() => {
    const worker = new Worker(new URL("../workers/detection.worker.ts", import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (event) => {
      const d = event.data;
      if (d.type === "ready") setModelReady(true);
      else if (d.type === "error") {
        inflightRef.current = false;
        setError(d.message);
      } else if (d.type === "result") {
        inflightRef.current = false;
        handleResultRef.current(d);
      }
    };
    worker.postMessage({ type: "init", modelPath: process.env.NEXT_PUBLIC_MODEL_PATH ?? "/models/detector.onnx" });
    return () => worker.terminate();
  }, []);

  // ── 카메라 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play();
        }
        setError(null);
      } catch {
        if (!cancelled) setError("카메라에 접근할 수 없습니다. 브라우저에서 카메라 권한을 허용해 주세요.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [facingMode]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  // ── 추론 루프 ──
  useEffect(() => {
    if (!modelReady) return;
    const t = setInterval(() => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const worker = workerRef.current;
      if (!video || !canvas || !worker || video.readyState < 2 || inflightRef.current) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      inflightRef.current = true;
      worker.postMessage({
        type: "infer",
        requestId: ++requestIdRef.current,
        imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
        options: { clothing: clothingRef.current, persons: isZoneActive(zoneRef.current) },
      });
    }, INFER_INTERVAL_MS);
    return () => clearInterval(t);
  }, [modelReady]);

  // ── 화면 켜짐 유지 ──
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const request = async () => {
      try {
        lock = (await navigator.wakeLock?.request("screen")) ?? null;
      } catch {
        /* 지원하지 않거나 거부됨 */
      }
    };
    void request();
    const onVis = () => document.visibilityState === "visible" && void request();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release();
    };
  }, []);

  // ── 현재 모습 사진 주기 갱신 (위반이 없어도 분할화면에 최근 모습이 보이도록) ──
  useEffect(() => {
    if (!modelReady) return;
    const push = () => {
      if (Date.now() - lastSnapshotRef.current < SNAPSHOT_REFRESH_MS) return;
      const image = capture(480, 0.5);
      if (!image) return;
      lastSnapshotRef.current = Date.now();
      void putSnapshot(creds, image).catch(() => undefined);
    };
    const first = setTimeout(push, 2500);
    const t = setInterval(push, 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [modelReady, creds, capture]);

  // ── 라이브 보기 중계 ──
  const sendWs = useCallback((obj: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  const stopLive = useCallback((conn: string) => {
    const s = liveRef.current.get(conn);
    if (!s) return;
    if (s.timer) clearInterval(s.timer);
    s.pc?.close();
    liveRef.current.delete(conn);
  }, []);

  const startLive = useCallback(
    (conn: string, rtc: boolean) => {
      if (liveRef.current.size >= MAX_LIVE_SESSIONS) {
        sendWs({ t: "live-error", to: conn, message: "동시 시청 한도에 도달했습니다." });
        return;
      }
      stopLive(conn);
      const session: LiveSession = {};
      liveRef.current.set(conn, session);

      // 1) 즉시 보이는 사진 프레임(1초 간격) — WebRTC 연결이 되면 모니터링 쪽이 rtc-up으로 중단시킨다
      const sendFrame = () => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 400_000) return;
        const data = capture(480, 0.5);
        if (data) ws.send(JSON.stringify({ t: "frame", to: conn, data }));
      };
      sendFrame();
      session.timer = setInterval(sendFrame, 1000);

      // 2) 실시간 영상(WebRTC) 시도 — 5G 통신망에서 막히면 위의 사진 방식이 그대로 유지된다
      const stream = streamRef.current;
      if (rtc && stream && typeof RTCPeerConnection !== "undefined") {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        session.pc = pc;
        stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
        pc.onicecandidate = (e) => e.candidate && sendWs({ t: "ice", to: conn, candidate: e.candidate.toJSON() });
        void pc
          .createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => sendWs({ t: "offer", to: conn, sdp: pc.localDescription?.sdp }))
          .catch(() => undefined);
      }
    },
    [capture, sendWs, stopLive]
  );

  const handleWsMessage = useCallback(
    (raw: string) => {
      let msg: { t?: string; from?: string; sdp?: string; candidate?: RTCIceCandidateInit; rtc?: boolean };
      try {
        msg = JSON.parse(raw);
      } catch {
        return; // "pong" 등
      }
      // 모니터링 화면에서 이 스테이션(또는 사이트)이 삭제됨 — 등록 정보를 지우고 처음 상태로
      if (msg.t === "removed") {
        onRemovedRef.current();
        return;
      }
      const conn = msg.from;
      if (!conn) return;
      if (msg.t === "live-start") startLive(conn, !!msg.rtc);
      else if (msg.t === "live-stop" || msg.t === "viewer-gone") stopLive(conn);
      else if (msg.t === "answer" && msg.sdp) {
        void liveRef.current.get(conn)?.pc?.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch(() => undefined);
      } else if (msg.t === "ice" && msg.candidate) {
        void liveRef.current.get(conn)?.pc?.addIceCandidate(msg.candidate).catch(() => undefined);
      } else if (msg.t === "rtc-up") {
        const s = liveRef.current.get(conn);
        if (s?.timer) {
          clearInterval(s.timer);
          s.timer = undefined;
        }
      }
    },
    [startLive, stopLive]
  );
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;
  const handleWsMessageRef = useRef(handleWsMessage);
  handleWsMessageRef.current = handleWsMessage;

  // ── 서버 WebSocket (접속 = 온라인 표시) ──
  useEffect(() => {
    let closed = false;
    let retry = 0;
    let ping: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(stationSocketUrl(creds));
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setWsState("on");
        ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), PING_MS);
        flushQueue();
      };
      ws.onmessage = (e) => typeof e.data === "string" && handleWsMessageRef.current(e.data);
      ws.onclose = (ev) => {
        if (ping) clearInterval(ping);
        setWsState("off");
        liveRef.current.forEach((_, k) => stopLive(k));
        if (closed) return;
        if (ev.code === 1008 || ev.code === 4401) return;
        timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
      };
      ws.onerror = () => ws.close();
    };
    connect();

    const kick = () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN && wsRef.current?.readyState !== WebSocket.CONNECTING) {
        if (timer) clearTimeout(timer);
        connect();
      }
    };
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", kick);
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ping) clearInterval(ping);
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", kick);
      wsRef.current?.close();
    };
  }, [creds, flushQueue, stopLive]);

  // ── 영상이 화면에 차지하는 영역 (구역 그리기 좌표 변환용) ──
  const measure = useCallback(() => {
    const stage = stageRef.current;
    const v = videoRef.current;
    if (!stage || !v) return;
    setStageSize({ w: stage.clientWidth, h: stage.clientHeight, vw: v.videoWidth, vh: v.videoHeight });
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const rect = fitRect(stageSize.w, stageSize.h, stageSize.vw, stageSize.vh);
  const zoneActive = isZoneActive(zone, now);
  const zoneMin = zoneActive ? Math.max(0, Math.ceil((zone.expiresAt - now) / 60000)) : 0;

  const toggleClothing = () => {
    const next = !clothingOn;
    setClothingOn(next);
    try {
      localStorage.setItem("argus-clothing-v1", next ? "1" : "0");
    } catch {
      /* 무시 */
    }
  };

  const unregister = async () => {
    if (!confirm("이 기기를 스테이션에서 해제할까요? 모니터링 화면에서도 사라집니다.")) return;
    try {
      await removeStation(creds);
    } catch {
      /* 서버에 이미 없거나 오프라인이어도 로컬 해제는 진행 */
    }
    onRemoved();
  };

  return (
    <div className="st-root">
      <div className="st-stage" ref={stageRef}>
        <video ref={videoRef} className="st-video" playsInline muted onLoadedMetadata={measure} />
        {zoneActive && (
          <svg
            className="st-zone"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
          >
            <polygon
              points={zone.points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="rgba(245,101,101,0.22)"
              stroke="#f56565"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        {zoneEditing && (
          <ZoneEditor
            rect={rect}
            onCancel={() => setZoneEditing(false)}
            onApply={(points, hours) => {
              const z = { points, expiresAt: Date.now() + hours * 3600_000 };
              setZone(z);
              saveZone(z);
              trackerRef.current.reset();
              setZoneEditing(false);
            }}
          />
        )}
      </div>
      <canvas ref={canvasRef} style={{ display: "none" }} />

      <div className="st-top">
        <span className={`st-dot ${wsState === "on" ? "on" : "off"}`} />
        <span>
          {creds.siteName} / {creds.name}
        </span>
        <span className="st-muted">
          {wsState === "on" ? "서버 연결됨" : "서버 연결 끊김 — 재시도 중"} · {modelReady ? "감시 중" : "모델 로딩…"}
        </span>
      </div>
      {error && <div className="st-banner">{error}</div>}
      {lastReport && <div className="st-last">최근 보고: {lastReport}</div>}

      {!zoneEditing && (
        <div className="st-bar">
          <button className="st-btn" onClick={() => setZoneEditing(true)}>
            {zoneActive ? `위험구역 ON (${zoneMin}분)` : "위험구역"}
          </button>
          {zoneActive && (
            <button
              className="st-btn"
              onClick={() => {
                setZone(null);
                saveZone(null);
              }}
            >
              구역 해제
            </button>
          )}
          <button className="st-btn" onClick={() => setSaver(true)}>
            절전 화면
          </button>
          <button className="st-btn" onClick={() => setMenuOpen((v) => !v)}>
            설정
          </button>
        </div>
      )}

      {menuOpen && !zoneEditing && (
        <div className="st-menu">
          <label className="st-check">
            <input type="checkbox" checked={clothingOn} onChange={toggleClothing} />
            복장 규정 감지 (긴팔·긴바지·안전그네) — 오탐이 늘 수 있어 기본 꺼짐
          </label>
          <button
            className="st-btn"
            onClick={() => {
              const image = capture(640, 0.6);
              if (image) void sendReport("no_helmet", 0.9, image);
              setMenuOpen(false);
            }}
          >
            테스트 알림 보내기 (안전모 미착용)
          </button>
          <button className="st-btn" onClick={() => setFacingMode((m) => (m === "environment" ? "user" : "environment"))}>
            카메라 전환 ({facingMode === "environment" ? "후면" : "전면"})
          </button>
          <button className="st-btn" onClick={onBack}>
            첫 화면으로 (감시는 중지됩니다)
          </button>
          <button className="st-btn st-danger" onClick={unregister}>
            스테이션 등록 해제
          </button>
        </div>
      )}

      {saver && (
        <div className="st-saver" onClick={() => setSaver(false)}>
          <span className={`st-dot ${wsState === "on" ? "on" : "off"}`} />
          <p>
            {creds.name} · {modelReady ? "감시 중" : "준비 중"}
          </p>
          <p className="st-muted">화면을 누르면 돌아갑니다</p>
        </div>
      )}
    </div>
  );
}

function ZoneEditor({
  rect,
  onCancel,
  onApply,
}: {
  rect: { x: number; y: number; w: number; h: number };
  onCancel: () => void;
  onApply: (points: Point[], hours: number) => void;
}) {
  const [points, setPoints] = useState<Point[]>([]);
  const [hours, setHours] = useState(2);

  const add = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    setPoints((p) => (p.length >= 8 ? p : [...p, { x, y }]));
  };

  return (
    <>
      <div className="st-zone-hit" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} onClick={add}>
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="st-zone-svg">
          {points.length >= 3 && (
            <polygon
              points={points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="rgba(245,101,101,0.25)"
              stroke="#f56565"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {points.length === 2 && (
            <line
              x1={points[0].x}
              y1={points[0].y}
              x2={points[1].x}
              y2={points[1].y}
              stroke="#f56565"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {points.map((p, i) => (
          <span key={i} className="st-pt" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} />
        ))}
      </div>
      <div className="st-zone-panel">
        <p>
          {points.length < 3
            ? `화면을 눌러 구역 꼭짓점을 찍으세요 (${points.length}/최대 8, 최소 3개)`
            : "구역이 지정되었습니다. 유지 시간을 고르고 적용하세요."}
        </p>
        <div className="st-row">
          {ZONE_HOURS.map((h) => (
            <button key={h} className={`st-btn ${hours === h ? "st-primary" : ""}`} onClick={() => setHours(h)}>
              {h}시간
            </button>
          ))}
        </div>
        <div className="st-row">
          <button className="st-btn" onClick={() => setPoints((p) => p.slice(0, -1))} disabled={!points.length}>
            되돌리기
          </button>
          <button className="st-btn" onClick={() => setPoints([])} disabled={!points.length}>
            지우기
          </button>
          <button className="st-btn" onClick={onCancel}>
            취소
          </button>
          <button className="st-btn st-primary" disabled={points.length < 3} onClick={() => onApply(points, hours)}>
            적용
          </button>
        </div>
      </div>
    </>
  );
}
