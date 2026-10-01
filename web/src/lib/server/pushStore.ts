// 웹 푸시 구독 저장소 — API 라우트(Node.js 런타임)에서만 import할 것.
// web/data/ 디렉토리는 .gitignore에 이미 포함된 "백엔드 로컬 데이터" 영역을 그대로 사용한다.
// 현재는 단일 인스턴스(Oracle Cloud/Docker) 배포를 전제로 한 파일 기반 저장소이며,
// Cloudflare Pages 정적 배포(build:cloudflare)에서는 pages/api 전체가 빌드에서 제외되므로
// 이 파일도 함께 빠진다 — 그 배포 경로에서는 푸시 알림 기능 자체가 비활성화된다.
import { promises as fs } from "fs";
import path from "path";

export interface StoredPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "push-subscriptions.json");

async function readAll(): Promise<StoredPushSubscription[]> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeAll(subs: StoredPushSubscription[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(subs, null, 2), "utf-8");
}

export async function getSubscriptions(): Promise<StoredPushSubscription[]> {
  return readAll();
}

export async function addSubscription(sub: StoredPushSubscription): Promise<void> {
  const subs = await readAll();
  if (!subs.some((s) => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    await writeAll(subs);
  }
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const subs = await readAll();
  const next = subs.filter((s) => s.endpoint !== endpoint);
  if (next.length !== subs.length) {
    await writeAll(next);
  }
}
