import type { NextApiRequest, NextApiResponse } from "next";
import webpush from "web-push";
import { getSubscriptions, removeSubscription } from "../../../src/lib/server/pushStore";
import { HIGH_PRIORITY_LABELS, LABEL_KO, type DetectionLabel } from "../../../src/lib/labels";

// 알림 내용을 클라이언트가 자유 문구로 보내게 하면(이 프로젝트엔 로그인/인증이 없어서)
// 아무나 임의의 텍스트로 알림을 스팸처럼 보낼 수 있다. 그래서 본문은 서버가 직접
// labels.ts의 한글 표시명으로 조립하고, 클라이언트는 사전에 정의된 고위험 라벨만 보낼 수 있다.
function isHighPriorityLabel(value: unknown): value is DetectionLabel {
  return typeof value === "string" && (HIGH_PRIORITY_LABELS as string[]).includes(value);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST만 허용됩니다." });
  }

  const { label } = (req.body ?? {}) as { label?: unknown };
  if (!isHighPriorityLabel(label)) {
    return res.status(400).json({ error: "허용되지 않은 알림 유형입니다." });
  }

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    console.warn("[push] VAPID 키가 설정되지 않아 외부 알림을 보낼 수 없습니다 (web/.env 확인).");
    return res.status(200).json({ sent: 0, skipped: "vapid_not_configured" });
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);

  const subscriptions = await getSubscriptions();
  const payload = JSON.stringify({
    title: `⚠️ ARGUS 고위험 감지: ${LABEL_KO[label]}`,
    body: "현장 카메라에서 즉시 확인이 필요한 상황이 감지되었습니다.",
    tag: "argus-high-priority",
  });

  let sent = 0;
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
        sent += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // 구독이 만료/취소됨 (사용자가 알림 권한을 껐거나 기기를 바꿈) — 저장소에서 정리
          await removeSubscription(sub.endpoint);
        } else {
          console.error("[push] 알림 전송 실패:", err);
        }
      }
    })
  );

  return res.status(200).json({ sent, total: subscriptions.length });
}
