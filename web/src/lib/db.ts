import { openDB, type IDBPDatabase } from "idb";
import type { DetectionBox } from "./labels";
import { kstDateKey } from "./kstDate";

export interface DetectionRecord {
  id?: number;
  capturedAt: string; // ISO timestamp
  labels: DetectionBox[];
  snapshotBase64: string;
  synced: boolean;
  manual?: boolean; // 사람이 수동 캡처한 기록(AI 미탐지 보완용)인지 여부
  note?: string; // 수동 캡처 시 남긴 메모
  clothingViolations?: string[]; // 2단계 분류기(안전그네/소매/바지) 위반 항목
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

// "오늘의 기록" 패널 + 순찰 종료 요약용 — capturedAt 내림차순(최신 먼저).
export async function getAllDetections(): Promise<DetectionRecord[]> {
  const db = await getDb();
  const all = (await db.getAll(STORE_NAME)) as DetectionRecord[];
  return all.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

export async function getTodayDetections(): Promise<DetectionRecord[]> {
  const all = await getAllDetections();
  const todayKey = kstDateKey();
  return all.filter((r) => kstDateKey(r.capturedAt) === todayKey);
}

/** 동기화 완료된 3일 이상 오래된 레코드 자동 삭제 (IndexedDB 용량 관리) */
export async function cleanupOldSyncedRecords(): Promise<number> {
  const db = await getDb();
  const all = (await db.getAll(STORE_NAME)) as DetectionRecord[];
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  let deleteCount = 0;
  const tx = db.transaction(STORE_NAME, "readwrite");

  for (const record of all) {
    const recordDate = new Date(record.capturedAt);
    // 동기화 완료 + 3일 이상 된 기록만 삭제
    if (record.synced && recordDate < threeDaysAgo) {
      await tx.store.delete(record.id!);
      deleteCount++;
    }
  }
  await tx.done;
  return deleteCount;
}
