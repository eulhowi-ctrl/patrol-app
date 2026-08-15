// onnxruntime-web은 이미 압축/번들된 산출물이라 Next.js/webpack이 다시 파싱하면
// 내부 라이선스 주석 경계에서 문법 오류가 난다. 그래서 번들에 절대 포함시키지 않고,
// public/ort/ 에 정적 파일로 복사한 뒤 Web Worker에서 importScripts()로 로드한다.
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "node_modules", "onnxruntime-web", "dist");
const DEST_DIR = path.join(__dirname, "..", "public", "ort");

const FILES_TO_COPY = [
  "ort.wasm.min.js",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
];

fs.mkdirSync(DEST_DIR, { recursive: true });

for (const file of FILES_TO_COPY) {
  const src = path.join(SRC_DIR, file);
  const dest = path.join(DEST_DIR, file);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-onnx-assets] 건너뜀 (파일 없음): ${file}`);
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log(`[copy-onnx-assets] 복사됨: ${file}`);
}
