import type { NextApiRequest, NextApiResponse } from "next";
import { promises as fs } from "fs";
import path from "path";

// 최소 구현: 수신한 감지 로그를 JSONL 파일에 append한다.
// 운영 단계에서는 Postgres/S3 등 영구 저장소로 교체한다.
const DATA_DIR = path.join(process.cwd(), "data");
const LOG_FILE = path.join(DATA_DIR, "detections.log.jsonl");

export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" }, // 스냅샷 Base64 포함 대비
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST만 허용됩니다." });
  }

  const { detections } = req.body ?? {};
  if (!Array.isArray(detections) || detections.length === 0) {
    return res.status(400).json({ error: "detections 배열이 필요합니다." });
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

  const lines = detections
    .map((d) => JSON.stringify({ ...d, receivedAt: new Date().toISOString() }))
    .join("\n");
  await fs.appendFile(LOG_FILE, lines + "\n", "utf-8");

  return res.status(200).json({ received: detections.length });
}
