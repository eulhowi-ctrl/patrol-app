import { openDB, type IDBPDatabase } from "idb";
import type { PartMeta } from "./recPolicy";

// 스테이션 폰 안의 녹화 저장소 (IndexedDB: 브라우저 내장 저장소).
// 서버로는 절대 올리지 않는다. 모니터링이 요청할 때만 조각을 읽어 중계로 보낸다.
//  - parts:  조각 정보 {start, end, mime, bytes, done}
//  - chunks: 조각을 이루는 몇 초 단위 데이터 [start, idx] → Blob

const DB_NAME = "argus-rec";
const PARTS = "parts";
const CHUNKS = "chunks";

interface ChunkRow {
  start: number;
  idx: number;
  blob: Blob;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(PARTS, { keyPath: "start" });
        db.createObjectStore(CHUNKS, { keyPath: ["start", "idx"] });
      },
    });
  }
  return dbPromise;
}

// 녹화 중 몇 초마다 호출: 데이터 조각을 쌓고 조각 정보(끝 시각·크기)를 갱신
export async function appendChunk(start: number, idx: number, blob: Blob, mime: string, at: number) {
  const db = await getDb();
  const tx = db.transaction([PARTS, CHUNKS], "readwrite");
  const parts = tx.objectStore(PARTS);
  const prev = (await parts.get(start)) as PartMeta | undefined;
  await tx.objectStore(CHUNKS).put({ start, idx, blob } satisfies ChunkRow);
  await parts.put({
    start,
    end: Math.max(prev?.end ?? start, at),
    mime,
    bytes: (prev?.bytes ?? 0) + blob.size,
    done: false,
  } satisfies PartMeta);
  await tx.done;
}

export async function finishPart(start: number) {
  const db = await getDb();
  const p = (await db.get(PARTS, start)) as PartMeta | undefined;
  if (p && !p.done) await db.put(PARTS, { ...p, done: true });
}

// 앱이 갑자기 꺼졌던 조각은 저장된 데까지를 완성본으로 본다
export async function closeDangling() {
  const db = await getDb();
  const all = (await db.getAll(PARTS)) as PartMeta[];
  await Promise.all(all.filter((p) => !p.done).map((p) => db.put(PARTS, { ...p, done: true })));
}

export async function listParts(): Promise<PartMeta[]> {
  const db = await getDb();
  return ((await db.getAll(PARTS)) as PartMeta[]).sort((a, b) => a.start - b.start);
}

export async function getPart(start: number): Promise<PartMeta | undefined> {
  const db = await getDb();
  return (await db.get(PARTS, start)) as PartMeta | undefined;
}

// 조각 전체를 하나의 Blob으로 (순서대로 이어 붙이면 그대로 재생 가능한 파일)
export async function readPart(start: number): Promise<Blob | null> {
  const db = await getDb();
  const p = (await db.get(PARTS, start)) as PartMeta | undefined;
  if (!p) return null;
  const rows = (await db.getAll(CHUNKS, IDBKeyRange.bound([start, 0], [start, Infinity]))) as ChunkRow[];
  rows.sort((a, b) => a.idx - b.idx);
  return new Blob(
    rows.map((r) => r.blob),
    { type: p.mime }
  );
}

export async function deleteParts(starts: number[]) {
  if (starts.length === 0) return;
  const db = await getDb();
  const tx = db.transaction([PARTS, CHUNKS], "readwrite");
  for (const s of starts) {
    await tx.objectStore(PARTS).delete(s);
    await tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([s, 0], [s, Infinity]));
  }
  await tx.done;
}

export async function clearAll() {
  const db = await getDb();
  const tx = db.transaction([PARTS, CHUNKS], "readwrite");
  await tx.objectStore(PARTS).clear();
  await tx.objectStore(CHUNKS).clear();
  await tx.done;
}
