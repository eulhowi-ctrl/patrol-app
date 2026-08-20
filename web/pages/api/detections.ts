import type { NextApiRequest, NextApiResponse } from "next";

// Cloudflare Pages Functions는 서버리스 실행 환경이라 로컬 디스크에 파일을
// 쓸 수 없다 (예전 fs.appendFile 방식은 여기서 실패/에러의 원인이 됨).
// 로그 저장 자체가 필요 없다는 결정에 따라, 이 핸들러는 파일을 쓰지 않고
// 수신 확인(200 OK)만 응답한다.
//
// 이 200 응답이 중요한 이유:
// - web/src/lib/sync.ts의 bulkSync()는 res.ok(200번대)를 받아야만
//   markSynced()를 호출해 IndexedDB 레코드를 synced: true로 표시한다.
// - web/src/lib/db.ts의 cleanupOldSyncedRecords()는 synced === true인
//   레코드만 3일 후 삭제 대상으로 본다.
// - 즉, 여기서 200을 안 주면 synced가 영원히 false로 남아 폰(IndexedDB)에
//   스냅샷 데이터가 계속 쌓이게 된다.

export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" }, // 스냅샷 Base64 포함 요청 대비
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

  // 로그 저장 없음 — 수신 확인만 응답. 클라이언트가 이 200 응답을 받아야
  // 해당 레코드들을 synced: true로 표시하고, 이후 3일 정리 로직이
  // 정상적으로 지울 수 있게 된다.
  return res.status(200).json({ received: detections.length });
}
