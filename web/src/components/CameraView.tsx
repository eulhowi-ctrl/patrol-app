import { useCallback, useEffect, useRef, useState } from "react";
import { saveDetection, countPending } from "../lib/db";
import { bulkSync, registerSyncListeners } from "../lib/sync";
import { HIGH_PRIORITY_LABELS, type DetectionBox } from "../lib/labels";

const INFER_INTERVAL_MS = 500; // 저사양 기기 배터리/발열 고려, 초당 2회 추론

export default function CameraView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  const [modelReady, setModelReady] = useState(false);
  const [boxes, setBoxes] = useState<DetectionBox[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isTestMode, setIsTestMode] = useState(false); // 실제 모드, 에러 시 자동 테스트 모드

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
        handleDetectionResult(data.boxes);
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

  const handleDetectionResult = useCallback(async (detected: DetectionBox[]) => {
    const highPriority = detected.filter((b) =>
      HIGH_PRIORITY_LABELS.includes(b.label)
    );
    if (detected.length === 0) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const snapshotBase64 = canvas.toDataURL("image/jpeg", 0.6);

    await saveDetection({
      capturedAt: new Date().toISOString(),
      labels: detected,
      snapshotBase64,
    });
    refreshPendingCount();

    if (navigator.onLine) {
      void bulkSync().then(refreshPendingCount);
    }

    if (highPriority.length > 0) {
      console.warn("[ALERT] 고위험 이벤트 감지:", highPriority);
    }
  }, [refreshPendingCount]);

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
      </div>

      <ul className="detection-list">
        {boxes.map((b, idx) => (
          <li key={idx}>
            {b.label} ({(b.score * 100).toFixed(1)}%)
          </li>
        ))}
      </ul>
    </div>
  );
}
