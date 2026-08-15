import { openDB, type IDBPDatabase } from "idb";
import type { DetectionBox } from "./labels";

export interface DetectionRecord {
  id?: number;
  capturedAt: string; // ISO timestamp
  labels: DetectionBox[];
  snapshotBase64: string;
  synced: boolean;
}

const DB_NAME = "patrol-app-db";
const DB_VERSION = 1;
const STORE_NAME = "detections";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        // synced는 boolean이라 IndexedDB 키로 사용할 수 없으므로 인덱싱하지 않고
        // getAll() 후 메모리에서 필터링한다 (기기 로컬 큐 규모상 성능 문제 없음).
        store.createIndex("capturedAt", "capturedAt");
      },
    });
  }
  return dbPromise;
}

export async function saveDetection(
  record: Omit<DetectionRecord, "id" | "synced">
): Promise<number> {
  const db = await getDb();
  const id = await db.add(STORE_NAME, { ...record, synced: false });
  return id as number;
}

export async function getUnsyncedDetections(): Promise<DetectionRecord[]> {
  const db = await getDb();
  const all = (await db.getAll(STORE_NAME)) as DetectionRecord[];
  return all.filter((r) => r.synced === false);
}

export async function markSynced(ids: number[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  await Promise.all(
    ids.map(async (id) => {
      const record = (await tx.store.get(id)) as DetectionRecord | undefined;
      if (record) {
        record.synced = true;
        await tx.store.put(record);
      }
    })
  );
  await tx.done;
}

export async function countPending(): Promise<number> {
  const pending = await getUnsyncedDetections();
  return pending.length;
}
