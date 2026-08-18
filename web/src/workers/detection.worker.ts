/// <reference lib="webworker" />
import { DETECTION_LABELS, type DetectionBox } from "../lib/labels";

// 메인 스레드를 막지 않도록 추론을 전용 Web Worker에서 수행한다.
declare const self: DedicatedWorkerGlobalScope;

// onnxruntime-web은 이미 번들/압축된 산출물이라 webpack이 이 파일 자체를 다시 파싱하면
// 내부 라이선스 주석 경계에서 문법 오류가 발생한다(실제로 next build에서 재현/확인됨).
// 그래서 ESM import 대신 public/ort/에 정적 복사된 파일을 importScripts로 불러온다.
// (web/scripts/copy-onnx-assets.js, web/package.json의 postinstall 참고)
import type { InferenceSession, Tensor } from "onnxruntime-web";
declare const ort: typeof import("onnxruntime-web");
importScripts("/ort/ort.wasm.min.js");

const MODEL_INPUT_SIZE = 640; // YOLOv8/v10 Nano 기본 입력 해상도
const SCORE_THRESHOLD = 0.45;
const IOU_THRESHOLD = 0.45;

let session: InferenceSession | null = null;

type WorkerRequest =
  | { type: "init"; modelPath: string }
  | { type: "infer"; requestId: number; imageData: ImageData };

type WorkerResponse =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "result"; requestId: number; boxes: DetectionBox[] };

async function initSession(modelPath: string): Promise<void> {
  ort.env.wasm.numThreads = 1; // 1 vCPU 기기 다수 대응 (스레드 과다 생성 방지)
  ort.env.wasm.wasmPaths = "/ort/"; // copy-onnx-assets.js가 복사한 wasm 바이너리 위치

  try {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  } catch (err) {
    console.warn("[worker] 모델 로드 실패, 더미 모드로 동작합니다:", err);
    // 모델 없이도 UI 테스트 가능하도록 더미 session 설정
    session = {} as InferenceSession;
  }
}

function letterboxToTensor(imageData: ImageData): {
  tensor: Tensor;
  scaleX: number;
  scaleY: number;
} {
  const { width, height, data } = imageData;
  const scaleX = width / MODEL_INPUT_SIZE;
  const scaleY = height / MODEL_INPUT_SIZE;

  // 최근접 다운샘플링으로 640x640 CHW Float32 텐서 생성 (NCHW, RGB, 0~1 정규화)
  const floatData = new Float32Array(3 * MODEL_INPUT_SIZE * MODEL_INPUT_SIZE);
  const planeSize = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;

  for (let y = 0; y < MODEL_INPUT_SIZE; y++) {
    const srcY = Math.min(height - 1, Math.floor(y * scaleY));
    for (let x = 0; x < MODEL_INPUT_SIZE; x++) {
      const srcX = Math.min(width - 1, Math.floor(x * scaleX));
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = y * MODEL_INPUT_SIZE + x;

      floatData[dstIdx] = data[srcIdx] / 255; // R
      floatData[planeSize + dstIdx] = data[srcIdx + 1] / 255; // G
      floatData[2 * planeSize + dstIdx] = data[srcIdx + 2] / 255; // B
    }
  }

  const tensor = new ort.Tensor("float32", floatData, [
    1,
    3,
    MODEL_INPUT_SIZE,
    MODEL_INPUT_SIZE,
  ]);

  return { tensor, scaleX, scaleY };
}

function iou(a: DetectionBox, b: DetectionBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const unionArea = a.width * a.height + b.width * b.height - interArea;
  return unionArea <= 0 ? 0 : interArea / unionArea;
}

function nonMaxSuppression(boxes: DetectionBox[]): DetectionBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: DetectionBox[] = [];

  for (const candidate of sorted) {
    const overlaps = kept.some(
      (k) => k.label === candidate.label && iou(k, candidate) > IOU_THRESHOLD
    );
    if (!overlaps) kept.push(candidate);
  }
  return kept;
}

/**
 * YOLOv8/v10 스타일 출력 [1, 4+numClasses, numAnchors] 을 박스 목록으로 변환한다.
 * 실제 export된 모델의 출력 shape이 다르면 이 함수만 맞춰 수정하면 된다.
 */
function postprocess(
  output: Tensor,
  scaleX: number,
  scaleY: number
): DetectionBox[] {
  const data = output.data as Float32Array;
  const [, channels, numAnchors] = output.dims as number[];
  const numClasses = DETECTION_LABELS.length;

  if (channels !== 4 + numClasses) {
    console.warn(
      `[worker] 예상치 못한 출력 채널 수(${channels}). labels.ts와 모델 export 설정을 확인하세요.`
    );
  }

  const boxes: DetectionBox[] = [];

  for (let i = 0; i < numAnchors; i++) {
    let bestClass = -1;
    let bestScore = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * numAnchors + i];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }

    if (bestScore < SCORE_THRESHOLD || bestClass === -1) continue;

    const cx = data[0 * numAnchors + i] * scaleX;
    const cy = data[1 * numAnchors + i] * scaleY;
    const w = data[2 * numAnchors + i] * scaleX;
    const h = data[3 * numAnchors + i] * scaleY;

    boxes.push({
      label: DETECTION_LABELS[bestClass],
      score: bestScore,
      x: cx - w / 2,
      y: cy - h / 2,
      width: w,
      height: h,
    });
  }

  return nonMaxSuppression(boxes);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === "init") {
    try {
      await initSession(msg.modelPath);
      const response: WorkerResponse = { type: "ready" };
      self.postMessage(response);
    } catch (err) {
      const response: WorkerResponse = {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
    return;
  }

  if (msg.type === "infer") {
    if (!session) {
      self.postMessage({
        type: "error",
        message: "모델이 초기화되지 않았습니다. init 메시지를 먼저 보내세요.",
      } satisfies WorkerResponse);
      return;
    }

    try {
      // 더미 모드 (모델 없을 때)
      if (!session.inputNames) {
        self.postMessage({
          type: "result",
          requestId: msg.requestId,
          boxes: [],
        } satisfies WorkerResponse);
        return;
      }

      const { tensor, scaleX, scaleY } = letterboxToTensor(msg.imageData);
      const inputName = session.inputNames[0];
      const outputs = await session.run({ [inputName]: tensor });
      const outputName = session.outputNames[0];
      const boxes = postprocess(outputs[outputName], scaleX, scaleY);

      self.postMessage({
        type: "result",
        requestId: msg.requestId,
        boxes,
      } satisfies WorkerResponse);
    } catch (err) {
      self.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      } satisfies WorkerResponse);
    }
  }
};

export {};
