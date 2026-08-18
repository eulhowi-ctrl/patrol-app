const withPWA = require("next-pwa")({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development",
  // ONNX 모델(.onnx)과 wasm 런타임 파일은 오프라인에서도 추론이 가능하도록 캐시한다.
  runtimeCaching: [
    {
      urlPattern: /\/models\/.*\.onnx$/,
      handler: "CacheFirst",
      options: { cacheName: "onnx-models", expiration: { maxEntries: 4 } },
    },
    {
      urlPattern: /\.wasm$/,
      handler: "CacheFirst",
      options: { cacheName: "onnxruntime-wasm", expiration: { maxEntries: 8 } },
    },
  ],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    return config;
  },
  // Cloudflare Pages는 정적 export로 배포한다 (API 라우트는 로컬 fs를 쓰는
  // Node.js 서버가 필요해 Cloudflare의 서버리스 모델과 안 맞음 — 별도
  // 백엔드로 분리 예정, scripts/build-cloudflare.js가 pages/api를 빌드에서
  // 잠시 빼고 빌드한다). Oracle Cloud/Docker 배포(next start)는 그대로 SSR.
  ...(process.env.CF_PAGES_BUILD === "1" ? { output: "export" } : {}),
};

module.exports = withPWA(nextConfig);
