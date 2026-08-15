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

  useEffect(() => {
    if (!modelReady) return;

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

      {error && <div className="error-banner">{error}</div>}

      <video ref={videoRef} muted playsInline className="camera-video" />
      <canvas ref={canvasRef} className="camera-canvas" />

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
