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
  output: 'standalone',
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    return config;
  },
};

module.exports = withPWA(nextConfig);
