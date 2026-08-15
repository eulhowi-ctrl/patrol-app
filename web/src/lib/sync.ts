import { getUnsyncedDetections, markSynced, type DetectionRecord } from "./db";

const SYNC_ENDPOINT =
  process.env.NEXT_PUBLIC_SYNC_ENDPOINT ?? "/api/detections";

export interface SyncResult {
  attempted: number;
  succeeded: number;
}

/**
 * IndexedDB에 쌓인 미동기화 감지 기록을 서버로 일괄 전송한다.
 * 네트워크가 없거나 서버가 실패를 응답하면 레코드는 synced=false로 남아
 * 다음 온라인 전환 시 다시 시도된다.
 */
export async function bulkSync(): Promise<SyncResult> {
  const pending = await getUnsyncedDetections();
  if (pending.length === 0) {
    return { attempted: 0, succeeded: 0 };
  }

  try {
    const res = await fetch(SYNC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ detections: pending }),
    });

    if (!res.ok) {
      throw new Error(`서버 응답 실패: ${res.status}`);
    }

    const ids = pending
      .map((r) => r.id)
      .filter((id): id is number => typeof id === "number");
    await markSynced(ids);
    return { attempted: pending.length, succeeded: ids.length };
  } catch (err) {
    console.warn("[sync] bulkSync 실패, 다음 온라인 전환 시 재시도됩니다.", err);
    return { attempted: pending.length, succeeded: 0 };
  }
}

let listenersRegistered = false;

/**
 * navigator.onLine 이벤트와 Background Sync API(지원 브라우저)를 모두 활용해
 * 네트워크 복구 시 bulkSync를 트리거한다.
 */
export function registerSyncListeners(onSyncResult?: (r: SyncResult) => void): void {
  if (listenersRegistered || typeof window === "undefined") return;
  listenersRegistered = true;

  const runSync = async () => {
    const result = await bulkSync();
    onSyncResult?.(result);
  };

  window.addEventListener("online", runSync);

  if (navigator.onLine) {
    void runSync();
  }

  if ("serviceWorker" in navigator && "SyncManager" in window) {
    navigator.serviceWorker.ready
      .then((registration) => {
        return (registration as ServiceWorkerRegistration & {
          sync: { register(tag: string): Promise<void> };
        }).sync.register("patrol-app-bulk-sync");
      })
      .catch((err) => {
        console.warn("[sync] Background Sync 등록 실패 (폴백: online 이벤트만 사용)", err);
      });
  }
}

export type { DetectionRecord };
