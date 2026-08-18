/// <reference lib="webworker" />
import { DETECTION_LABELS, type ClothingAttributes, type DetectionBox } from "../lib/labels";

// 메인 스레드를 막지 않도록 추론을 전용 Web Worker에서 수행한다.
declare const self: DedicatedWorkerGlobalScope;

// onnxruntime-web은 이미 번들/압축된 산출물이라 webpack이 이 파일 자체를 다시 파싱하면
// 내부 라이선스 주석 경계에서 문법 오류가 발생한다(실제로 next build에서 재현/확인됨).
// 그래서 ESM import 대신 public/ort/에 정적 복사된 파일을 importScripts로 불러온다.
// (web/scripts/copy-onnx-assets.js, web/package.json의 postinstall 참고)
import type { InferenceSession, Tensor } from "onnxruntime-web";
declare const ort: typeof import("onnxruntime-web");
importScripts("/ort/ort.wasm.min.js");

const MODEL_INPUT_SIZE = 256; // training/train.py --imgsz 256 (YOLOv8 Nano 기본 640이 아님)
const SCORE_THRESHOLD = 0.45;
const IOU_THRESHOLD = 0.45;

// person.onnx는 COCO 사전학습 YOLOv8n(80클래스, person=class 0) 그대로 사용 —
// 2단계 분류기(harness/sleeve/pants) 입력을 person 크롭으로 만들기 위한 용도.
// 우리 6클래스 탐지기(detector.onnx)에는 person 클래스가 없어서 별도로 둠.
const PERSON_CLASS_INDEX = 0;
const PERSON_SCORE_THRESHOLD = 0.5;
const PERSON_CROP_PADDING = 0.15; // 사람 박스 상하좌우로 15% 여유 (분류기 학습 크롭과 유사하게)

// 2단계 보조 분류기(harness/sleeve/pants) 입력 크기 — training/train_classifier.py 기본값
const CLS_INPUT_SIZE = 160;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

let session: InferenceSession | null = null;
let personSession: InferenceSession | null = null;
let harnessSession: InferenceSession | null = null;
let sleeveSession: InferenceSession | null = null;
let pantsSession: InferenceSession | null = null;

type WorkerRequest =
  | { type: "init"; modelPath: string }
  | { type: "infer"; requestId: number; imageData: ImageData };

type WorkerResponse =
  | { type: "ready" }
  | { type: "error"; message: string }
  | {
      type: "result";
      requestId: number;
      boxes: DetectionBox[];
      clothing: ClothingAttributes | null;
    };

interface PlainImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

interface SimpleBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

async function loadClassifier(path: string): Promise<InferenceSession | null> {
  try {
    return await ort.InferenceSession.create(path, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  } catch (err) {
    // 2단계 분류기/사람 탐지기는 선택 기능 — 못 불러와도 1단계 탐지는 그대로 동작해야 한다.
    console.warn(`[worker] 보조 모델 로드 실패(${path}), 해당 판정 생략:`, err);
    return null;
  }
}

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

  const modelDir = modelPath.slice(0, modelPath.lastIndexOf("/") + 1) || "/models/";
  [personSession, harnessSession, sleeveSession, pantsSession] = await Promise.all([
    loadClassifier(`${modelDir}person.onnx`),
    loadClassifier(`${modelDir}harness.onnx`),
    loadClassifier(`${modelDir}sleeve.onnx`),
    loadClassifier(`${modelDir}pants.onnx`),
  ]);
}

function letterboxToTensor(
  image: PlainImage,
  targetSize: number
): { tensor: Tensor; scaleX: number; scaleY: number } {
  const { width, height, data } = image;
  const scaleX = width / targetSize;
  const scaleY = height / targetSize;

  // 최근접 다운샘플링으로 targetSize x targetSize CHW Float32 텐서 생성 (NCHW, RGB, 0~1 정규화)
  const floatData = new Float32Array(3 * targetSize * targetSize);
  const planeSize = targetSize * targetSize;

  for (let y = 0; y < targetSize; y++) {
    const srcY = Math.min(height - 1, Math.floor(y * scaleY));
    for (let x = 0; x < targetSize; x++) {
      const srcX = Math.min(width - 1, Math.floor(x * scaleX));
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = y * targetSize + x;

      floatData[dstIdx] = data[srcIdx] / 255; // R
      floatData[planeSize + dstIdx] = data[srcIdx + 1] / 255; // G
      floatData[2 * planeSize + dstIdx] = data[srcIdx + 2] / 255; // B
    }
  }

  const tensor = new ort.Tensor("float32", floatData, [1, 3, targetSize, targetSize]);
  return { tensor, scaleX, scaleY };
}

/** imageData에서 박스 영역만 잘라낸 새 픽셀버퍼를 만든다 (2단계 분류기 입력용). */
function cropImage(image: PlainImage, box: SimpleBox): PlainImage {
  const { width, height, data } = image;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  const cw = Math.max(1, x1 - x0);
  const ch = Math.max(1, y1 - y0);

  const cropped = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const srcOffset = ((y0 + y) * width + x0) * 4;
    const dstOffset = y * cw * 4;
    cropped.set(data.subarray(srcOffset, srcOffset + cw * 4), dstOffset);
  }
  return { width: cw, height: ch, data: cropped };
}

function padBox(box: SimpleBox, frameWidth: number, frameHeight: number): SimpleBox {
  const padX = box.width * PERSON_CROP_PADDING;
  const padY = box.height * PERSON_CROP_PADDING;
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  const width = Math.min(frameWidth - x, box.width + padX * 2);
  const height = Math.min(frameHeight - y, box.height + padY * 2);
  return { x, y, width, height, score: box.score };
}

/** 2단계 분류기 입력 — 0~1 정규화 후 ImageNet mean/std로 표준화(학습 시 transforms와 동일). */
function toClassifierTensor(image: PlainImage): Tensor {
  const { tensor } = letterboxToTensor(image, CLS_INPUT_SIZE);
  const arr = tensor.data as Float32Array;
  const planeSize = CLS_INPUT_SIZE * CLS_INPUT_SIZE;
  for (let c = 0; c < 3; c++) {
    const mean = IMAGENET_MEAN[c];
    const std = IMAGENET_STD[c];
    for (let i = 0; i < planeSize; i++) {
      const idx = c * planeSize + i;
      arr[idx] = (arr[idx] - mean) / std;
    }
  }
  return tensor;
}

function softmax2(logits: Float32Array): [number, number] {
  const m = Math.max(logits[0], logits[1]);
  const e0 = Math.exp(logits[0] - m);
  const e1 = Math.exp(logits[1] - m);
  const sum = e0 + e1;
  return [e0 / sum, e1 / sum];
}

async function runClassifier(
  cls: InferenceSession | null,
  tensor: Tensor
): Promise<[number, number] | null> {
  if (!cls || !cls.inputNames) return null;
  try {
    const inputName = cls.inputNames[0];
    const outputs = await cls.run({ [inputName]: tensor });
    const outputName = cls.outputNames[0];
    return softmax2(outputs[outputName].data as Float32Array);
  } catch (err) {
    console.warn("[worker] 보조 분류기 추론 실패:", err);
    return null;
  }
}

/** person.onnx(COCO YOLOv8n) 출력에서 person(class 0) 박스만 추출 + NMS, 가장 큰 박스 하나 선택. */
function detectLargestPerson(
  output: Tensor,
  scaleX: number,
  scaleY: number
): SimpleBox | null {
  const data = output.data as Float32Array;
  const [, , numAnchors] = output.dims as number[];

  const candidates: SimpleBox[] = [];
  for (let i = 0; i < numAnchors; i++) {
    const score = data[(4 + PERSON_CLASS_INDEX) * numAnchors + i];
    if (score < PERSON_SCORE_THRESHOLD) continue;

    const cx = data[0 * numAnchors + i] * scaleX;
    const cy = data[1 * numAnchors + i] * scaleY;
    const w = data[2 * numAnchors + i] * scaleX;
    const h = data[3 * numAnchors + i] * scaleY;
    candidates.push({ x: cx - w / 2, y: cy - h / 2, width: w, height: h, score });
  }
  if (candidates.length === 0) return null;

  // 여러 사람이 있으면 화면에서 가장 크게(가까이) 잡힌 사람 하나만 판정한다
  // (다인원 개별 판정은 추후 개선 여지 — labels.ts ClothingAttributes 주석 참고).
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  return candidates[0];
}

async function classifyClothing(image: PlainImage): Promise<ClothingAttributes | null> {
  if (!harnessSession && !sleeveSession && !pantsSession) return null;
  if (!personSession || !personSession.inputNames) return null;

  const { tensor: personTensor, scaleX, scaleY } = letterboxToTensor(image, MODEL_INPUT_SIZE);
  const inputName = personSession.inputNames[0];
  const outputs = await personSession.run({ [inputName]: personTensor });
  const outputName = personSession.outputNames[0];
  const personBox = detectLargestPerson(outputs[outputName], scaleX, scaleY);
  if (!personBox) return null; // 사람이 안 보이면 옷차림 판정 자체를 생략 (배경만 잘못 판정하는 것 방지)

  const crop = cropImage(image, padBox(personBox, image.width, image.height));
  const tensor = toClassifierTensor(crop);

  const [harnessProbs, sleeveProbs, pantsProbs] = await Promise.all([
    runClassifier(harnessSession, tensor),
    runClassifier(sleeveSession, tensor),
    runClassifier(pantsSession, tensor),
  ]);
  if (!harnessProbs && !sleeveProbs && !pantsProbs) return null;

  // 인덱스 규약(training/build_harness_crops.py, build_clothing_crops.py):
  // harness 0=미착용 1=착용, sleeve 0=반팔 1=긴팔, pants 0=반바지 1=긴바지
  return {
    harnessWorn: (harnessProbs?.[1] ?? 1) >= 0.5,
    harnessScore: harnessProbs ? Math.max(...harnessProbs) : 0,
    sleeve: (sleeveProbs?.[1] ?? 1) >= 0.5 ? "long_sleeve" : "short_sleeve",
    sleeveScore: sleeveProbs ? Math.max(...sleeveProbs) : 0,
    pants: (pantsProbs?.[1] ?? 1) >= 0.5 ? "long_pants" : "short_pants",
    pantsScore: pantsProbs ? Math.max(...pantsProbs) : 0,
  };
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
          clothing: null,
        } satisfies WorkerResponse);
        return;
      }

      const { tensor, scaleX, scaleY } = letterboxToTensor(msg.imageData, MODEL_INPUT_SIZE);
      const inputName = session.inputNames[0];
      const outputs = await session.run({ [inputName]: tensor });
      const outputName = session.outputNames[0];
      const boxes = postprocess(outputs[outputName], scaleX, scaleY);
      const clothing = await classifyClothing(msg.imageData);

      self.postMessage({
        type: "result",
        requestId: msg.requestId,
        boxes,
        clothing,
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
