import { useCallback, useEffect, useRef, useState } from "react";
import {
  saveDetection,
  countPending,
  getTodayDetections,
  getAllDetections,
  type DetectionRecord,
} from "../lib/db";
import { bulkSync, registerSyncListeners } from "../lib/sync";
import {
  HIGH_PRIORITY_LABELS,
  LABEL_KO,
  clothingViolations,
  type ClothingAttributes,
  type DetectionBox,
} from "../lib/labels";

const INFER_INTERVAL_MS = 500; // 저사양 기기 배터리/발열 고려, 초당 2회 추론

interface SessionSummary {
  durationMin: number;
  total: number;
  byLabel: Record<string, number>;
}

function boxesSignature(boxes: DetectionBox[], clothing: ClothingAttributes | null): string {
  const boxSig = boxes.map((b) => b.label).sort().join(",");
  const clothingSig = clothingViolations(clothing).sort().join(",");
  return `${boxSig}|${clothingSig}`;
}

export default function CameraView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const lastSignatureRef = useRef<string>("");

  const [modelReady, setModelReady] = useState(false);
  const [boxes, setBoxes] = useState<DetectionBox[]>([]);
  const [clothing, setClothing] = useState<ClothingAttributes | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isTestMode, setIsTestMode] = useState(false); // 실제 모드, 에러 시 자동 테스트 모드

  const [bannerDismissed, setBannerDismissed] = useState(false);

  const [patrolActive, setPatrolActive] = useState(false);
  const [patrolStartedAt, setPatrolStartedAt] = useState<string | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);

  const [showLog, setShowLog] = useState(false);
  const [todayRecords, setTodayRecords] = useState<DetectionRecord[]>([]);

  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");

  const refreshPendingCount = useCallback(() => {
    void countPending().then(setPendingCount);
  }, []);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    refreshPendingCount();
    registerSyncListeners(() => {
      void bulkSync().then(refreshPendingCount);
    });

    const worker = new Worker(
      new URL("../workers/detection.worker.ts", import.meta.url)
    );
    workerRef.current = worker;

    worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === "ready") {
        setModelReady(true);
      } else if (data.type === "error") {
        setError(data.message);
      } else if (data.type === "result") {
        setBoxes(data.boxes);
        setClothing(data.clothing);
        handleDetectionResult(data.boxes, data.clothing);
      }
    };

    const modelPath =
      process.env.NEXT_PUBLIC_MODEL_PATH ?? "/models/detector.onnx";
    worker.postMessage({ type: "init", modelPath });

    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      worker.terminate();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (err) {
        setError(
          "카메라 접근이 거부되었습니다. 브라우저 설정에서 카메라 권한을 허용해주세요."
        );
        console.error(err);
      }
    }
    void startCamera();
  }, []);

  // 테스트 모드: 더미 감지 결과 표시
  useEffect(() => {
    if (!isTestMode || !videoRef.current) return;

    const testBoxes: DetectionBox[] = [
      { label: "no_helmet", score: 0.92, x: 50, y: 100, width: 120, height: 150 },
      { label: "fire_smoke", score: 0.85, x: 250, y: 80, width: 100, height: 140 },
      { label: "no_vest", score: 0.78, x: 150, y: 200, width: 110, height: 160 },
    ];
    setBoxes(testBoxes);
    setModelReady(true);
  }, [isTestMode]);

  useEffect(() => {
    if (!modelReady || isTestMode) return;

    const interval = setInterval(() => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const worker = workerRef.current;
      if (!video || !canvas || !worker || video.readyState < 2) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const requestId = ++requestIdRef.current;
      worker.postMessage({ type: "infer", requestId, imageData });
    }, INFER_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [modelReady]);

  // 새로운(다른) 위반 조합이 감지되면 배너를 다시 띄운다 — 같은 위반이 계속
  // 이어지는 동안 0.5초마다 배너가 깜빡이며 재등장하는 걸 방지하기 위함.
  useEffect(() => {
    const sig = boxesSignature(boxes, clothing);
    if (sig !== lastSignatureRef.current) {
      lastSignatureRef.current = sig;
      setBannerDismissed(false);
    }
  }, [boxes, clothing]);

  const handleDetectionResult = useCallback(async (
    detected: DetectionBox[],
    clothingResult: ClothingAttributes | null
  ) => {
    const highPriority = detected.filter((b) =>
      HIGH_PRIORITY_LABELS.includes(b.label)
    );
    const cViolations = clothingViolations(clothingResult);
    if (detected.length === 0 && cViolations.length === 0) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const snapshotBase64 = canvas.toDataURL("image/jpeg", 0.6);

    await saveDetection({
      capturedAt: new Date().toISOString(),
      labels: detected,
      snapshotBase64,
      clothingViolations: cViolations.length > 0 ? cViolations : undefined,
    });
    refreshPendingCount();

    if (navigator.onLine) {
      void bulkSync().then(refreshPendingCount);
    }

    if (highPriority.length > 0) {
      console.warn("[ALERT] 고위험 이벤트 감지:", highPriority);
    }
  }, [refreshPendingCount]);

  // ------------------------------------------------------------------
  // 순찰 세션 시작/종료
  // ------------------------------------------------------------------
  const startPatrol = useCallback(() => {
    setPatrolActive(true);
    setPatrolStartedAt(new Date().toISOString());
    setSessionSummary(null);
  }, []);

  const endPatrol = useCallback(async () => {
    if (!patrolStartedAt) return;
    const all = await getAllDetections();
    const inSession = all.filter((r) => r.capturedAt >= patrolStartedAt);
    const byLabel: Record<string, number> = {};
    for (const r of inSession) {
      for (const b of r.labels) {
        const ko = LABEL_KO[b.label] ?? b.label;
        byLabel[ko] = (byLabel[ko] ?? 0) + 1;
      }
      for (const v of r.clothingViolations ?? []) {
        byLabel[v] = (byLabel[v] ?? 0) + 1;
      }
    }
    const durationMin = Math.max(
      1,
      Math.round((Date.now() - new Date(patrolStartedAt).getTime()) / 60000)
    );
    setSessionSummary({ durationMin, total: inSession.length, byLabel });
    setPatrolActive(false);
    setPatrolStartedAt(null);
  }, [patrolStartedAt]);

  // ------------------------------------------------------------------
  // 오늘의 기록 패널
  // ------------------------------------------------------------------
  const toggleLog = useCallback(() => {
    setShowLog((prev) => {
      const next = !prev;
      if (next) {
        void getTodayDetections().then(setTodayRecords);
      }
      return next;
    });
  }, []);

  // ------------------------------------------------------------------
  // 수동 캡처 (AI가 놓쳤을 때 사람이 직접 기록)
  // ------------------------------------------------------------------
  const openNote = useCallback(() => setNoteOpen(true), []);

  const saveManualCapture = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const snapshotBase64 = canvas.toDataURL("image/jpeg", 0.7);
    await saveDetection({
      capturedAt: new Date().toISOString(),
      labels: [],
      snapshotBase64,
      manual: true,
      note: noteText.trim() || undefined,
    });
    refreshPendingCount();
    if (navigator.onLine) {
      void bulkSync().then(refreshPendingCount);
    }
    setNoteText("");
    setNoteOpen(false);
  }, [noteText, refreshPendingCount]);

  const highPriorityNow = boxes.filter((b) => HIGH_PRIORITY_LABELS.includes(b.label));
  const cViolationsNow = clothingViolations(clothing);
  const hasAnyIssue = boxes.length > 0 || cViolationsNow.length > 0;
  const showAlertBanner = hasAnyIssue && !bannerDismissed;
  const showAllClearBanner = modelReady && !isTestMode && !hasAnyIssue;
  const alertText = [
    ...boxes.map((b) => LABEL_KO[b.label] ?? b.label),
    ...cViolationsNow,
  ].join(", ");

  return (
    <div className="camera-view">
      <div className="status-bar">
        <span>{isOnline ? "🟢 온라인" : "🔴 오프라인 (로컬 저장 중)"}</span>
        <span>{modelReady ? "모델 준비 완료" : "모델 로딩 중..."}</span>
        <span>대기 중 동기화: {pendingCount}건</span>
      </div>

      {isTestMode && (
        <div style={{
          background: "#2a5a3a",
          color: "#7fff9f",
          padding: "8px 12px",
          borderRadius: "8px",
          marginBottom: "8px",
          fontSize: "12px",
          textAlign: "center",
          fontWeight: "bold"
        }}>
          🧪 테스트 모드 (더미 감지 결과) |
          <button onClick={() => setIsTestMode(false)} style={{
            marginLeft: "8px",
            padding: "2px 8px",
            background: "#4a7a5a",
            color: "#7fff9f",
            border: "1px solid #7fff9f",
            borderRadius: "4px",
            cursor: "pointer"
          }}>
            실제 모드로 전환
          </button>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {/* 실시간 판정 배너 — 이상 없음(초록) / 위반 감지(주황·빨강 + 확인 버튼) */}
      {showAllClearBanner && (
        <div className="verdict-banner verdict-ok">✅ 이상 없음</div>
      )}
      {showAlertBanner && (
        <div className={`verdict-banner ${highPriorityNow.length > 0 ? "verdict-danger" : "verdict-warning"}`}>
          <span>⚠️ {alertText} 감지됨</span>
          <button className="verdict-ack" onClick={() => setBannerDismissed(true)}>
            확인
          </button>
        </div>
      )}

      {sessionSummary && (
        <div className="verdict-banner verdict-summary">
          <span>
            순찰 {sessionSummary.durationMin}분 · 이상 {sessionSummary.total}건 발견
            {Object.entries(sessionSummary.byLabel).map(([ko, n]) => ` · ${ko} ${n}`).join("")}
          </span>
          <button className="verdict-ack" onClick={() => setSessionSummary(null)}>
            확인
          </button>
        </div>
      )}

      <div style={{ position: "relative", width: "100%" }}>
        <video ref={videoRef} muted playsInline className="camera-video" />
        <canvas ref={canvasRef} className="camera-canvas" />

        {/* 감지 박스 오버레이 */}
        <svg
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            borderRadius: "8px",
            pointerEvents: "none"
          }}
        >
          {boxes.map((box, idx) => (
            <g key={idx}>
              <rect
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.height}
                fill="none"
                stroke="#ff4444"
                strokeWidth="2"
              />
              <rect
                x={box.x}
                y={Math.max(0, box.y - 20)}
                width={Math.max(80, box.label.length * 6)}
                height="18"
                fill="#ff4444"
              />
              <text
                x={box.x + 2}
                y={Math.max(12, box.y - 4)}
                fill="white"
                fontSize="11"
                fontFamily="Arial"
                fontWeight="bold"
              >
                {box.label} {(box.score * 100).toFixed(0)}%
              </text>
            </g>
          ))}
        </svg>

        {/* 수동 캡처 버튼 (플로팅) */}
        <button className="manual-capture-btn" onClick={openNote} title="수동으로 지금 상황 기록">
          📷
        </button>
      </div>

      <ul className="detection-list">
        {boxes.map((b, idx) => (
          <li key={idx}>
            {LABEL_KO[b.label] ?? b.label} ({(b.score * 100).toFixed(1)}%)
          </li>
        ))}
        {cViolationsNow.map((v) => (
          <li key={v}>{v}</li>
        ))}
      </ul>

      {/* 순찰 시작/종료 버튼 */}
      <button
        className={`patrol-btn ${patrolActive ? "patrol-btn-stop" : "patrol-btn-start"}`}
        onClick={patrolActive ? () => void endPatrol() : startPatrol}
      >
        {patrolActive ? "■ 순찰 종료" : "▶ 순찰 시작"}
      </button>

      {/* 수동 캡처 메모 입력 */}
      {noteOpen && (
        <div className="note-overlay">
          <div className="note-panel">
            <div className="note-title">지금 상황 기록</div>
            <textarea
              className="note-textarea"
              placeholder="메모 (선택사항)"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={3}
            />
            <div className="note-actions">
              <button className="note-cancel" onClick={() => { setNoteOpen(false); setNoteText(""); }}>
                취소
              </button>
              <button className="note-save" onClick={() => void saveManualCapture()}>
                저장
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 오늘의 기록 — 왼쪽 화면 탭 형식 */}
      <button
        className={`log-tab ${showLog ? "log-tab-open" : ""}`}
        onClick={toggleLog}
        aria-label="오늘의 기록"
      >
        📋 오늘의 기록
      </button>
      {showLog && (
        <>
          <div className="log-backdrop" onClick={toggleLog} />
          <div className="log-drawer">
            <div className="log-drawer-header">
              <span>오늘의 기록 ({todayRecords.length}건)</span>
              <button className="log-close" onClick={toggleLog}>✕</button>
            </div>
            <div className="log-drawer-list">
              {todayRecords.length === 0 && (
                <div className="log-empty">오늘 기록된 항목이 없습니다.</div>
              )}
              {todayRecords.map((r) => (
                <div key={r.id} className="log-item">
                  {r.snapshotBase64 && (
                    <img src={r.snapshotBase64} alt="" className="log-thumb" />
                  )}
                  <div className="log-item-body">
                    <div className="log-item-time">
                      {new Date(r.capturedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
                      {r.manual && " · 수동 기록"}
                      {!r.synced && " · 동기화 대기"}
                    </div>
                    <div className="log-item-labels">
                      {[
                        ...r.labels.map((b) => LABEL_KO[b.label] ?? b.label),
                        ...(r.clothingViolations ?? []),
                      ].join(", ") || r.note || "(내용 없음)"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
